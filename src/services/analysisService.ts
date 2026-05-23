import { prisma } from '@/prisma';
import WplaceAPI from '@/wplace-api/main';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { get } from '@vercel/blob';

const rgbToHex = (r: number, g: number, b: number): string => {
  const toHex = (c: number) => c.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
};

/**
 * Fetches a template image from local disk, standard remote URL, or a private Vercel Blob URL.
 */
async function fetchTemplateImage(imageUrl: string): Promise<Buffer> {
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    if (imageUrl.includes('blob.vercel-storage.com')) {
      console.log(`[Analysis] Fetching private template image from Vercel Blob: ${imageUrl}`);
      const result = await get(imageUrl, { access: 'private' });
      if (!result) {
        throw new Error(`Failed to fetch private template image from Vercel Blob ${imageUrl}`);
      }
      const arrayBuffer = await new Response(result.stream).arrayBuffer();
      return Buffer.from(arrayBuffer);
    } else {
      console.log(`[Analysis] Fetching template image from remote URL: ${imageUrl}`);
      const res = await fetch(imageUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch template image from URL ${imageUrl}: ${res.statusText}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
  } else {
    // Local development fallback
    const filepath = path.join(process.cwd(), 'public', imageUrl);
    if (!fs.existsSync(filepath)) {
      throw new Error(`Template image file not found at ${filepath}`);
    }
    return fs.readFileSync(filepath);
  }
}

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
  const contributorColors = new Map<string, Map<string, number>>();

  try {
    const imageUrl = drawing.imageUrl;
    const tplBuffer = await fetchTemplateImage(imageUrl);
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

    const correctPixelsToQuery: { tileX: number; tileY: number; pxOnTile: number; pyOnTile: number; hexColor: string }[] = [];

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
            pyOnTile,
            hexColor: rgbToHex(tplR, tplG, tplB)
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

    const BATCH_SIZE = 5;

    // Query wplace.live API for each correct pixel in batches of 5 in parallel
    for (let i = 0; i < totalCorrect; i += BATCH_SIZE) {
      const batch = correctPixelsToQuery.slice(i, i + BATCH_SIZE);

      // Execute the batch queries concurrently
      const results = await Promise.all(
        batch.map(async (p) => {
          let username = 'Anonyme';
          try {
            const pixelRes = await wplaceApi.getPixel(p.tileX, p.tileY, p.pxOnTile, p.pyOnTile);
            if (pixelRes.ok) {
              const pixelData = pixelRes.value;
              username = pixelData.paintedBy?.name || 'Anonyme';
            } else {
              console.error(`[Analysis] Error fetching pixel metadata:`, pixelRes.error);
            }
          } catch (err) {
            console.error(`[Analysis] Unexpected error fetching pixel:`, err);
          }
          return { username, hexColor: p.hexColor };
        })
      );

      // Accumulate the batch results
      for (const res of results) {
        contributorCounts.set(res.username, (contributorCounts.get(res.username) || 0) + 1);

        if (!contributorColors.has(res.username)) {
          contributorColors.set(res.username, new Map<string, number>());
        }
        const userColors = contributorColors.get(res.username)!;
        userColors.set(res.hexColor, (userColors.get(res.hexColor) || 0) + 1);
      }

      // Update progress in the database at the end of the batch
      const progressCount = Math.min(i + batch.length, totalCorrect);
      await prisma.drawing.update({
        where: { id: drawingId },
        data: {
          analysisProgress: progressCount,
        },
      });

      // 200ms throttle delay between batches to avoid IP bans/rate limits
      if (i + BATCH_SIZE < totalCorrect) {
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
        data: Array.from(contributorCounts.entries()).map(([username, pixelCount]) => {
          const userColorsMap = contributorColors.get(username);
          const colorsObj = userColorsMap ? Object.fromEntries(userColorsMap.entries()) : {};
          return {
            drawingId,
            username,
            pixelCount,
            colors: colorsObj,
          };
        }),
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

/**
 * Automatiquement synchronise la progression d'un dessin en téléchargeant ses tuiles
 * de carte correspondantes et en comparant les pixels avec le modèle.
 * Ne fait aucun appel getPixel individuel lourd.
 */
export async function syncDrawingProgress(drawingId: number): Promise<{ correctPixels: number; wrongPixels: number; message: string }> {
  const startTime = Date.now();
  const drawing = await prisma.drawing.findUnique({
    where: { id: drawingId },
  });

  if (!drawing) {
    throw new Error(`Drawing ${drawingId} not found.`);
  }

  const wplaceApi = new WplaceAPI();
  const imageUrl = drawing.imageUrl;
  const tplBuffer = await fetchTemplateImage(imageUrl);

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

  // Grouper les pixels à comparer par tuile wplace.live
  const tilesMap = new Map<string, { tileX: number; tileY: number; pixels: { dx: number; dy: number; absX: number; absY: number }[] }>();

  for (let dy = 0; dy < tplH; dy++) {
    for (let dx = 0; dx < tplW; dx++) {
      const ti = 4 * (dy * tplW + dx);
      const alpha = tplData[ti + 3];

      // Ignorer les pixels transparents du template
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

  let correctPixels = 0;
  let wrongPixels = 0;
  const colorCorrects = new Map<string, number>();

  // Note: rgbToHex is defined at the module level

  // Parcourir chaque tuile, la télécharger et comparer ses pixels avec le template
  for (const [key, tileInfo] of tilesMap.entries()) {
    const { tileX, tileY, pixels } = tileInfo;
    console.log(`[Sync] Downloading tile [${tileX}, ${tileY}] containing ${pixels.length} pixels to check`);

    const tileRes = await wplaceApi.getTile(tileX, tileY);
    if (!tileRes.ok) {
      console.error(`[Sync] Failed to download tile [${tileX}, ${tileY}]:`, tileRes.error);
      continue;
    }

    const png = tileRes.value;
    if (!png) {
      console.log(`[Sync] Tile [${tileX}, ${tileY}] is empty (404)`);
      continue;
    }

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

      // Ignorer si le pixel n'est pas encore posé sur la carte (transparent)
      if (tileA === 0) {
        continue;
      }

      const ti = 4 * (p.dy * tplW + p.dx);
      const tplR = tplData[ti];
      const tplG = tplData[ti + 1];
      const tplB = tplData[ti + 2];

      const hex = rgbToHex(tplR, tplG, tplB);

      // Comparer les couleurs
      if (tplR === tileR && tplG === tileG && tplB === tileB) {
        correctPixels++;
        colorCorrects.set(hex, (colorCorrects.get(hex) || 0) + 1);
      } else {
        wrongPixels++;
      }
    }
  }

  // Récupérer le dernier enregistrement pour comparer et logguer les modifications
  const lastProgress = await prisma.progress.findFirst({
    where: { drawingId },
    orderBy: { timestamp: 'desc' }
  });

  if (lastProgress) {
    const diffCorrect = correctPixels - lastProgress.correctPixels;
    const diffWrong = wrongPixels - lastProgress.wrongPixels;
    if (diffCorrect !== 0 || diffWrong !== 0) {
      console.log(
        `[Sync] 📢 MODIFICATION DÉTECTÉE pour "${drawing.name}" : ` +
        `Pixels corrects : ${lastProgress.correctPixels} → ${correctPixels} (${diffCorrect >= 0 ? '+' : ''}${diffCorrect}) | ` +
        `Pixels incorrects : ${lastProgress.wrongPixels} → ${wrongPixels} (${diffWrong >= 0 ? '+' : ''}${diffWrong})`
      );
    } else {
      console.log(`[Sync] Pas de modification détectée pour "${drawing.name}".`);
    }
  } else {
    console.log(`[Sync] Première synchronisation pour "${drawing.name}".`);
  }

  // Créer l'enregistrement d'historique de progression
  const progress = await prisma.progress.create({
    data: {
      drawingId,
      correctPixels,
      wrongPixels
    }
  });

  // Gestion des dates de début et fin automatiques
  const updateData: { startedAt?: Date; completedAt?: Date | null } = {};

  if (correctPixels > 0 && drawing.startedAt === null) {
    updateData.startedAt = new Date();
  }

  if (correctPixels >= drawing.totalPixels) {
    if (drawing.completedAt === null) {
      updateData.completedAt = new Date();
    }
  } else {
    if (drawing.completedAt !== null) {
      updateData.completedAt = null;
    }
  }

  if (Object.keys(updateData).length > 0) {
    await prisma.drawing.update({
      where: { id: drawingId },
      data: updateData
    });
  }

  // Mettre à jour les stats par couleur
  for (const [hex, count] of colorCorrects.entries()) {
    await prisma.colorStat.updateMany({
      where: { drawingId, hexColor: hex },
      data: { correctCount: count }
    });
  }

  // Réinitialiser à 0 les couleurs qui n'ont aucun pixel correct actuellement
  const allColorStats = await prisma.colorStat.findMany({
    where: { drawingId }
  });
  for (const stat of allColorStats) {
    if (!colorCorrects.has(stat.hexColor)) {
      await prisma.colorStat.update({
        where: { id: stat.id },
        data: { correctCount: 0 }
      });
    }
  }

  const duration = Date.now() - startTime;
  const percent = ((correctPixels / drawing.totalPixels) * 100).toFixed(2);
  const remaining = drawing.totalPixels - correctPixels;
  const message = `Dessin "${drawing.name}" : ${correctPixels}/${drawing.totalPixels} pixels corrects (${percent}%). Reste à placer : ${remaining} pixels. Erreurs : ${wrongPixels}. (Durée : ${duration}ms)`;

  console.log(`[Sync] Finished progress sync for drawing "${drawing.name}": ${message}`);

  return { correctPixels, wrongPixels, message };
}

