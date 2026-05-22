import { get } from '@vercel/blob';
import { NextRequest, NextResponse } from 'next/server';
import { verifySiteSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate using our site session helper
    if (!(await verifySiteSession())) {
      return NextResponse.json({ error: 'Unauthorized: Visitor session required' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');

    if (!url) {
      return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
    }

    // 2. Fetch the private blob using the Vercel Blob SDK
    const result = await get(url, { access: 'private' });

    if (!result) {
      return NextResponse.json({ error: 'Image not found' }, { status: 404 });
    }

    // 3. Return the stream with appropriate headers
    return new NextResponse(result.stream, {
      headers: {
        'Content-Type': result.blob?.contentType || 'image/png',
        'Cache-Control': 'private, max-age=86400', // Cache client side for 24h
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error: any) {
    console.error('[API Images GET Error]', error);
    return NextResponse.json({ error: 'Image not found or access denied', message: error?.message }, { status: 404 });
  }
}
