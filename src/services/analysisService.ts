import { prisma } from '@/prisma';
import WplaceAPI from 'wplace-api';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

/**
 * Runs a background scan of the canvas to identify who painted each correct pixel of the drawing.
 * Uses a throttled queue to call wplace.live's getPixel API (1 request per 200ms).
 */
export async function runContributorAnalysis(drawingId: number): Promise<void> {
  // First, verify that there isn't an analysis already running for this drawing
  const drawing = await prisma.drawing.findUnique({
    where: { id: drawingId },
  });

  if (!drawing) {
    console.error(`[Analysis] Drawing ${drawingId} not found.`);
    return;
  }

  if (drawing.analysisInProgress) {
    console.log(`[Analysis] Analysis already in progress for drawing ${drawingId}.`);
    return;
  }

  // Set status to in progress
  await prisma.drawing.update({
    where: { id: drawingId },
    data: {
      analysisInProgress: true,
      analysisProgress: 0,
      analysisTotal: 0,
    },
  });

  const wplaceApi = new WplaceAPI();
  const contributorCounts = new Map<string, number>();

  try {
    const imageUrl = drawing.imageUrl;
    let tplBuffer: Buffer;

    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      // Remote URL (Vercel Blob / Production)
      console.log(`[Analysis] Fetching template image from remote URL: ${imageUrl}`);
      const res = await fetch(imageUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch template image from URL ${imageUrl}: ${res.statusText}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      tplBuffer = Buffer.from(arrayBuffer);
    } else {
      // Local development fallback
      const filepath = path.join(process.cwd(), 'public', imageUrl);
      if (!fs.existsSync(filepath)) {
        throw new Error(`Template image file not found at ${filepath}`);
      }
      tplBuffer = fs.readFileSync(filepath);
    }
    const metadata = await sharp(tplBuffer).metadata();
    const tplW = metadata.width || 0;
    const tplH = metadata.height || 0;

    const rawInfo = await sharp(tplBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    const tplData = rawInfo.data;

    const drawAbsX = drawing.chunkX * 1000 + drawing.offsetX;
    const drawAbsY = drawing.chunkY * 1000 + drawing.offsetY;

    // Group pixel comparisons by wplace.live tiles so we download each tile at most once
    // Key: "tileX,tileY", Value: list of relative pixels to check
    const tilesMap = new Map<string, { tileX: number; tileY: number; pixels: { dx: number; dy: number; absX: number; absY: number }[] }>();

    for (let dy = 0; dy < tplH; dy++) {
      for (let dx = 0; dx < tplW; dx++) {
        const ti = 4 * (dy * tplW + dx);
        const alpha = tplData[ti + 3];

        // Skip transparent template pixels
        if (alpha !== undefined && alpha < 128) {
          continue;
        }

        const absX = drawAbsX + dx;
        const absY = drawAbsY + dy;

        const tileX = Math.floor(absX / 1000);
        const tileY = Math.floor(absY / 1000);
        const key = `${tileX},${tileY}`;

        if (!tilesMap.has(key)) {
          tilesMap.set(key, { tileX, tileY, pixels: [] });
        }

        tilesMap.get(key)!.pixels.push({ dx, dy, absX, absY });
      }
    }

    const correctPixelsToQuery: { tileX: number; tileY: number; pxOnTile: number; pyOnTile: number }[] = [];

    // Download each tile and compare pixels with the template
    for (const [key, tileInfo] of tilesMap.entries()) {
      const { tileX, tileY, pixels } = tileInfo;
      console.log(`[Analysis] Downloading tile [${tileX}, ${tileY}] containing ${pixels.length} pixels to check`);
      
      const tileRes = await wplaceApi.getTile(tileX, tileY);
      if (!tileRes.ok) {
        console.error(`[Analysis] Failed to download tile [${tileX}, ${tileY}]:`, tileRes.error);
        continue;
      }

      const png = tileRes.value;
      if (!png) {
        console.log(`[Analysis] Tile [${tileX}, ${tileY}] is empty (404)`);
        continue;
      }

      // Assert tile dimensions are 1000x1000
      const tileW = png.width;
      const tileH = png.height;

      for (const p of pixels) {
        const pxOnTile = p.absX - tileX * 1000;
        const pyOnTile = p.absY - tileY * 1000;

        if (pxOnTile < 0 || pyOnTile < 0 || pxOnTile >= tileW || pyOnTile >= tileH) {
          continue;
        }

        const gi = 4 * (pyOnTile * tileW + pxOnTile);
        const tileR = png.data[gi];
        const tileG = png.data[gi + 1];
        const tileB = png.data[gi + 2];
        const tileA = png.data[gi + 3];

        // Skip if tile pixel is fully transparent
        if (tileA === 0) {
          continue;
        }

        const ti = 4 * (p.dy * tplW + p.dx);
        const tplR = tplData[ti];
        const tplG = tplData[ti + 1];
        const tplB = tplData[ti + 2];

        // Compare color values
        if (tplR === tileR && tplG === tileG && tplB === tileB) {
          correctPixelsToQuery.push({
            tileX,
            tileY,
            pxOnTile,
            pyOnTile
          });
        }
      }
    }

    const totalCorrect = correctPixelsToQuery.length;
    console.log(`[Analysis] Found ${totalCorrect} correct pixels to query on wplace.live API`);

    // Update database with total pixels to query
    await prisma.drawing.update({
      where: { id: drawingId },
      data: {
        analysisTotal: totalCorrect,
        analysisProgress: 0,
      },
    });

    // Query wplace.live API for each correct pixel with a 200ms delay between calls
    for (let i = 0; i < totalCorrect; i++) {
      const p = correctPixelsToQuery[i]!;

      try {
        const pixelRes = await wplaceApi.getPixel(p.tileX, p.tileY, p.pxOnTile, p.pyOnTile);
        if (pixelRes.ok) {
          const pixelData = pixelRes.value;
          const username = pixelData.paintedBy?.name || 'Anonyme';
          contributorCounts.set(username, (contributorCounts.get(username) || 0) + 1);
        } else {
          console.error(`[Analysis] Error fetching pixel metadata:`, pixelRes.error);
          contributorCounts.set('Anonyme', (contributorCounts.get('Anonyme') || 0) + 1);
        }
      } catch (err) {
        console.error(`[Analysis] Unexpected error fetching pixel:`, err);
        contributorCounts.set('Anonyme', (contributorCounts.get('Anonyme') || 0) + 1);
      }

      // Update progress in the database every 5 pixels or at the end
      if ((i + 1) % 5 === 0 || i + 1 === totalCorrect) {
        await prisma.drawing.update({
          where: { id: drawingId },
          data: {
            analysisProgress: i + 1,
          },
        });
      }

      // 200ms throttle delay to avoid IP bans/rate limits
      if (i < totalCorrect - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    // Save final contributor records to database
    console.log(`[Analysis] Finished scan. Saving contributors to DB:`, Object.fromEntries(contributorCounts));
    await prisma.$transaction([
      prisma.contributor.deleteMany({
        where: { drawingId },
      }),
      prisma.contributor.createMany({
        data: Array.from(contributorCounts.entries()).map(([username, pixelCount]) => ({
          drawingId,
          username,
          pixelCount,
        })),
      }),
    ]);

  } catch (error) {
    console.error(`[Analysis] Critical error during background contributor analysis for drawing ${drawingId}:`, error);
  } finally {
    // Reset status to idle and store the timestamp
    await prisma.drawing.update({
      where: { id: drawingId },
      data: {
        analysisInProgress: false,
        analysisLastRun: new Date(),
      },
    });
    console.log(`[Analysis] Background contributor analysis finalized for drawing ${drawingId}`);
  }
}
