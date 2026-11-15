// Membaca caption lelang dan komentar bid. Semua nominal disimpan dalam satuan ribu rupiah ("rb").

const WIB_OFFSET_H = 7;
const UNIT = '(rb|ribu|k|jt|juta)';

export const norm = (s: string) => s.normalize('NFKC');

/** "2.100" -> 2100, "150" -> 150, "1,5jt" -> 1500, "150.000" -> 150. null kalau tidak terbaca. */
export function toRb(num: string, unit?: string | null): number | null {
  const u = (unit || '').toLowerCase();
  if (u === 'jt' || u === 'juta') {
    const v = Number(num.replace(',', '.'));
    return Number.isFinite(v) ? Math.round(v * 1000) : null;
  }
  let v: number;
  if (/^\d+$/.test(num)) v = Number(num);
  else if (/^\d{1,3}([.,]\d{3})+$/.test(num)) v = Number(num.replace(/[.,]/g, ''));
  else return null;
  // Tanpa satuan dan sangat besar: dianggap ditulis dalam rupiah penuh (150.000 = 150rb).
  if (!u && v >= 100_000) return v % 1000 === 0 ? v / 1000 : null;
  return v;
}

export type CaptionInfo = {
  title: string;
  openBid: number | null;
  increment: number | null;
  maxJump: number | null;
  closeAt: number | null;
};

export function parseCaption(caption: string): CaptionInfo {
  const t = norm(caption || '');
  const money = (label: string) => {
    const m = t.match(new RegExp(`${label}\\s*[:=]?\\s*(?:Rp\\.?\\s*)?([\\d.,]*\\d)\\s*${UNIT}?`, 'i'));
    return m ? toRb(m[1], m[2]) : null;
  };

  let closeAt: number | null = null;
  const d = t.match(/TUTUP\s*:?[^\d\n]*(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/i);
  const h = t.match(/PUKUL\s*:?\s*(\d{1,2})[:.](\d{2})/i);
  if (d && h) {
    const year = Number(d[3]) < 100 ? 2000 + Number(d[3]) : Number(d[3]);
    closeAt = Date.UTC(year, Number(d[2]) - 1, Number(d[1]), Number(h[1]) - WIB_OFFSET_H, Number(h[2]));
  }

  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const watch = lines
    .map((l) => l.match(/^⌚️?\s*(.+?)\s*⌚️?$/u)?.[1])
    .find((x) => x && !/LELANG\s+DIMULAI/i.test(x));
  const title = (watch || lines[0] || 'Tanpa judul').slice(0, 80);

  return {
    title,
    openBid: money('OPEN\\s*BID'),
    increment: money('KELIPATAN(?:\\s*BID)?'),
    maxJump: money('MAX\\s*JUMP(?:\\s*BID)?'),
    closeAt,
  };
}

export type ParsedBid = { kind: 'abs' | 'rel'; value: number; sure: boolean };

/** Membaca bid dari komentar: "150", "2.100", "+50", "bid 150", "1,5jt". null kalau bukan bid. */
export function parseBid(text: string): ParsedBid | null {
  const t = norm(text || '').replace(/@[\w.]+/g, ' ').toLowerCase().trim();
  const rel = t.match(new RegExp(`(?:^|\\s)\\+\\s*([\\d.,]*\\d)\\s*${UNIT}?(?![a-z\\d:])`));
  const abs = rel ? null : t.match(new RegExp(`(?<![\\w.,+:])([\\d.,]*\\d)\\s*${UNIT}?(?![a-z\\d:])`));
  const m = rel || abs;
  if (!m) return null;
  const value = toRb(m[1], m[2]);
  if (value == null || value <= 0) return null;
  // "Yakin" kalau komentar hanya berisi angka (boleh diawali kata "bid"); selain itu perlu dicek.
  const rest = t.replace(m[0], ' ').replace(/\bbid\b/g, ' ');
  return { kind: rel ? 'rel' : 'abs', value, sure: !/\p{L}|\d/u.test(rest) };
}
