// Pemutus panggilan Instagram: kalau Meta memblokir akses API ("API access blocked"), dashboard berhenti memanggil
// Instagram supaya tidak ada percobaan berulang yang pasti gagal. Satu percobaan kecil dilakukan berkala untuk tahu
// kapan blokirnya dicabut, dan kamu bisa mencoba lagi kapan saja lewat tombol di dashboard.

export type Blocked = { at: number; until: number; message: string };

/** Jeda antar percobaan otomatis setelah terblokir (menit). Bisa diatur lewat IG_BLOCK_RETRY_MIN, bawaan 60. */
export const blockRetryMs = () => Math.max(0.05, Number(process.env.IG_BLOCK_RETRY_MIN) || 60) * 60_000;

/** Jeda singkat yang "memesan" satu percobaan, supaya panggilan serentak tidak ikut menembus bersamaan. */
export const PROBE_CLAIM_MS = 2 * 60_000;

/** Galat dari Meta yang berarti akses API diblokir (bukan sekadar token salah atau batas laju). */
export function isBlockedError(e: { message?: unknown; code?: unknown; error_subcode?: unknown } | null | undefined): boolean {
  if (!e) return false;
  return /api access blocked/i.test(String(e.message ?? '')) || (e.code === 200 && e.error_subcode === 5258005);
}

const wib = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false });

/** Pesan untuk panggilan yang dihentikan karena masih dalam masa blokir. */
export function blockedMessage(b: Blocked): string {
  return `Instagram memblokir akses API (${b.message}). Panggilan ke Instagram dihentikan sementara, percobaan otomatis berikutnya sekitar ${wib.format(b.until)} WIB. Tekan "Coba lagi sekarang" di dashboard untuk mencoba lebih awal.`;
}

/** Apakah panggilan boleh diteruskan ke Instagram: tidak ada blokir, atau masa jedanya sudah lewat (percobaan). */
export const mayCall = (b: Blocked | null, now: number) => !b || now >= b.until;
