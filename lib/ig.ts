// Akses Instagram lewat API resmi (Instagram API with Instagram Login). IG_MOCK=1 memakai data palsu.
import { getKv, setKv } from './db';
import * as mock from './mock';

export type Media = { id: string; caption: string; permalink: string; thumb: string | null; ts: number };
export type IgComment = { id: string; parentId: string | null; username: string; text: string; ts: number };

export const isMock = () => process.env.IG_MOCK === '1';
export const hasToken = () => isMock() || !!process.env.IG_ACCESS_TOKEN;

const base = () => {
  const b = (process.env.IG_API_BASE || 'https://graph.instagram.com').replace(/\/$/, '');
  return process.env.IG_API_VERSION ? `${b}/${process.env.IG_API_VERSION}` : b;
};
const parseTs = (s: string) => Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

const REFRESH_AFTER = 7 * 86_400_000;

/** Token dari env, diperpanjang otomatis tiap minggu (masa berlaku ±60 hari) dan disimpan di database. */
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
        `${base()}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t.value)}`,
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

async function call(path: string, init?: RequestInit): Promise<any> {
  const url = path.startsWith('http') ? path : `${base()}${path}`;
  const sep = url.includes('?') ? '&' : '?';
  const full = url.includes('access_token=') ? url : `${url}${sep}access_token=${encodeURIComponent(await token())}`;
  const r = await fetch(full, { ...init, cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Instagram: ${j.error?.message || `HTTP ${r.status}`}`);
  return j;
}

export async function getMe(): Promise<{ id: string; username: string }> {
  if (isMock()) return mock.me;
  const j = await call('/me?fields=user_id,username');
  return { id: String(j.user_id ?? j.id), username: j.username };
}

export async function listMedia(limit = 9): Promise<Media[]> {
  if (isMock()) return mock.listMedia();
  const j = await call(
    `/me/media?fields=id,caption,permalink,media_type,thumbnail_url,media_url,timestamp&limit=${limit}`,
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
