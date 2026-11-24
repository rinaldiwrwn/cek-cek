// Chat lanjutan setelah DM pemenang: rekap total untuk pelanggan lama, atau permintaan alamat untuk pelanggan baru.
// Isi pesan dan keputusan kapan boleh dikirim ada di sini sebagai fungsi murni supaya mudah diuji.
import { amountText } from './parse';

export const WIB_MS = 7 * 3_600_000;
export const DAY_MS = 24 * 3_600_000;

/** Batas jendela balasan Instagram adalah 24 jam sejak pesan terakhir pelanggan; dipakai 23 jam supaya ada ruang. */
export const REPLY_WINDOW_MS = 23 * 3_600_000;

/** Tanggal WIB (YYYY-MM-DD) dari sebuah waktu. */
export const dayKey = (ms: number) => new Date(ms + WIB_MS).toISOString().slice(0, 10);

/** Awal hari WIB (dalam ms UTC) dari kunci tanggalnya. */
export const dayStart = (key: string) => Date.parse(`${key}T00:00:00Z`) - WIB_MS;

export const packingFee = () => Math.max(0, Number(process.env.PACKING_FEE ?? 5) || 0); // rb per barang

export type Greeting = 'om' | 'ka';
export const greetingWord = (g: string | null | undefined) => (g === 'ka' ? 'kaa' : 'om');

export const NEW_CUSTOMER_TEXT = 'Saya minta alamat lengkap dan kontak penerimanya yaa, untuk dicek ongkirnya dulu';

/** Rumus total: harga1+packing+harga2+packing+...+ongkir=total (semua dalam ribuan). */
export function recapExpression(amounts: number[], ongkir: number, packing = packingFee()) {
  const parts: number[] = [];
  for (const a of amounts) parts.push(a, packing);
  parts.push(ongkir);
  const total = parts.reduce((s, n) => s + n, 0);
  return { expression: parts.join('+'), total };
}

/** Pesan rekap untuk pelanggan lama, dengan info transfer kalau TRANSFER_INFO diisi. */
export function recapMessage(o: { amounts: number[]; ongkir: number; greeting?: string | null; transfer?: string | null; packing?: number }) {
  const g = greetingWord(o.greeting);
  const { expression, total } = recapExpression(o.amounts, o.ongkir, o.packing);
  const lines = [`Untuk totalnya jadi ${expression}=${amountText(total)} yaa ${g}`];
  const t = String(o.transfer || '').trim();
  if (t) lines.push('', `Transfernya kesini ya ${g}:`, t);
  return { text: lines.join('\n'), total };
}

export type Win = { postId: string; amount: number; closeAt: number; dmSent: boolean };

export type Decision =
  | { action: 'send'; kind: 'recap' | 'new'; text: string; total?: number }
  | { action: 'wait'; reason: string }
  | { action: 'expired'; reason: string };

/**
 * Menentukan langkah chat lanjutan untuk satu pemenang pada satu hari.
 * - Belum ada balasan pelanggan: menunggu. Tanpa balasan Instagram tidak mengizinkan pesan kedua.
 * - Pelanggan baru: permintaan alamat langsung dikirim setelah dia membalas.
 * - Pelanggan lama: rekap baru dikirim kalau semua lelang hari itu sudah selesai dan semua kemenangannya sudah di-DM,
 *   supaya totalnya tidak kurang.
 */
export function decideFollowup(o: {
  now: number;
  wins: Win[]; // semua kemenangan akun itu di hari tersebut
  customer: { ongkir: number; greeting: string } | null;
  lastReplyAt: number | null; // pesan terakhir dari pelanggan
  firstDmAt: number; // DM pemenang pertama di hari itu
  undecided: number; // lelang hari itu yang belum close atau belum punya hasil
  transfer?: string | null;
  newText?: string;
  force?: boolean; // kirim manual: lewati syarat menunggu lelang lain, tapi tetap butuh balasan pelanggan
}): Decision {
  const { now, wins, customer, lastReplyAt } = o;
  if (!wins.length) return { action: 'wait', reason: 'Belum ada kemenangan' };
  if (lastReplyAt == null || lastReplyAt <= o.firstDmAt) return { action: 'wait', reason: 'Menunggu balasan pemenang' };
  if (now - lastReplyAt > REPLY_WINDOW_MS) return { action: 'expired', reason: 'Jendela balasan 24 jam sudah lewat. Kirim manual lewat Instagram.' };

  if (!customer) return { action: 'send', kind: 'new', text: o.newText || NEW_CUSTOMER_TEXT };

  if (o.undecided > 0 && !o.force) return { action: 'wait', reason: `Menunggu ${o.undecided} lelang hari itu selesai` };
  const unsent = wins.filter((w) => !w.dmSent).length;
  if (unsent > 0 && !o.force) return { action: 'wait', reason: `Menunggu DM ${unsent} kemenangan lain` };
  const amounts = [...wins].sort((a, b) => a.closeAt - b.closeAt).map((w) => w.amount);
  const { text, total } = recapMessage({ amounts, ongkir: customer.ongkir, greeting: customer.greeting, transfer: o.transfer });
  return { action: 'send', kind: 'recap', text, total };
}
