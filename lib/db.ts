// Postgres: Neon di Vercel (DATABASE_URL), PGlite dalam memori untuk lokal / mode demo.

export type Row = Record<string, any>;
type Run = (text: string, params?: unknown[]) => Promise<Row[]>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS posts (
     id text PRIMARY KEY, permalink text, caption text, thumb text, posted_at timestamptz,
     title text, open_bid integer, increment integer, max_jump integer, close_at timestamptz,
     manual jsonb NOT NULL DEFAULT '{}', auto_comment boolean NOT NULL DEFAULT false,
     last_sync timestamptz, in_latest boolean NOT NULL DEFAULT true)`,
  `CREATE TABLE IF NOT EXISTS comments (
     id text PRIMARY KEY, post_id text NOT NULL, parent_id text, username text, text text,
     ts timestamptz NOT NULL, first_seen timestamptz NOT NULL, deleted_at timestamptz, override text)`,
  `CREATE INDEX IF NOT EXISTS comments_post ON comments (post_id)`,
  `CREATE TABLE IF NOT EXISTS events (
     post_id text NOT NULL, kind text NOT NULL, due_at timestamptz NOT NULL,
     status text NOT NULL DEFAULT 'pending', claimed_at timestamptz, sent_at timestamptz,
     comment_id text, error text, PRIMARY KEY (post_id, kind))`,
  `CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb)`,
  `CREATE TABLE IF NOT EXISTS bidders (username text PRIMARY KEY, verified_at timestamptz NOT NULL)`,
  // Hasil lelang yang kamu tetapkan. Judul dan jam close disalin supaya rekap tetap utuh setelah postingannya lama.
  `CREATE TABLE IF NOT EXISTS results (
     post_id text PRIMARY KEY, status text NOT NULL, username text, amount integer,
     title text, close_at timestamptz, decided_at timestamptz NOT NULL, note text)`,
  `ALTER TABLE results ADD COLUMN IF NOT EXISTS note text`,
  // auto: hasil lelang yang ditetapkan sistem (bukan keputusanmu). source: asal akun sah, 'manual' atau 'import'.
  `ALTER TABLE results ADD COLUMN IF NOT EXISTS auto boolean NOT NULL DEFAULT false`,
  `ALTER TABLE bidders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'`,
  // Balasan yang kamu kirim ke komentar bidder dari dashboard.
  `ALTER TABLE comments ADD COLUMN IF NOT EXISTS replied_at timestamptz`,
  `ALTER TABLE comments ADD COLUMN IF NOT EXISTS reply_text text`,
  `ALTER TABLE comments ADD COLUMN IF NOT EXISTS reply_auto boolean NOT NULL DEFAULT false`,
  `ALTER TABLE comments ADD COLUMN IF NOT EXISTS reply_failed_at timestamptz`,
  `ALTER TABLE comments ADD COLUMN IF NOT EXISTS reply_error text`,
];

async function connect(): Promise<Run> {
  // Mode demo selalu memakai database sementara di memori, supaya data palsu tidak pernah
  // menyentuh (atau menghapus) database asli walaupun DATABASE_URL terisi.
  const url = process.env.IG_MOCK === '1' ? undefined : process.env.DATABASE_URL || process.env.POSTGRES_URL;
  let run: Run;
  if (url) {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(url);
    run = (t, p = []) => sql.query(t, p as any[]) as Promise<Row[]>;
  } else if (process.env.NODE_ENV === 'production' && process.env.IG_MOCK !== '1') {
    throw new Error('DATABASE_URL belum diisi');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    run = async (t, p = []) => (await db.query(t, p as any[])).rows as Row[];
  }
  for (const s of SCHEMA) await run(s);
  return run;
}

const g = globalThis as unknown as { __lmDb?: Promise<Run> };

export async function q(text: string, params?: unknown[]): Promise<Row[]> {
  g.__lmDb ??= connect().catch((e) => {
    g.__lmDb = undefined;
    throw e;
  });
  return (await g.__lmDb)(text, params);
}

export async function getKv<T = any>(key: string): Promise<T | null> {
  const r = await q('SELECT value FROM kv WHERE key = $1', [key]);
  return r.length ? (r[0].value as T) : null;
}

export async function setKv(key: string, value: unknown) {
  await q(
    'INSERT INTO kv (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value)],
  );
}
