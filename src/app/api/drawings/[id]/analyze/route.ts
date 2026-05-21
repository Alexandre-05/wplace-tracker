import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/prisma';
import { runContributorAnalysis } from '@/services/analysisService';
import { verifyAdminSession } from '@/lib/auth';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const isAdmin = await verifyAdminSession();
    if (!isAdmin) {
      return NextResponse.json({ error: 'Accès refusé : Authentification administrateur requise' }, { status: 401 });
    }
    const resolvedParams = await params;
    const id = parseInt(resolvedParams.id);

    if (isNaN(id)) {
      return NextResponse.json({ error: 'Invalid drawing ID' }, { status: 400 });
    }

    const drawing = await prisma.drawing.findUnique({
      where: { id }
    });

    if (!drawing) {
      return NextResponse.json({ error: 'Drawing not found' }, { status: 404 });
    }

    // Cooldown de 1 heure entre chaque scan de contributeurs
    if (drawing.analysisLastRun) {
      const COOLDOWN_MS = 60 * 60 * 1000; // 1h
      const elapsed = Date.now() - new Date(drawing.analysisLastRun).getTime();
      if (elapsed < COOLDOWN_MS) {
        const remainingMinutes = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
        return NextResponse.json(
          { error: `Un scan a déjà été effectué récemment. Veuillez attendre encore ${remainingMinutes} minute(s) avant de pouvoir relancer l'analyse.` },
          { status: 429 }
        );
      }
    }

    if (drawing.analysisInProgress) {
      return NextResponse.json(
        { error: 'An analysis is already running for this drawing.' },
        { status: 409 }
      );
    }

    // Trigger the analysis in the background without awaiting it
    runContributorAnalysis(id).catch((err) => {
      console.error(`[API Background Task] Contributor analysis failed:`, err);
    });

    return NextResponse.json({
      success: true,
      message: 'L\'analyse des contributeurs a été démarrée en arrière-plan.'
    });
  } catch (error) {
    console.error('[API Route] Error starting analysis:', error);
    return NextResponse.json({ error: 'Failed to start contributor analysis' }, { status: 500 });
  }
}
