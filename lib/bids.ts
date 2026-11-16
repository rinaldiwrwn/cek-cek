import { parseBid } from './parse';

export const SNIPER_MS = 5 * 60_000;

export type CommentIn = {
  id: string;
  parentId: string | null;
  username: string;
  text: string;
  ts: number;
  deleted: boolean;
  deletedAt?: number | null;
  override: 'valid' | 'invalid' | 'wrong' | null; // sah, tolak, salah bid
};

export type Rules = {
  openBid: number | null;
  increment: number | null;
  maxJump: number | null;
  closeAt: number | null;
  ownUsername: string | null;
  verified?: Set<string>; // daftar akun sah
  sniperMinBids?: number; // Sniper Zone baru aktif kalau bid sah sebelum zona ini minimal sebanyak ini (bawaan 2)
};

export type Flag =
  | 'terlambat' | 'sniper' | 'bawahOb' | 'tidakNaik' | 'kelipatan'
  | 'maxJump' | 'dihapus' | 'tanpaAcuan' | 'cek' | 'balasan';

// Penanda yang hanya informasi: bid tetap dihitung kecuali kamu menolaknya.
const SOFT: Flag[] = ['cek', 'balasan', 'dihapus'];

export type BidRow = CommentIn & {
  own: boolean;
  verified: boolean;
  isBid: boolean;
  amount: number | null;
  flags: Flag[];
  valid: boolean;
};

const byTime = (a: CommentIn, b: CommentIn) =>
  a.ts - b.ts || a.id.length - b.id.length || (a.id < b.id ? -1 : 1);

/**
 * Menilai komentar secara berurutan. Hasilnya hanya saran: keputusan manual
 * (override) selalu menang, dan "+50" dihitung dari bid sah tertinggi saat itu.
 */
export function evaluate(comments: CommentIn[], r: Rules) {
  const rows: BidRow[] = [];
  const eligible = new Set<string>(); // punya bid sah sebelum sniper zone
  let validBefore = 0; // jumlah bid sah sebelum sniper zone dimulai
  const minBids = r.sniperMinBids ?? 2;
  const sniperStart = r.closeAt != null ? r.closeAt - SNIPER_MS : null;
  let top: BidRow | null = null;

  for (const c of [...comments].sort(byTime)) {
    const own = !!r.ownUsername && c.username === r.ownUsername;
    const p = own ? null : parseBid(c.text);
    if (!p) {
      rows.push({ ...c, own, verified: false, isBid: false, amount: null, flags: [], valid: false });
      continue;
    }
    const current: number | null = top ? top.amount : null;
    const amount = p.kind === 'abs' ? p.value : p.kind === 'ob' ? r.openBid : current != null ? current + p.value : null;
    const flags: Flag[] = [];

    if (c.deleted) flags.push('dihapus');
    if (r.closeAt != null && c.ts > r.closeAt) flags.push('terlambat');
    // Aturan sniper (hanya yang sudah bid boleh bid) berlaku hanya kalau Sniper Zone aktif, yaitu bid sah cukup banyak.
    else if (sniperStart != null && c.ts >= sniperStart && validBefore >= minBids && !eligible.has(c.username)) flags.push('sniper');
    if (amount == null) flags.push('tanpaAcuan');
    else {
      if (r.openBid != null && amount < r.openBid) flags.push('bawahOb');
      if (current != null && amount <= current) flags.push('tidakNaik');
      if (r.increment && (amount - (r.openBid ?? 0)) % r.increment !== 0) flags.push('kelipatan');
      const base = current ?? r.openBid;
      if (r.maxJump && base != null && amount - base > r.maxJump) flags.push('maxJump');
    }
    if (!p.sure) flags.push('cek');
    if (c.parentId) flags.push('balasan');

    const auto = flags.every((f) => SOFT.includes(f));
    const valid = amount != null && (c.override ? c.override === 'valid' : auto);
    const row: BidRow = { ...c, own, verified: !!r.verified?.has(c.username), isBid: true, amount, flags, valid };
    rows.push(row);

    if (valid) {
      if (!top || amount! > top.amount!) top = row;
      if (sniperStart == null || c.ts < sniperStart) {
        eligible.add(c.username);
        validBefore++;
      }
    }
  }
  return { rows, top };
}
