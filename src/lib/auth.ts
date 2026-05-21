import { cookies } from 'next/headers';
import crypto from 'crypto';

const SESSION_SECRET = process.env.SESSION_SECRET || 'fallback-secret-key-12345';

export function signSession(timestamp: string): string {
  return crypto.createHmac('sha256', SESSION_SECRET).update(timestamp).digest('hex');
}

export function generateSessionToken(): string {
  const timestamp = Date.now().toString();
  const signature = signSession(timestamp);
  return `${timestamp}.${signature}`;
}

export async function verifyAdminSession(): Promise<boolean> {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('admin_session');
    if (!sessionCookie) return false;

    const value = sessionCookie.value;
    const parts = value.split('.');
    if (parts.length !== 2) return false;

    const [timestampStr, signature] = parts;
    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) return false;

    // Check if session has expired (7 days)
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - timestamp > oneWeekMs) return false;

    // Verify signature
    const expectedSignature = signSession(timestampStr);
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch (error) {
    console.error('Session verification failed:', error);
    return false;
  }
}
