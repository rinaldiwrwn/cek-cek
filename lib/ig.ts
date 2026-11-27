// Akses Instagram lewat API resmi (token Instagram login maupun Unified/Facebook login). IG_MOCK=1 memakai data palsu.
import { createHash } from 'node:crypto';
import { getKv, setKv } from './db';
import * as mock from './mock';
import { type Blocked, blockedMessage, blockRetryMs, isBlockedError, mayCall, PROBE_CLAIM_MS } from './igblock';

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
async function tokenUncached(): Promise<string> {
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

// Status blokir diingat sebentar di memori supaya tiap panggilan tidak membaca database.
let blockMemo: { v: Blocked | null; at: number } | null = null;
export async function getBlock(): Promise<Blocked | null> {
  if (isMock()) return null;
  if (blockMemo && Date.now() - blockMemo.at < 5_000) return blockMemo.v;
  const v = (await getKv<Blocked>('igBlocked').catch(() => null)) || null;
  blockMemo = { v, at: Date.now() };
  return v;
}
async function setBlock(v: Blocked | null) {
  blockMemo = { v, at: Date.now() };
  await setKv('igBlocked', v).catch(() => {});
}
/** Menghapus status blokir, supaya panggilan berikutnya mencoba lagi (dipakai tombol "Coba lagi sekarang"). */
export const clearBlock = () => setBlock(null);

async function request(url: string, init?: RequestInit): Promise<any> {
  // Selama masa blokir, tidak ada panggilan ke Instagram. Begitu jedanya lewat, SATU panggilan lolos sebagai percobaan.
  const block = await getBlock();
  if (block) {
    if (!mayCall(block, Date.now())) {
      const err = new Error(blockedMessage(block)) as Error & { blocked?: boolean };
      err.blocked = true;
      throw err;
    }
    await setBlock({ ...block, until: Date.now() + PROBE_CLAIM_MS }); // memesan percobaan ini
  }
  const sep = url.includes('?') ? '&' : '?';
  const full = url.includes('access_token=') ? url : `${url}${sep}access_token=${encodeURIComponent(await token())}`;
  const r = await fetch(full, { ...init, cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    if (isBlockedError(j.error)) {
      const e0 = j.error;
      await setBlock({ at: Date.now(), until: Date.now() + blockRetryMs(), message: `kode ${e0.code ?? '?'}${e0.error_subcode != null ? ` · sub ${e0.error_subcode}` : ''}` });
    }
    // Rincian dari Meta (kode, subkode, jejak) disertakan supaya penyebabnya bisa dilacak atau dilaporkan.
    const e = j.error || {};
    const detail = [`HTTP ${r.status}`, e.type, e.code != null && `kode ${e.code}`, e.error_subcode != null && `sub ${e.error_subcode}`, e.fbtrace_id && `trace ${e.fbtrace_id}`].filter(Boolean).join(' · ');
    const userMsg = e.error_user_msg && e.error_user_msg !== e.message ? ` — ${e.error_user_msg}` : '';
    const err = new Error(`Instagram: ${e.message || `HTTP ${r.status}`}${userMsg} [${detail}]`) as Error & { ambiguous?: boolean };
    // Error umum ("An unknown error has occurred", kode 1/2, atau bertanda sementara) kadang dikirim Instagram
    // padahal pesannya sudah terkirim, jadi hasilnya belum pasti.
    err.ambiguous = j.error?.code === 1 || j.error?.code === 2 || j.error?.is_transient === true || r.status >= 500;
    throw err;
  }
  if (block) await setBlock(null); // percobaan berhasil: blokir sudah dicabut
  return j;
}

type Account = { base: string; id: string; username: string; key: string };

/**
 * Menentukan akun Instagram dan alamat API yang cocok dengan token:
 * - IG_USER_ID diisi: pakai ID itu (bawaan graph.facebook.com, untuk token Unified/Facebook login).
 * - Tanpa IG_USER_ID: coba token Instagram login, lalu cari akun lewat Halaman Facebook.
 */
async function accountUncached(): Promise<Account> {
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

/**
 * DM ke orang yang berkomentar lewat "Private Reply": satu pesan per komentar, dalam 7 hari sejak komentar dibuat.
 * Jalurnya memakai ID akun Instagram; kalau Meta meminta ID Halaman, isi IG_MESSAGES_ID.
 */
export async function sendPrivateReply(commentId: string, text: string): Promise<{ messageId: string; recipientId: string }> {
  if (isMock()) return mock.sendPrivateReply(commentId, text);
  const a = await account();
  const id = process.env.IG_MESSAGES_ID?.trim() || a.id;
  const j = await request(`${a.base}${ver()}/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
  });
  return { messageId: String(j.message_id ?? j.id ?? ''), recipientId: String(j.recipient_id ?? '') };
}

/** ID yang dipakai untuk pesan biasa dan membaca percakapan: IG_PAGE_ID (ID Halaman) kalau diisi, kalau tidak ID untuk DM, lalu ID akun. */
const chatId = (fallback: string) => process.env.IG_PAGE_ID?.trim() || process.env.IG_MESSAGES_ID?.trim() || fallback;

/** Pesan biasa ke seorang pelanggan (ID Instagram-nya dari respons Private Reply). Hanya boleh dalam 24 jam sejak dia terakhir membalas. */
export async function sendMessage(recipientId: string, text: string): Promise<string> {
  if (isMock()) return mock.sendMessage(recipientId, text);
  const a = await account();
  const id = chatId(a.id);
  const j = await request(`${a.base}${ver()}/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  return String(j.message_id ?? j.id ?? '');
}

/**
 * Kapan pelanggan itu terakhir mengirim pesan ke akunmu (ms), atau null kalau tidak terbaca. Percakapan dicari lewat ID
 * penerima; kalau kosong, dicari di percakapan terbaru berdasarkan ID atau username peserta. Pesan "dari pelanggan"
 * adalah semua pesan yang bukan dari akunmu sendiri. `debug` merangkum yang terbaca, untuk diagnosis.
 */
export async function lastCustomerMessageAt(recipientId: string, username?: string): Promise<{ at: number | null; debug: string }> {
  if (isMock()) return { at: mock.lastCustomerMessageAt(recipientId), debug: 'mock' };
  const a = await account();
  const id = chatId(a.id);
  const fields = 'participants,messages.limit(15){id,created_time,from}';
  const base = `${a.base}${ver()}/${id}/conversations?platform=instagram`;
  const own = new Set([String(a.id), String(id)]);
  const ownName = String(a.username || '').toLowerCase();
  const want = String(username || '').toLowerCase();

  let convs: any[] = ((await request(`${base}&user_id=${encodeURIComponent(recipientId)}&fields=${fields}`)).data || []) as any[];
  let via = 'user_id';
  if (!convs.length) {
    via = 'daftar';
    const all: any[] = ((await request(`${base}&limit=25&fields=${fields}`)).data || []) as any[];
    convs = all.filter((c) => (c.participants?.data || []).some((p: any) => String(p.id) === String(recipientId) || (want && String(p.username || '').toLowerCase() === want)));
  }
  let last: number | null = null;
  let msgs = 0;
  const senders = new Set<string>();
  for (const conv of convs) {
    for (const m of conv.messages?.data || []) {
      msgs++;
      const fid = String(m.from?.id ?? '');
      const fname = String(m.from?.username || '').toLowerCase();
      senders.add(fname || fid);
      if (own.has(fid) || (ownName && fname === ownName)) continue; // pesan dari akunmu sendiri
      const t = parseTs(m.created_time);
      if (last == null || t > last) last = t;
    }
  }
  return { at: last, debug: `via ${via}, percakapan ${convs.length}, pesan ${msgs}, pengirim ${[...senders].join('/') || '-'}` };
}

/** Membalas sebuah komentar (harus komentar tingkat atas; balasan atas balasan tidak didukung Instagram). */
export async function postReply(commentId: string, message: string): Promise<string> {
  if (isMock()) return mock.postReply(commentId, message);
  const j = await call(`/${commentId}/replies`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message }),
  });
  return String(j.id);
}

// Token dan akun diingat di memori beberapa saat, supaya mengirim komentar tidak menunggu pembacaan database dulu.
const memo: { tok?: { v: string; at: number }; acct?: { v: Account; at: number } } = {};
async function token(): Promise<string> {
  if (memo.tok && Date.now() - memo.tok.at < 30_000) return memo.tok.v;
  const v = await tokenUncached();
  memo.tok = { v, at: Date.now() };
  return v;
}
async function account(): Promise<Account> {
  if (memo.acct && Date.now() - memo.acct.at < 60_000) return memo.acct.v;
  const v = await accountUncached();
  memo.acct = { v, at: Date.now() };
  return v;
}

/** Menyiapkan token dan akun sebelum komentar terjadwal dikirim, supaya detik pengirimannya tidak terpakai untuk itu. */
export async function warm() {
  if (isMock()) return;
  await account();
  await token();
}

export async function postComment(mediaId: string, message: string): Promise<string> {
  if (isMock()) {
    const d = Number(process.env.MOCK_POST_DELAY_MS || 0); // untuk menguji penjadwalan dengan keterlambatan jaringan
    if (d > 0) await new Promise((r) => setTimeout(r, d));
    return mock.postComment(mediaId, message);
  }
  const j = await call(`/${mediaId}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message }),
  });
  return String(j.id);
}

/**
 * Diagnosis chat lanjutan: apa yang dilihat Instagram untuk seorang pelanggan. Tidak mengubah apa pun.
 * Tiap pemeriksaan berdiri sendiri, jadi satu yang gagal tidak menghentikan yang lain.
 */
export async function diagnoseChat(recipientId: string | null, username: string): Promise<string[]> {
  if (isMock()) return ['mode demo: tidak ada yang diperiksa'];
  const out: string[] = [];
  const a = await account();
  const id = chatId(a.id);
  out.push(`Akun: @${a.username} (ID ${a.id}${id !== a.id ? `, ID pesan ${id}` : ''})`);
  out.push(`ID penerima tersimpan: ${recipientId || 'tidak ada'}`);
  const step = async (label: string, fn: () => Promise<string>) => {
    try {
      out.push(`${label}: ${await fn()}`);
    } catch (e) {
      out.push(`${label}: GAGAL ${String((e as Error)?.message || e).slice(0, 260)}`);
    }
  };
  await step('Langganan webhook', async () => {
    const j = await request(`${a.base}${ver()}/${id}/subscribed_apps`);
    const rows = (j.data || []) as any[];
    if (!rows.length) return 'tidak ada aplikasi yang berlangganan';
    return rows.map((r) => `${r.name || r.id}: ${(r.subscribed_fields || []).join(',') || '(tanpa kolom)'}`).join(' | ');
  });
  let pageId = '';
  await step('Halaman Facebook yang terhubung', async () => {
    const j = await request(`${a.base}${ver()}/me/accounts?fields=id,name,instagram_business_account&limit=25`);
    const rows = (j.data || []) as any[];
    if (!rows.length) return 'tidak ada (token tidak punya akses ke Halaman)';
    pageId = rows.find((r) => r.instagram_business_account?.id === a.id)?.id || '';
    return rows.map((r) => `${r.name} (ID ${r.id})${r.instagram_business_account?.id ? ` ← IG ${r.instagram_business_account.id}${r.instagram_business_account.id === a.id ? ' = akun ini' : ''}` : ''}`).join(' | ');
  });
  if (pageId && pageId !== id) {
    await step(`Langganan webhook Halaman ${pageId}`, async () => {
      const j = await request(`${a.base}${ver()}/${pageId}/subscribed_apps`);
      const rows = (j.data || []) as any[];
      return rows.length ? rows.map((r) => `${r.name || r.id}: ${(r.subscribed_fields || []).join(',') || '(tanpa kolom)'}`).join(' | ') : 'tidak ada aplikasi yang berlangganan';
    });
  }
  const fields = 'participants,updated_time,messages.limit(8){id,created_time,from,message}';
  const sum = (convs: any[]) =>
    convs.length
      ? convs
          .map((c) => {
            const ms = (c.messages?.data || []) as any[];
            const who = (c.participants?.data || []).map((p: any) => p.username || p.id).join('+');
            const froms = ms.map((m) => `${m.from?.username || m.from?.id}@${String(m.created_time).slice(11, 19)}`).join(' ');
            return `[${who}] ${ms.length} pesan: ${froms}`;
          })
          .join(' || ')
      : 'kosong';
  if (recipientId) {
    await step('Percakapan via user_id', async () => sum(((await request(`${a.base}${ver()}/${id}/conversations?platform=instagram&user_id=${encodeURIComponent(recipientId)}&fields=${fields}`)).data || []) as any[]));
  }
  await step('Percakapan terbaru', async () => sum(((await request(`${a.base}${ver()}/${id}/conversations?platform=instagram&limit=3&fields=${fields}`)).data || []) as any[]));
  if (pageId && pageId !== id) {
    if (recipientId) {
      await step(`Percakapan via Halaman, user_id`, async () => sum(((await request(`${a.base}${ver()}/${pageId}/conversations?platform=instagram&user_id=${encodeURIComponent(recipientId)}&fields=${fields}`)).data || []) as any[]));
    }
    await step(`Percakapan terbaru via Halaman`, async () => sum(((await request(`${a.base}${ver()}/${pageId}/conversations?platform=instagram&limit=3&fields=${fields}`)).data || []) as any[]));
  }
  out.push(`(cari @${username} di daftar di atas)`);
  return out;
}
