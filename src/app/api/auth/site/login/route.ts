import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { generateSessionToken } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const { password } = await request.json();
    const expectedPassword = process.env.SITE_PASSWORD || 'wplace';

    if (password !== expectedPassword) {
      return NextResponse.json({ error: 'Mot de passe incorrect' }, { status: 401 });
    }

    const token = generateSessionToken();
    const cookieStore = await cookies();
    cookieStore.set('site_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/'
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API Site Login] Error during site login:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
