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

const USERNAME = /^[a-z0-9._]{1,30}$/;
export const cleanUsername = (raw: string) => {
  const u = String(raw || '').trim().replace(/^@/, '').toLowerCase();
  return USERNAME.test(u) ? u : null;
};

/** Memecah teks berisi banyak username (dipisah spasi, koma, titik koma, atau baris baru) menjadi yang valid dan yang tidak. */
export function splitUsernames(text: string) {
  const valid = new Set<string>();
  const invalid: string[] = [];
  for (const tok of String(text || '').split(/[\s,;]+/).filter(Boolean)) {
    const u = cleanUsername(tok);
    if (u) valid.add(u);
    else invalid.push(tok.slice(0, 40));
  }
  return { valid: [...valid], invalid };
}

/**
 * Mengambil username dari file daftar followers hasil "Download your information" Instagram
 * (JSON atau HTML), atau dari teks biasa berisi satu username per baris.
 */
export function extractUsernames(text: string): string[] {
  const found = new Set<string>();
  const add = (v: unknown) => {
    const u = typeof v === 'string' ? cleanUsername(v) : null;
    if (u) found.add(u);
  };
  const fromHref = (h: unknown) => (typeof h === 'string' ? h.match(/instagram\.com\/(?:_u\/)?([A-Za-z0-9._]+)/)?.[1] : undefined);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {}
  if (json !== undefined) {
    const walk = (node: any) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.string_list_data)) {
        for (const it of node.string_list_data) add(it?.value ?? fromHref(it?.href) ?? node.title);
      } else Object.values(node).forEach(walk);
    };
    walk(json);
  } else if (/instagram\.com\//.test(text)) {
    for (const m of text.matchAll(/instagram\.com\/(?:_u\/)?([A-Za-z0-9._]+)/g)) add(m[1]);
  } else {
    for (const part of text.split(/[\s,;]+/)) add(part);
  }
  return [...found];
}

export type ParsedBid = { kind: 'abs' | 'rel' | 'ob'; value: number; sure: boolean };

// Embel-embel yang lazim di komentar bid; tidak membuat bid ditandai "perlu dicek".
const FILLER = /\b(bid|ob|open\s*bid|a?gan|om|bang|bg|mi?min|kak?|bro|boss?|pak|mas|ya|nih|deh|dong)\b/g;
const hasWords = (s: string) => /\p{L}|\d/u.test(s.replace(FILLER, ' '));

/** Membaca bid dari komentar: "150", "2.100", "+50", "bid 250k", "150 gan", "ob". null kalau bukan bid. */
export function parseBid(text: string): ParsedBid | null {
  const t = norm(text || '').replace(/@[\w.]+/g, ' ').toLowerCase().trim();
  const rel = t.match(new RegExp(`(?:^|\\s)\\+\\s*([\\d.,]*\\d)\\s*${UNIT}?(?![a-z\\d:])`));
  const abs = rel ? null : t.match(new RegExp(`(?<![\\w.,+:])([\\d.,]*\\d)\\s*${UNIT}?(?![a-z\\d:])`));
  const m = rel || abs;
  // "ob" tanpa angka berarti bid di harga open bid.
  if (!m) return /\b(ob|open\s*bid)\b/.test(t) ? { kind: 'ob', value: 0, sure: !hasWords(t) } : null;
  const value = toRb(m[1], m[2]);
  if (value == null || value <= 0) return null;
  // "Yakin" kalau selain angka hanya ada embel-embel lazim; kalau ada kata lain, perlu dicek.
  return { kind: rel ? 'rel' : 'abs', value, sure: !hasWords(t.replace(m[0], ' ')) };
}

/**
 * Menulis nominal (dalam ribuan rupiah) seperti yang biasa kamu tulis di komentar: di bawah satu juta memakai "rb"
 * (250 -> 250rb), sejuta ke atas memakai "k" (1500 -> 1.500k, yaitu Rp1.500.000).
 */
export function amountText(rb: number) {
  return rb >= 1000 ? `${rb.toLocaleString('id-ID')}k` : `${rb}rb`;
}
