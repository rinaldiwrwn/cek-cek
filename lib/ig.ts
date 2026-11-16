// Akses Instagram lewat API resmi (token Instagram login maupun Unified/Facebook login). IG_MOCK=1 memakai data palsu.
import { createHash } from 'node:crypto';
import { getKv, setKv } from './db';
import * as mock from './mock';

export type Media = { id: string; caption: string; permalink: string; thumb: string | null; ts: number };
export type IgComment = { id: string; parentId: string | null; username: string; text: string; ts: number };

export const isMock = () => process.env.IG_MOCK === '1';
export const hasToken = () => isMock() || !!process.env.IG_ACCESS_TOKEN;

const IG_HOST = 'https://graph.instagram.com';
const FB_HOST = 'https://graph.facebook.com';
const ver = () => (process.env.IG_API_VERSION ? `/${process.env.IG_API_VERSION}` : '');
const parseTs = (s: string) => Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

const REFRESH_AFTER = 7 * 86_400_000;

/**
 * Token dari env. Token jenis "Instagram login" berlaku ±60 hari dan diperpanjang otomatis tiap minggu;
 * token system user (Unified login) tidak kedaluwarsa, dan percobaan perpanjangannya gagal tanpa akibat.
 */
async function token(): Promise<string> {
  const env = process.env.IG_ACCESS_TOKEN;
  if (!env) throw new Error('IG_ACCESS_TOKEN belum diisi');
  let t = await getKv<{ value: string; source: string; at: number }>('token');
  if (!t || t.source !== env) {
    t = { value: env, source: env, at: Date.now() };
    await setKv('token', t);
  } else if (Date.now() - t.at > REFRESH_AFTER) {
    await setKv('token', { ...t, at: Date.now() }); // tandai dulu supaya tidak dicoba berulang
    try {
      const r = await fetch(
        `${IG_HOST}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t.value)}`,
      );
      const j = await r.json();
      if (j.access_token) {
        t = { value: j.access_token, source: env, at: Date.now() };
        await setKv('token', t);
      }
    } catch {}
  }
  return t.value;
}

async function request(url: string, init?: RequestInit): Promise<any> {
  const sep = url.includes('?') ? '&' : '?';
  const full = url.includes('access_token=') ? url : `${url}${sep}access_token=${encodeURIComponent(await token())}`;
  const r = await fetch(full, { ...init, cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Instagram: ${j.error?.message || `HTTP ${r.status}`}`);
  return j;
}

type Account = { base: string; id: string; username: string; key: string };

/**
 * Menentukan akun Instagram dan alamat API yang cocok dengan token:
 * - IG_USER_ID diisi: pakai ID itu (bawaan graph.facebook.com, untuk token Unified/Facebook login).
 * - Tanpa IG_USER_ID: coba token Instagram login, lalu cari akun lewat Halaman Facebook.
 */
async function account(): Promise<Account> {
  const key = createHash('sha256')
    .update([process.env.IG_ACCESS_TOKEN, process.env.IG_USER_ID, process.env.IG_API_BASE, ver()].join('|'))
    .digest('hex')
    .slice(0, 16);
  const cached = await getKv<Account>('igAccount');
  if (cached?.key === key) return cached;

  const forced = process.env.IG_API_BASE?.replace(/\/$/, '');
  const userId = process.env.IG_USER_ID?.trim();
  let found: Omit<Account, 'key'> | null = null;
  const errors: string[] = [];

  if (userId) {
    // Token system user ("EAA…") dilayani graph.facebook.com; token Instagram ("IGAA…") oleh graph.instagram.com.
    for (const base of forced ? [forced] : [FB_HOST, IG_HOST]) {
      try {
        const id = base.includes('instagram') ? 'me' : userId;
        const j = await request(`${base}${ver()}/${id}?fields=username`);
        found = { base, id, username: j.username };
        break;
      } catch (e) {
        errors.push(String((e as Error).message));
      }
    }
  } else {
    if (!forced || forced.includes('instagram')) {
      try {
        const base = forced || IG_HOST;
        const j = await request(`${base}${ver()}/me?fields=user_id,username`);
        found = { base, id: 'me', username: j.username };
      } catch (e) {
        errors.push(String((e as Error).message));
      }
    }
    if (!found && (!forced || forced.includes('facebook'))) {
      try {
        const base = forced || FB_HOST;
        const j = await request(`${base}${ver()}/me/accounts?fields=instagram_business_account{id,username}&limit=50`);
        const ig = (j.data || []).map((p: any) => p.instagram_business_account).find(Boolean);
        if (ig) found = { base, id: ig.id, username: ig.username };
      } catch (e) {
        errors.push(String((e as Error).message));
      }
    }
  }
  if (!found?.username) {
    throw new Error(
      `Akun Instagram tidak ditemukan dari token ini. Isi variabel IG_USER_ID dengan ID akun Instagram dari halaman Meta.${errors.length ? ` (${errors.join('; ')})` : ''}`,
    );
  }
  const acct = { ...found, key };
  await setKv('igAccount', acct);
  return acct;
}

async function call(path: string, init?: RequestInit): Promise<any> {
  if (path.startsWith('http')) return request(path, init);
  const a = await account();
  return request(`${a.base}${ver()}${path.replace('{ig}', a.id)}`, init);
}

export async function getMe(): Promise<{ id: string; username: string }> {
  if (isMock()) return mock.me;
  const a = await account();
  return { id: a.id, username: a.username };
}

export async function listMedia(limit = 9): Promise<Media[]> {
  if (isMock()) return mock.listMedia();
  const j = await call(
    `/{ig}/media?fields=id,caption,permalink,media_type,thumbnail_url,media_url,timestamp&limit=${limit}`,
  );
  return (j.data || []).slice(0, limit).map((m: any) => ({
    id: m.id,
    caption: m.caption || '',
    permalink: m.permalink,
    thumb: m.thumbnail_url || (m.media_type === 'VIDEO' ? null : m.media_url) || null,
    ts: parseTs(m.timestamp),
  }));
}

export async function listComments(mediaId: string): Promise<IgComment[]> {
  if (isMock()) return mock.listComments(mediaId);
  const out: IgComment[] = [];
  const add = (c: any, parentId: string | null) =>
    out.push({
      id: c.id,
      parentId,
      username: c.username || c.from?.username || '?',
      text: c.text || '',
      ts: parseTs(c.timestamp),
    });
  let next: string | undefined =
    `/${mediaId}/comments?fields=id,text,timestamp,username,replies{id,text,timestamp,username}&limit=50`;
  for (let page = 0; next && page < 40; page++) {
    const j: any = await call(next);
    for (const c of j.data || []) {
      add(c, null);
      for (const rep of c.replies?.data || []) add(rep, c.id);
    }
    next = j.paging?.next;
  }
  return out;
}

export async function postComment(mediaId: string, message: string): Promise<string> {
  if (isMock()) return mock.postComment(mediaId, message);
  const j = await call(`/${mediaId}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message }),
  });
  return String(j.id);
}
