import { parseBid, amountText } from './parse';

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
  repliedAt?: number | null; // kapan komentar ini dibalas dari dashboard
  repliedAuto?: boolean; // balasannya dikirim otomatis oleh sistem
  replyFailedAt?: number | null; // balasan otomatis gagal; tidak dicoba lagi sampai kamu membalas manual
  replyError?: string | null;
};

export type Rules = {
  openBid: number | null;
  increment: number | null;
  maxJump: number | null;
  closeAt: number | null;
  ownUsername: string | null;
  verified?: Set<string>; // daftar akun sah
  imported?: Set<string>; // akun sah yang masuk lewat impor followers (belum kamu sahkan sendiri)
  sniperMinBids?: number; // Sniper Zone baru aktif kalau bid sah sebelum zona ini minimal sebanyak ini (bawaan 2)
};

export type Flag =
  | 'terlambat' | 'sniper' | 'bawahOb' | 'tidakNaik' | 'kelipatan'
  | 'maxJump' | 'dihapus' | 'tanpaAcuan' | 'cek' | 'balasan';

// Penanda yang hanya informasi: bid tetap dihitung kecuali kamu menolaknya.
// Penanda lain (termasuk 'dihapus') membuat bid otomatis tidak sah sampai kamu mengesahkannya manual.
const SOFT: Flag[] = ['cek', 'balasan'];

export type BidRow = CommentIn & {
  own: boolean;
  verified: boolean;
  imported: boolean;
  relative: boolean; // bid ditulis dengan awalan "+" (mis. +50), jadi totalnya hasil hitungan sistem
  solid: boolean; // sudah pasti: bid ini disahkan, dan kalau berawalan "+", bid acuannya juga sudah pasti (rantai tanpa bid yang belum dicek)
  autoApproved: boolean; // disahkan otomatis: akun ada di daftar akun sah dan bid-nya tidak kena penanda apa pun
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
      rows.push({ ...c, own, verified: false, imported: false, relative: false, solid: false, autoApproved: false, isBid: false, amount: null, flags: [], valid: false });
      continue;
    }
    const ref: BidRow | null = top; // bid acuan untuk bid berawalan "+"
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
    const verified = !!r.verified?.has(c.username);
    // Bid dari akun sah disahkan otomatis, kecuali kena penanda (sama atau lebih rendah dari bid sebelumnya, terhapus,
    // terlambat, di luar kelipatan, dan sebagainya) atau sudah kamu putuskan sendiri.
    const autoApproved = verified && !c.override && flags.length === 0 && valid;
    // Total bid "+" bergantung pada bid acuannya. Kalau acuannya belum dicek, total itu belum pasti: kalau acuannya
    // nanti kamu tolak, totalnya berubah. Karena itu bid "+" baru dianggap pasti kalau seluruh rantai acuannya pasti.
    const approved = c.override === 'valid' || autoApproved;
    const solid = valid && approved && (p.kind !== 'rel' || !!ref?.solid);
    const row: BidRow = { ...c, own, verified, imported: !!r.imported?.has(c.username), relative: p.kind === 'rel', solid, autoApproved, isBid: true, amount, flags, valid };
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

/**
 * Pemenang bawaan sebuah lelang yang sudah close: pemilik bid sah tertinggi, asalkan bid itu sudah kamu sahkan
 * atau akunnya ada di daftar akun sah. Mengembalikan alasannya, atau null kalau belum bisa ditentukan otomatis.
 */
export function autoWinnerReason(top: BidRow | null, source: 'manual' | 'import' | undefined): string | null {
  if (!top || !top.valid || top.amount == null) return null;
  if (top.override === 'valid') return 'Otomatis · bid sudah disahkan';
  if (source === 'manual') return 'Otomatis · akun sah';
  if (source === 'import') return 'Otomatis · akun sah dari impor followers';
  return null;
}

/**
 * Bid yang berhak dibalas otomatis ("bid [total] sah yaa"): berawalan "+", sudah disahkan otomatis (akun sah, tanpa
 * penanda), totalnya pasti (bid acuannya juga sudah disahkan), belum dibalas, dan masuk setelah fitur dinyalakan serta masih baru. Bid lama tidak pernah dibalas.
 */
export function autoReplyTargets(rows: BidRow[], o: { since: number; now: number; maxAgeMs: number }) {
  return rows.filter(
    (r) =>
      r.isBid && r.relative && r.autoApproved && r.solid && !r.own && !r.deleted && r.amount != null &&
      !r.repliedAt && !r.replyFailedAt && r.ts >= o.since && r.ts >= o.now - o.maxAgeMs,
  );
}

/**
 * Bid pemenang yang boleh memicu DM otomatis: milik pemenang, nominalnya sama dengan hasil lelang, sudah disahkan
 * (akun sah otomatis, atau kamu sahkan manual), harganya pasti (kalau berawalan "+", bid acuannya juga sudah disahkan),
 * dan tidak melanggar aturan lelang (terlambat, di luar kelipatan,
 * sniper zone tanpa bid sebelumnya, lewat max jump, tidak lebih tinggi, terhapus, dan sebagainya).
 * Mengembalikan bid terbarunya, atau null kalau tidak ada yang memenuhi syarat.
 */
export function winnerBidForDm(rows: BidRow[], winner: { username: string; amount: number | null }): BidRow | null {
  const ok = rows.filter(
    (r) =>
      r.isBid && !r.own && r.valid && r.username === winner.username && r.amount === winner.amount &&
      (r.override === 'valid' || r.autoApproved) && r.solid && r.flags.every((f) => SOFT.includes(f)),
  );
  return ok.sort((a, b) => b.ts - a.ts)[0] ?? null;
}

export const DM_TEMPLATE = 'Menang yaa untuk lelang {barang} di harga {harga} 🥳';

/** Mengisi template DM pemenang: {barang} dengan nama barang/jam lelangnya, {harga} dengan harga menang (dalam ribuan). */
export function dmMessage(template: string, title: string | null | undefined, amountRb: number | null | undefined) {
  const barang = String(title || '').trim() || 'ini';
  const harga = amountRb == null ? '' : amountText(amountRb);
  return template.replace(/\{barang\}/g, barang).replace(/\{harga\}/g, harga);
}
