'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { State } from '@/lib/core';

type Post = State['posts'][number];
type Row = Post['rows'][number];
type Kind = 'ten' | 'sniper' | 'close';
const KIND_LABEL: Record<Kind, string> = { ten: '10 Menit', sniper: 'Sniper Zone', close: 'Close' };

const SNIPER_MS = 5 * 60_000;
const WIB = 7 * 3_600_000;

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'short', day: 'numeric', month: 'short' });
const time = (ms: number) => timeFmt.format(ms);
const rb = (n: number | null) => (n == null ? '–' : `${n.toLocaleString('id-ID')}rb`);
const toInput = (ms: number | null) => (ms == null ? '' : new Date(ms + WIB).toISOString().slice(0, 19));
const fromInput = (s: string) => (s ? Date.parse(`${s.length === 16 ? `${s}:00` : s}Z`) - WIB : null);

function countdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)} hari`;
  if (h) return `${h}j ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const FLAGS: Record<string, string> = {
  terlambat: 'Terlambat',
  sniper: 'Sniper: belum pernah bid',
  bawahOb: 'Di bawah open bid',
  tidakNaik: 'Tidak lebih tinggi',
  kelipatan: 'Bukan kelipatan',
  maxJump: 'Lewat max jump',
  dihapus: '⚠ Terhapus',
  tanpaAcuan: 'Belum ada bid acuan',
  cek: 'Cek teks',
  balasan: 'Balasan',
};
const SOFT = ['cek', 'balasan', 'dihapus'];

async function api(path: string, body?: unknown) {
  const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') location.reload();
  if (!r.ok) throw new Error(j.error || `Gagal (${r.status})`);
  return j;
}

export function Login({ configured }: { configured: boolean }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!configured) {
    return (
      <main className="login">
        <h1>Lelang Monitor</h1>
        <p className="muted">Dashboard belum bisa dibuka: isi variabel <code>DASHBOARD_PASSWORD</code> di pengaturan Vercel, lalu deploy ulang.</p>
      </main>
    );
  }
  return (
    <main className="login">
      <h1>Lelang Monitor</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api('/api/login', { password });
            location.reload();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || !password}>{busy ? 'Memeriksa…' : 'Masuk'}</button>
      </form>
    </main>
  );
}

