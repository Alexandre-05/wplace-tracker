import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/prisma';
import { verifyAdminSession, verifySiteSession } from '@/lib/auth';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!(await verifySiteSession())) {
      return NextResponse.json({ error: 'Unauthorized: Access password required' }, { status: 401 });
    }

    const resolvedParams = await params;
    const id = parseInt(resolvedParams.id);
    const drawing = await prisma.drawing.findUnique({
      where: { id },
      include: {
        colorStats: true,
        progress: {
          orderBy: { timestamp: 'desc' },
          take: 5
        },
        contributors: {
          orderBy: { pixelCount: 'desc' }
        }
      }
    });

    if (!drawing) {
      return NextResponse.json({ error: 'Drawing not found' }, { status: 404 });
    }

    return NextResponse.json(drawing);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch drawing details' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const isAdmin = await verifyAdminSession();
    if (!isAdmin) {
      return NextResponse.json({ error: 'Accès refusé : Authentification administrateur requise' }, { status: 401 });
    }
    const resolvedParams = await params;
    const id = parseInt(resolvedParams.id);
    const body = await request.json();
    
    const { name, chunkX, chunkY, offsetX, offsetY, wplaceUrl, isValidated, pseudo } = body;

    const updated = await prisma.drawing.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        chunkX: chunkX !== undefined ? parseInt(chunkX) : undefined,
        chunkY: chunkY !== undefined ? parseInt(chunkY) : undefined,
        offsetX: offsetX !== undefined ? parseInt(offsetX) : undefined,
        offsetY: offsetY !== undefined ? parseInt(offsetY) : undefined,
        wplaceUrl: wplaceUrl !== undefined ? wplaceUrl : undefined,
        isValidated: isValidated !== undefined ? isValidated : undefined,
        pseudo: pseudo !== undefined ? pseudo : undefined,
      }
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to update drawing' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const isAdmin = await verifyAdminSession();
    if (!isAdmin) {
      return NextResponse.json({ error: 'Accès refusé : Authentification administrateur requise' }, { status: 401 });
    }
    const resolvedParams = await params;
    const id = parseInt(resolvedParams.id);

    await prisma.$transaction([
      prisma.colorStat.deleteMany({ where: { drawingId: id } }),
      prisma.progress.deleteMany({ where: { drawingId: id } }),
      prisma.contributor.deleteMany({ where: { drawingId: id } }),
      prisma.drawing.delete({ where: { id } }),
    ]);

    return NextResponse.json({ success: true, message: 'Drawing deleted successfully' });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to delete drawing' }, { status: 500 });
  }
}
