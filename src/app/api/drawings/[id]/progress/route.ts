import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/prisma';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const trackerKey = request.headers.get('x-tracker-key') || request.headers.get('Authorization')?.replace('Bearer ', '');
    const expectedKey = process.env.TRACKER_API_KEY || process.env.ADMIN_PASSWORD || 'azerty-05';

    if (!trackerKey || trackerKey !== expectedKey) {
      return NextResponse.json({ error: 'Unauthorized: Invalid or missing tracker key' }, { status: 401 });
    }

    const resolvedParams = await params;
    const id = parseInt(resolvedParams.id);
    const body = await request.json();
    const { correctPixels, wrongPixels, colorCorrects } = body;

    if (correctPixels === undefined || wrongPixels === undefined) {
      return NextResponse.json({ error: 'Missing correctPixels or wrongPixels' }, { status: 400 });
    }

    const drawing = await prisma.drawing.findUnique({ where: { id } });
    if (!drawing) {
      return NextResponse.json({ error: 'Drawing not found' }, { status: 404 });
    }

    const progress = await prisma.progress.create({
      data: {
        drawingId: id,
        correctPixels: parseInt(correctPixels),
        wrongPixels: parseInt(wrongPixels)
      }
    });

    // Gestion automatique des dates de début et de fin
    const parsedCorrect = parseInt(correctPixels);
    const updateData: { startedAt?: Date; completedAt?: Date | null } = {};

    if (parsedCorrect > 0 && drawing.startedAt === null) {
      updateData.startedAt = new Date();
    }

    if (parsedCorrect >= drawing.totalPixels) {
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
        where: { id },
        data: updateData
      });
    }

    if (colorCorrects) {
      for (const [hex, count] of Object.entries(colorCorrects)) {
        await prisma.colorStat.updateMany({
          where: { drawingId: id, hexColor: hex },
          data: { correctCount: parseInt(count as string) }
        });
      }
    }

    const percent = ((parseInt(correctPixels) / drawing.totalPixels) * 100).toFixed(2);
    const remaining = drawing.totalPixels - parseInt(correctPixels);
    const message = `Dessin "${drawing.name}" : ${correctPixels}/${drawing.totalPixels} pixels corrects (${percent}%). Reste à placer : ${remaining} pixels. Erreurs : ${wrongPixels}.`;

    return NextResponse.json({ progress, message }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update progress' }, { status: 500 });
  }
}
