import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

export const COOKIE = 'lm_session';

const pw = () => process.env.DASHBOARD_PASSWORD || '';
const sha = (s: string) => createHash('sha256').update(s).digest();
const same = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

export const sessionValue = () => sha(`lm-session:${pw()}`).toString('hex');
export const passwordRequired = () => !!pw();
export const checkPassword = (input: string) => !!pw() && same(input, pw());

/** Tanpa DASHBOARD_PASSWORD, dashboard hanya terbuka di lokal atau mode demo. */
export async function isAuthed(): Promise<boolean> {
  if (!pw()) return process.env.NODE_ENV !== 'production' || process.env.IG_MOCK === '1';
  const c = (await cookies()).get(COOKIE)?.value;
  return !!c && same(c, sessionValue());
}

export function cronAuthed(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || new URL(req.url).searchParams.get('key') || '';
  return same(given, secret);
}

/** Pintu masuk untuk aplikasi lain (mis. webapp ongkir) yang mengirim data pelanggan. Mati kalau CUSTOMER_API_TOKEN kosong. */
export function customerAuthed(req: Request): boolean {
  const secret = process.env.CUSTOMER_API_TOKEN;
  if (!secret) return false;
  return same(req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '', secret);
}
