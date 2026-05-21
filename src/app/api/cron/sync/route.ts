import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/prisma';
import { syncDrawingProgress } from '@/services/analysisService';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    const cronSecret = process.env.CRON_SECRET;
    const { searchParams } = new URL(request.url);
    const querySecret = searchParams.get('secret');
    const drawingIdParam = searchParams.get('drawingId');
    const expectedSecret = process.env.ADMIN_PASSWORD || 'azerty-05';

    // Sécurité en production : nécessite soit l'en-tête CRON_SECRET de Vercel, soit le secret admin dans l'URL
    if (process.env.NODE_ENV === 'production') {
      const isCronSecretValid = !!(cronSecret && authHeader === `Bearer ${cronSecret}`);
      const isQuerySecretValid = querySecret === expectedSecret;
      
      if (!isCronSecretValid && !isQuerySecretValid) {
        return NextResponse.json(
          { error: 'Unauthorized: Invalid cron token or secret param' },
          { status: 401 }
        );
      }
    }

    console.log('[Cron Sync] Starting automatic drawing progress synchronization...');

    // Si un ID de dessin spécifique est fourni en paramètre
    if (drawingIdParam) {
      const drawingId = parseInt(drawingIdParam);
      if (isNaN(drawingId)) {
        return NextResponse.json({ error: 'Invalid drawingId' }, { status: 400 });
      }
      
      const drawing = await prisma.drawing.findUnique({
        where: { id: drawingId }
      });
      
      if (!drawing) {
        return NextResponse.json({ error: 'Drawing not found' }, { status: 404 });
      }

      console.log(`[Cron Sync] Single synchronizing progress for drawing: "${drawing.name}" (ID: ${drawing.id})`);
      const res = await syncDrawingProgress(drawing.id);
      
      return NextResponse.json({
        success: true,
        timestamp: new Date().toISOString(),
        results: [{
          drawingId: drawing.id,
          name: drawing.name,
          success: true,
          correctPixels: res.correctPixels,
          wrongPixels: res.wrongPixels,
          message: res.message
        }]
      });
    }

    // Récupérer tous les dessins en base
    const drawings = await prisma.drawing.findMany();

    if (drawings.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'Aucun dessin enregistré dans la base de données.',
        results: []
      });
    }

    const results = [];

    // Parcourir et synchroniser chaque dessin
    for (const drawing of drawings) {
      try {
        console.log(`[Cron Sync] Synchronizing progress for drawing: "${drawing.name}" (ID: ${drawing.id})`);
        const res = await syncDrawingProgress(drawing.id);
        results.push({
          drawingId: drawing.id,
          name: drawing.name,
          success: true,
          correctPixels: res.correctPixels,
          wrongPixels: res.wrongPixels,
          message: res.message
        });
      } catch (err: any) {
        console.error(`[Cron Sync] Error synchronizing drawing "${drawing.name}" (ID: ${drawing.id}):`, err);
        results.push({
          drawingId: drawing.id,
          name: drawing.name,
          success: false,
          error: err?.message || String(err)
        });
      }
    }

    console.log('[Cron Sync] Synchronization process finalized.');

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      results
    });

  } catch (error: any) {
    console.error('[Cron Sync Critical Error]', error);
    return NextResponse.json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || String(error)
    }, { status: 500 });
  }
}
