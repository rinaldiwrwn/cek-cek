// Data palsu untuk mode demo (IG_MOCK=1): 9 lelang yang close berurutan mulai ±7 menit dari sekarang.
import type { IgComment, Media } from './ig';

export const me = { id: '0', username: 'akun_lelang_demo' };

const WATCHES = [
  'Seiko 5 Automatic 7S26', 'Citizen Eco-Drive Titanium', 'Orient Bambino V2', 'Casio G-Shock DW-5600',
  'Disney Mickey Mouse Quartz', 'Alba Chronograph', 'Timex Expedition', 'Swatch Irony', 'Tissot PRX Quartz',
];
const USERS = ['budi.watch', 'arloji_sby', 'kolektor88', 'dimas_r', 'tono.jam', 'hunter_seiko'];

type Store = { media: Media[]; comments: Record<string, IgComment[]>; seq: number; removed: boolean; calls: Record<string, number>; created: Record<string, number>; dms: { commentId: string; text: string }[]; chat: { to: string; text: string; ts: number }[]; replies: Record<string, number> };
const g = globalThis as unknown as { __lmMock?: Store };

const wib = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString();

function init(): Store {
  const now = Date.now();
  const first = Math.ceil((now + 7 * 60_000) / 60_000) * 60_000;
  const s: Store = { media: [], comments: {}, seq: 1, removed: false, calls: {}, created: {}, dms: [], chat: [], replies: {} };
  WATCHES.forEach((name, i) => {
    const close = wib(first + i * 5 * 60_000);
    const [y, mo, d] = close.slice(0, 10).split('-');
    const id = `demo${i + 1}`;
    s.media.push({
      id,
      permalink: 'https://www.instagram.com/',
      thumb: null,
      ts: now - (9 - i) * 3_600_000,
      caption: [
        '⌚️ LELANG DIMULAI ⌚️', '', '✅ OPEN BID: 100rb', '✅ Kelipatan Bid: 50rb', '✅ Max Jump Bid: 300rb', '',
        `⌚️${name}⌚️`, 'Grade: Original', '',
        `⏺️ TUTUP: ${d}/${mo}/${y}`, `⏺️ PUKUL: ${close.slice(11, 16)} WIB, LEWAT 1 DETIK TIDAK SAH`,
      ].join('\n'),
    });
    let amount = 100;
    s.comments[id] = [];
    // Contoh bid uji, hanya kalau akun ujinya diatur (TEST_ACCOUNTS=sakatimepiece).
    if (i === 1 && /sakatimepiece/i.test(process.env.TEST_ACCOUNTS || '')) s.comments[id].push({ id: String(s.seq++), parentId: null, username: 'sakatimepiece', text: 'Tes, 300', ts: now - 3 * 60_000 });
    if (i === 0) s.comments[id].push({ id: String(s.seq++), parentId: null, username: 'kolektor88', text: '+50', ts: now - 20 * 60_000 }); // contoh bid dengan +
    for (let k = 0; k < 2 + (i % 4); k++) {
      const ts = now - (40 - k * 9 - i) * 60_000;
      s.comments[id].push({ id: String(s.seq++), parentId: null, username: USERS[(i + k) % USERS.length], text: String(amount), ts });
      amount += 50;
    }
    if (i === 1) s.comments[id].push({ id: String(s.seq++), parentId: null, username: 'penanya_baru', text: 'diameter 40mm ya min?', ts: now - 600_000 });
  });
  return s;
}

const store = () => (g.__lmMock ??= init());

export const listMedia = () => [...store().media].reverse();

export function listComments(mediaId: string): IgComment[] {
  const s = store();
  const list = (s.comments[mediaId] ??= []);
  // Kadang ada bid baru masuk, supaya dashboard terlihat hidup.
  if (Math.random() < 0.2) {
    const text = ['+50', '+50', '+100', '+50 gan', '+400'][Math.floor(Math.random() * 5)];
    const username = Math.random() < 0.15 ? 'sniper_dadakan' : USERS[Math.floor(Math.random() * USERS.length)];
    list.push({ id: String(s.seq++), parentId: null, username, text, ts: Math.floor(Date.now() / 1000) * 1000 });
  }
  // Satu bid dihapus setelah sempat terbaca sekali, untuk memperlihatkan penanda "Terhapus".
  s.calls[mediaId] = (s.calls[mediaId] || 0) + 1;
  if (!s.removed && mediaId === 'demo3' && s.calls[mediaId] > 1 && list.length > 3) {
    list.splice(2, 1);
    s.removed = true;
  }
  return [...list];
}

/** Meniru aturan Instagram: komentarnya harus ada, dan hanya satu DM per komentar. */
export function sendPrivateReply(commentId: string, text: string): { messageId: string; recipientId: string } {
  const s = store();
  const owner = Object.values(s.comments).flat().find((c) => c.id === commentId);
  if (!owner) throw new Error('Instagram: komentar tidak ditemukan');
  if (s.dms.some((d) => d.commentId === commentId)) throw new Error('Instagram: sudah ada DM untuk komentar ini');
  s.dms.push({ commentId, text });
  return { messageId: `dm${s.seq++}`, recipientId: `igsid_${owner.username}` };
}

/** Pesan biasa: hanya boleh kalau pelanggan membalas dalam 24 jam terakhir, seperti aturan Instagram. */
export function sendMessage(recipientId: string, text: string): string {
  const s = store();
  const last = s.replies[recipientId];
  if (!last || Date.now() - last > 24 * 3_600_000) throw new Error('Instagram: di luar jendela balasan 24 jam');
  s.chat.push({ to: recipientId, text, ts: Date.now() });
  return `msg${s.seq++}`;
}

export const lastCustomerMessageAt = (recipientId: string): number | null => store().replies[recipientId] ?? null;

/** Hanya untuk uji: meniru pelanggan yang membalas DM. */
export const mockCustomerReply = (username: string, at = Date.now()) => {
  store().replies[`igsid_${username}`] = at;
};
export const mockChat = () => store().chat;

export function postReply(commentId: string, message: string): string {
  const s = store();
  const id = String(s.seq++);
  for (const list of Object.values(s.comments)) {
    if (list.some((c) => c.id === commentId)) {
      list.push({ id, parentId: commentId, username: me.username, text: message, ts: Math.floor(Date.now() / 1000) * 1000 });
      return id;
    }
  }
  throw new Error('Instagram: komentar tidak ditemukan');
}

export function postComment(mediaId: string, message: string): string {
  const s = store();
  const id = String(s.seq++);
  (s.comments[mediaId] ??= []).push({ id, parentId: null, username: me.username, text: message, ts: Math.floor(Date.now() / 1000) * 1000 });
  s.created[id] = Date.now();
  return id;
}
