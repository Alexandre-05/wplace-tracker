import { NextRequest, NextResponse } from 'next/server';
import { verifySiteSession } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const isAuthorized = await verifySiteSession();
    return NextResponse.json({ isAuthorized });
  } catch (error) {
    console.error('[API Site Check] Error during site session check:', error);
    return NextResponse.json({ isAuthorized: false });
  }
}