export function Dashboard() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [seq, setSeq] = useState<string | null>(null);
  const [showVerified, setShowVerified] = useState(false);
  const [newUser, setNewUser] = useState('');
  const [showFeed, setShowFeed] = useState(false);
  // Batas "sudah dilihat" disimpan di browser ini; aktivitas setelahnya ditandai baru.
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    let v = 0;
    try {
      v = Number(localStorage.getItem('lm_seen')) || 0;
    } catch {}
    setSeen(v || Date.now());
  }, []);
  const markSeen = () => {
    const t = Date.now() + offset.current;
    setSeen(t);
    try {
      localStorage.setItem('lm_seen', String(t));
    } catch {}
  };
  const offset = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const s: State = await api('/api/state');
      offset.current = s.now - Date.now();
      setState(s);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const act = useCallback(
    async (body: unknown) => {
      try {
        await api('/api/action', body);
      } catch (e) {
        alert((e as Error).message);
      }
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    const visible = () => document.visibilityState === 'visible';
    const tick = () => visible() && api('/api/tick', {}).catch(() => {});
    tick();
    refresh();
    const a = setInterval(() => visible() && refresh(), 4000);
    const b = setInterval(tick, 10_000);
    const c = setInterval(() => setNow(Date.now() + offset.current), 250);
    return () => [a, b, c].forEach(clearInterval);
  }, [refresh]);

  if (!state) return <main><p className="muted pad">{error || 'Memuat…'}</p></main>;

  const feed = buildFeed(state).slice(0, 60);
  const fresh = seen ? feed.filter((f) => f.t > seen).length : 0;
  const withClose = state.posts.filter((p) => p.closeAt != null && p.closeAt > now);
  const allOn = withClose.length > 0 && withClose.every((p) => p.autoComment);

  return (
    <main>
      <header>
        <div>
          <h1>Lelang Monitor</h1>
          <p className="muted">{state.me ? `@${state.me}` : 'Akun belum terhubung'}{state.mock ? ' · mode demo' : ''}</p>
        </div>
        <div className="clock" aria-label="Jam server WIB">
          <strong>{now ? time(now) : '--:--:--'}</strong>
          <span className="muted">WIB</span>
        </div>
      </header>

      {state.mock && <p className="note">Mode demo: semua data di bawah ini palsu dan tidak ada komentar yang dikirim ke Instagram.</p>}
      {!state.setup.token && <p className="note warn">Token Instagram belum diisi (<code>IG_ACCESS_TOKEN</code>). Lihat langkah di README.</p>}
      {!state.setup.cron && !state.mock && <p className="note warn">Pemicu per menit belum diatur (<code>CRON_SECRET</code>). Komentar otomatis hanya jalan selama dashboard ini terbuka.</p>}
      {(error || state.lastError) && <p className="note bad">{error || `${state.lastError!.message} (${time(state.lastError!.at)})`}</p>}

      <div className="toolbar">
        <button onClick={() => act({ type: 'reload' })}>Muat ulang postingan</button>
        <button
          disabled={!withClose.length}
          onClick={async () => {
            if (!allOn && !confirm(`Aktifkan komentar otomatis untuk ${withClose.length} lelang yang belum close?\n\n10 Menit: "${state.texts.ten}"\nSniper Zone: "${state.texts.sniper}"\nClose: "${state.texts.close}"`)) return;
            for (const p of withClose) await api('/api/action', { type: 'post', id: p.id, patch: { autoComment: !allOn } }).catch(() => {});
            refresh();
          }}
        >
          {allOn ? 'Matikan semua auto-komentar' : 'Aktifkan semua auto-komentar'}
        </button>
        <button
          aria-expanded={seq != null}
          onClick={() => {
            if (seq != null) return setSeq(null);
            const first = Math.min(...state.posts.map((p) => p.closeAt ?? Infinity));
            // Bawaan: jam close paling awal yang sudah ada, atau hari ini 19:00 WIB.
            const today = Math.floor((now + WIB) / 86_400_000) * 86_400_000 - WIB + 19 * 3_600_000;
            setSeq(toInput(Number.isFinite(first) ? first : today));
          }}
        >
          Atur jam close berurutan
        </button>
        <button
          className={fresh ? 'attn' : ''}
          aria-expanded={showFeed}
          onClick={() => {
            if (showFeed) markSeen();
            setShowFeed(!showFeed);
          }}
        >
          Aktivitas{fresh ? ` (${fresh} baru)` : ''}
        </button>
        <button aria-expanded={showVerified} onClick={() => setShowVerified(!showVerified)}>
          Akun sah ({state.verified.length})
        </button>
      </div>

      {showFeed && (
        <section className="note feed">
          <div className="rowhead">
            <strong>Aktivitas terbaru</strong>
            <button className="mini" onClick={markSeen} disabled={!fresh}>Tandai semua sudah dilihat</button>
          </div>
          {!feed.length && <p className="muted">Belum ada aktivitas.</p>}
          <ul className="vlist">
            {feed.map((f) => (
              <li key={f.key} className={`${f.tone}${f.t > seen ? ' fresh' : ''}`}>
                <button className="feeditem" onClick={() => setOpen(f.postId)}>
                  <span className="when">{time(f.t)}</span>
                  <span className="who">
                    <span>{f.text}</span>
                    <span className="muted small">{f.title}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {showVerified && (
        <section className="note verified">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newUser.trim()) return;
              await act({ type: 'verify', username: newUser, on: true });
              setNewUser('');
            }}
          >
            <label htmlFor="newuser">Tambah akun ke daftar akun sah</label>
            <span className="addrow">
              <input id="newuser" type="text" placeholder="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={newUser} onChange={(e) => setNewUser(e.target.value)} />
              <button className="primary" disabled={!newUser.trim()}>Tambah</button>
            </span>
          </form>
          {!state.verified.length && <p className="muted">Daftar masih kosong. Akun masuk ke sini saat bid-nya kamu sahkan dengan ✅.</p>}
          <ul className="vlist">
            {state.verified.map((v) => (
              <li key={v.username}>
                <span>
                  <strong>@{v.username}</strong>
                  <span className="muted small"> · sejak {dateFmt.format(v.at)}</span>
                </span>
                <button className="mini" onClick={() => confirm(`Keluarkan @${v.username} dari daftar akun sah?`) && act({ type: 'verify', username: v.username, on: false })}>
                  Keluarkan
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {seq != null && (
        <form
          className="note seq"
          onSubmit={async (e) => {
            e.preventDefault();
            const startAt = fromInput(seq);
            if (startAt == null) return;
            const n = Math.min(state.posts.length, 9);
            const last = startAt + (n - 1) * 5 * 60_000;
            if (!confirm(`Atur ulang jam close ${n} postingan terakhir?\n\nPostingan terlama close ${time(startAt)}, berikutnya tiap 5 menit, terakhir ${time(last)}.\nJam close yang sekarang akan ditimpa.`)) return;
            await act({ type: 'sequence', startAt });
            setSeq(null);
          }}
        >
          <label>
            Jam close postingan terlama (WIB). Postingan berikutnya mundur 5 menit.
            <input type="datetime-local" step="1" value={seq} onChange={(e) => setSeq(e.target.value)} required />
          </label>
          <button className="primary">Terapkan</button>
        </form>
      )}

      {!state.posts.length && <p className="muted pad">Belum ada postingan yang terbaca.</p>}
      <ul className="posts">
        {state.posts.map((p) => (
          <PostCard key={p.id} p={p} now={now} open={open === p.id} toggle={() => setOpen(open === p.id ? null : p.id)} act={act} />
        ))}
      </ul>
      {state.posts.filter((p) => p.id === open).map((p) => (
        <section key={p.id} className="post detailbox">
          <h2 className="detailtitle">{p.title}</h2>
          <Detail p={p} act={act} />
        </section>
      ))}
      {state.posts.length > 0 && !open && <p className="muted small hint">Geser ke samping untuk melihat lelang lain. Ketuk satu lelang untuk melihat bid-nya.</p>}
    </main>
  );
}

type FeedItem = { key: string; t: number; postId: string; title: string; text: string; tone: string };

/** Menyusun aktivitas dari data yang ada: bid dan komentar masuk, bid terhapus, dan komentar otomatis. */
function buildFeed(state: State): FeedItem[] {
  const out: FeedItem[] = [];
  for (const p of state.posts) {
    const add = (key: string, t: number | null | undefined, text: string, tone = '') => {
      if (t) out.push({ key: `${p.id}:${key}`, t, postId: p.id, title: p.title, text, tone });
    };
    for (const r of p.rows) {
      if (r.own) continue;
      if (r.isBid) {
        const hard = r.flags.filter((f) => !SOFT.includes(f)).map((f) => FLAGS[f]);
        add(`b${r.id}`, r.ts, `Bid ${rb(r.amount)} dari @${r.username}${hard.length ? ` · ${hard.join(', ')}` : ''}`, hard.length ? 'warn' : '');
      } else add(`c${r.id}`, r.ts, `@${r.username}: ${r.text}`, 'chat');
      if (r.deleted) add(`d${r.id}`, r.deletedAt, `@${r.username} menghapus ${r.isBid ? `bid ${rb(r.amount)}` : 'komentar'}`, 'bad');
    }
    for (const kind of ['ten', 'sniper', 'close'] as Kind[]) {
      const e = p.events[kind];
      if (!e) continue;
      if (e.status === 'sent') add(`e${kind}`, e.sentAt, `Komentar ${KIND_LABEL[kind]} terkirim`, 'ok');
      else if (e.status === 'failed') add(`e${kind}`, e.dueAt, `Komentar ${KIND_LABEL[kind]} GAGAL terkirim${e.error ? `: ${e.error}` : ''}`, 'bad');
      else if (e.status === 'missed') add(`e${kind}`, e.dueAt, `Komentar ${KIND_LABEL[kind]} tidak terkirim`, 'bad');
    }
  }
  return out.sort((a, b) => b.t - a.t);
}

function phase(p: Post, now: number) {
  if (p.closeAt == null) return { key: 'none', label: 'Jam close belum diatur' };
  const d = p.closeAt - now;
  if (d < 0) return { key: 'closed', label: 'Closed' };
  if (d <= SNIPER_MS) return { key: 'sniper', label: `Sniper Zone · ${countdown(d)}` };
  return { key: 'live', label: `Close dalam ${countdown(d)}` };
}

function EventChip({ p, kind, now }: { p: Post; kind: Kind; now: number }) {
  const e = p.events[kind];
  if (!e) return null;
  const name = KIND_LABEL[kind];
  let status = 'terjadwal';
  let tone = '';
  if (e.status === 'sent') [status, tone] = [`terkirim ${time(e.sentAt!)}`, 'ok'];
  else if (e.status === 'claimed') [status, tone] = ['bersiap…', 'warn'];
  else if (e.status === 'failed') [status, tone] = ['gagal', 'bad'];
  else if (e.status === 'missed' || e.dueAt < now - 20_000) [status, tone] = ['tidak terkirim', 'bad'];
  else if (!p.autoComment) [status, tone] = ['nonaktif', 'off'];
  return (
    <span className={`chip ${tone}`} title={e.error || undefined}>
      {name} {time(e.dueAt)} · {status}
    </span>
  );
}

/** Status jadwal komentar beserta tombol kirim manual, selama komentarnya belum terkirim. */
function EventSlot({ p, kind, now, act }: { p: Post; kind: Kind; now: number; act: (b: unknown) => Promise<void> }) {
  const e = p.events[kind];
  if (!e) return null;
  const label = KIND_LABEL[kind];
  return (
    <span className="slot">
      <EventChip p={p} kind={kind} now={now} />
      {e.status !== 'sent' && e.status !== 'claimed' && (
        <button className="mini" onClick={() => confirm(`Kirim komentar ${label} ke "${p.title}" sekarang?`) && act({ type: 'send', id: p.id, kind })}>
          Kirim
        </button>
      )}
      {e.status === 'sent' && (
        <button
          className="mini"
          title="Jadwalkan ulang komentar ini"
          onClick={() =>
            confirm(`Jadwalkan ulang komentar ${label} untuk "${p.title}"?\n\nPakai ini kalau komentar tadi hanya uji coba dan sudah kamu hapus di Instagram. Kalau komentarnya masih ada, komentar ini akan terkirim dua kali.`) &&
            act({ type: 'reset', id: p.id, kind })
          }
        >
          Ulang
        </button>
      )}
    </span>
  );
}

function PostCard({ p, now, open, toggle, act }: { p: Post; now: number; open: boolean; toggle: () => void; act: (b: unknown) => Promise<void> }) {
  const ph = phase(p, now);
  const bids = p.rows.filter((r) => r.isBid);
  // Perlu dicek: belum kamu putuskan, dan akunnya belum ada di daftar akun sah atau ada penanda.
  const check = bids.filter((r) => !r.override && (!r.verified || r.flags.length > 0)).length;
  return (
    <li className={`post ${ph.key}${open ? ' open' : ''}`}>
      <button className="summary" onClick={toggle} aria-expanded={open}>
        {p.thumb ? <img src={p.thumb} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <span className="thumb" />}
        <span className="info">
          <span className="title">{p.title}</span>
          <span className={`phase ${ph.key}`}>{ph.label}</span>
          <span className="muted small">{p.closeAt != null ? `${dateFmt.format(p.closeAt)} · ${time(p.closeAt)}` : 'Atur jam close di detail'}</span>
        </span>
        <span className="top">
          <strong>{p.top ? rb(p.top.amount) : '–'}</strong>
          <span className="muted small">{p.top ? `@${p.top.username}` : 'belum ada bid'}</span>
          <span className="muted small">{bids.length} bid{check ? ` · ${check} perlu dicek` : ''}</span>
        </span>
      </button>

      <div className="chips">
        <EventSlot p={p} kind="ten" now={now} act={act} />
        <EventSlot p={p} kind="sniper" now={now} act={act} />
        <EventSlot p={p} kind="close" now={now} act={act} />
        <label className="switch">
          <input type="checkbox" checked={p.autoComment} disabled={p.closeAt == null} onChange={(e) => act({ type: 'post', id: p.id, patch: { autoComment: e.target.checked } })} />
          Auto-komentar
        </label>
      </div>

    </li>
  );
}

function Detail({ p, act }: { p: Post; act: (b: unknown) => Promise<void> }) {
  const [all, setAll] = useState(false);
  const [form, setForm] = useState({ closeAt: toInput(p.closeAt), openBid: p.openBid ?? '', increment: p.increment ?? '', maxJump: p.maxJump ?? '' });
  const rows = p.rows.filter((r) => all || r.isBid);
  const num = (v: string | number) => (v === '' ? null : Number(v));
  const field = (key: 'openBid' | 'increment' | 'maxJump', label: string) => (
    <label>
      {label}
      <input type="number" inputMode="numeric" min="0" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>
  );
  return (
    <div className="detail">
      <div className="rowhead">
        <h2>Bid ({p.rows.filter((r) => r.isBid).length})</h2>
        <label className="switch">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Semua komentar
        </label>
      </div>
      {!rows.length && <p className="muted">Belum ada {all ? 'komentar' : 'bid'}.</p>}
      <ul className="bids">
        {rows.map((r) => (
          <BidRow key={r.id} r={r} top={p.top?.ts === r.ts && p.top?.username === r.username && r.valid && r.amount === p.top?.amount} act={act} />
        ))}
      </ul>

      <h2>Aturan lelang <span className="muted small">(nominal dalam ribuan)</span></h2>
      <form
        className="rules"
        onSubmit={(e) => {
          e.preventDefault();
          act({ type: 'post', id: p.id, patch: { closeAt: fromInput(form.closeAt), openBid: num(form.openBid), increment: num(form.increment), maxJump: num(form.maxJump) } });
        }}
      >
        <label className="wide">
          Jam close (WIB)
          <input type="datetime-local" step="1" value={form.closeAt} onChange={(e) => setForm({ ...form, closeAt: e.target.value })} />
        </label>
        {field('openBid', 'Open bid')}
        {field('increment', 'Kelipatan')}
        {field('maxJump', 'Max jump')}
        <button className="primary wide">Simpan aturan lelang</button>
      </form>

      <div className="toolbar">
        <a href={p.permalink} target="_blank" rel="noreferrer">Buka di Instagram</a>
      </div>
    </div>
  );
}

function BidRow({ r, top, act }: { r: Row; top: boolean; act: (b: unknown) => Promise<void> }) {
  const set = (value: 'valid' | 'invalid') => act({ type: 'override', id: r.id, value: r.override === value ? null : value });
  return (
    <li className={`${r.isBid ? (r.valid ? 'valid' : 'invalid') : 'chat'}${top ? ' leader' : ''}`}>
      <span className="when">{time(r.ts)}</span>
      <span className="who">
        <span className="user">
          @{r.username}{r.own ? ' (kamu)' : ''}
          {r.isBid && r.verified && (
            <button
              className="trusted"
              title="Akun ini ada di daftar akun sah. Ketuk untuk mengeluarkannya."
              onClick={() => confirm(`Keluarkan @${r.username} dari daftar akun sah?`) && act({ type: 'verify', username: r.username, on: false })}
            >
              ✓ Akun sah
            </button>
          )}
        </span>
        <span className="text">{r.text}</span>
        {r.isBid && (r.flags.length > 0 || r.override || !r.verified) && (
          <span className="flags">
            {r.override && <span className="flag manual">{r.override === 'valid' ? 'Disahkan' : 'Ditolak'}</span>}
            {!r.override && !r.verified && <span className="flag soft">Belum dicek</span>}
            {r.flags.map((f) => <span key={f} className={`flag${SOFT.includes(f) ? ' soft' : ''}`}>{FLAGS[f]}</span>)}
          </span>
        )}
      </span>
      {r.isBid && (
        <span className="amount">
          <strong>{rb(r.amount)}</strong>
          <span className="decide">
            <button className={r.override === 'valid' ? 'on ok' : ''} onClick={() => set('valid')} aria-label="Sah" title="Sah: bid dihitung, akun masuk daftar akun sah" aria-pressed={r.override === 'valid'}>✅</button>
            <button className={r.override === 'invalid' || r.override === 'wrong' ? 'on bad' : ''} onClick={() => set('invalid')} aria-label="Tolak" title="Tolak: bid ini tidak dihitung" aria-pressed={r.override === 'invalid'}>❌</button>
          </span>
        </span>
      )}
    </li>
  );
}
