import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const isAdmin = await verifyAdminSession();
    return NextResponse.json({ isAdmin });
  } catch (error) {
    console.error('[API Check] Error during admin check:', error);
    return NextResponse.json({ isAdmin: false });
  }
}
