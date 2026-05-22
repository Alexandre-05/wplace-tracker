import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/prisma';
import { processImageStats } from '@/services/imageService';
import { put } from '@vercel/blob';
import fs from 'fs';
import path from 'path';
import { verifySiteSession } from '@/lib/auth';

// Configuration du dossier d'upload
const uploadDir = path.join(process.cwd(), 'public', 'uploads');

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    if (!(await verifySiteSession())) {
      return NextResponse.json({ error: 'Unauthorized: Access password required' }, { status: 401 });
    }

    const drawings = await prisma.drawing.findMany({
      include: {
        colorStats: true,
        progress: {
          orderBy: { timestamp: 'desc' },
          take: 1
        },
        contributors: {
          orderBy: { pixelCount: 'desc' }
        }
      }
    });
    return NextResponse.json(drawings);
  } catch (error: any) {
    console.error('[API Drawings GET Error]', error);
    return NextResponse.json({ 
      error: 'Failed to fetch drawings',
      message: error?.message || String(error),
      code: error?.code,
      meta: error?.meta,
      stack: error?.stack
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!(await verifySiteSession())) {
      return NextResponse.json({ error: 'Unauthorized: Access password required' }, { status: 401 });
    }

    const formData = await request.formData();
    const name = formData.get('name') as string;
    const chunkX = formData.get('chunkX') as string;
    const chunkY = formData.get('chunkY') as string;
    const offsetX = formData.get('offsetX') as string;
    const offsetY = formData.get('offsetY') as string;
    const wplaceUrl = formData.get('wplaceUrl') as string | null;
    const pseudo = formData.get('pseudo') as string;
    const file = formData.get('image') as File;

    if (!file || !name || !chunkX || !chunkY || !offsetX || !offsetY || !pseudo) {
      return NextResponse.json({ error: 'Missing required fields or file' }, { status: 400 });
    }

    // Validation du fichier (format PNG uniquement et taille de 10 Mo max)
    if (file.type !== 'image/png') {
      return NextResponse.json({ error: 'Le fichier doit être une image au format PNG uniquement.' }, { status: 400 });
    }

    const MAX_SIZE = 10 * 1024 * 1024; // 10 Mo
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'L\'image est trop volumineuse (maximum 10 Mo).' }, { status: 400 });
    }

    // Convert file to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Save file
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const filename = uniqueSuffix + '-' + file.name;
    let imageUrl = '';

    if (process.env.BLOB_READ_WRITE_TOKEN) {
      // Vercel Blob (production cloud storage)
      const blob = await put(filename, file, { access: 'public' });
      imageUrl = blob.url;
    } else {
      // Local development fallback
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      const filepath = path.join(uploadDir, filename);
      fs.writeFileSync(filepath, buffer);
      imageUrl = `/uploads/${filename}`;
    }

    // Process image
    const imageStats = await processImageStats(buffer);

    // Save to DB
    const newDrawing = await prisma.drawing.create({
      data: {
        name,
        chunkX: parseInt(chunkX),
        chunkY: parseInt(chunkY),
        offsetX: parseInt(offsetX),
        offsetY: parseInt(offsetY),
        width: imageStats.width,
        height: imageStats.height,
        totalPixels: imageStats.totalPixels,
        imageUrl: imageUrl,
        wplaceUrl: wplaceUrl || null,
        isValidated: false,
        pseudo,
        colorStats: {
          create: Object.entries(imageStats.colorCounts).map(([hex, count]) => ({
            hexColor: hex,
            pixelCount: count
          }))
        }
      },
      include: {
        colorStats: true
      }
    });

    return NextResponse.json(newDrawing, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to create drawing' }, { status: 500 });
  }
}
