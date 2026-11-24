'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { State } from '@/lib/core';
import { amountText, extractUsernames } from '@/lib/parse';

type Post = State['posts'][number];
type Row = Post['rows'][number];
type Kind = 'ten' | 'sniper' | 'close';
const KIND_LABEL: Record<Kind, string> = { ten: '10 Menit', sniper: 'Sniper Zone', close: 'Close' };

const SNIPER_MS = 5 * 60_000;
const WIB = 7 * 3_600_000;

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'short', day: 'numeric', month: 'short' });
const time = (ms: number) => timeFmt.format(ms);
// Nominal di dashboard memakai penulisan yang sama dengan pesan: 250rb di bawah sejuta, 1.500k untuk sejuta ke atas.
const rb = (n: number | null) => (n == null ? '–' : amountText(n));
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
  dihapus: '⚠ Terhapus · otomatis tidak sah',
  tanpaAcuan: 'Belum ada bid acuan',
  cek: 'Cek teks',
  balasan: 'Balasan',
};
const SOFT = ['cek', 'balasan'];

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
  const [feedView, setFeedView] = useState<'bid' | 'auto' | null>(null);
  const [showWinners, setShowWinners] = useState(false);
  // Batas "sudah dilihat" disimpan di browser ini, terpisah untuk notifikasi bid dan notifikasi otomasi.
  const [seenBid, setSeenBid] = useState(0);
  const [seenAuto, setSeenAuto] = useState(0);
  const [focus, setFocus] = useState<{ postId: string; rowId?: string; n: number } | null>(null);
  useEffect(() => {
    const read = (k: string) => {
      try {
        return Number(localStorage.getItem(`lm_seen_${k}`) || localStorage.getItem('lm_seen')) || 0;
      } catch {
        return 0;
      }
    };
    setSeenBid(read('bid') || Date.now());
    setSeenAuto(read('auto') || Date.now());
  }, []);
  const markSeen = (kind: 'bid' | 'auto') => {
    const t = Date.now() + offset.current;
    (kind === 'bid' ? setSeenBid : setSeenAuto)(t);
    try {
      localStorage.setItem(`lm_seen_${kind}`, String(t));
    } catch {}
  };
  const toggleFeed = (kind: 'bid' | 'auto') => {
    if (feedView) markSeen(feedView);
    setFeedView(feedView === kind ? null : kind);
  };
  // Mengetuk notifikasi: panel ditutup, lelangnya dibuka dan kartunya digulir ke layar, lalu bid-nya disorot.
  const pick = (f: FeedItem) => {
    markSeen(f.kind);
    setFeedView(null);
    setOpen(f.postId);
    setFocus({ postId: f.postId, rowId: f.rowId, n: Date.now() });
  };
  useEffect(() => {
    if (!focus) return;
    const t1 = setTimeout(() => {
      document.getElementById(`card-${focus.postId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'center' });
    }, 80);
    const t2 = setTimeout(() => {
      const row = focus.rowId ? document.getElementById(`bid-${focus.rowId}`) : null;
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      row.classList.remove('flash');
      void row.offsetWidth; // memulai ulang animasi kalau disorot lagi
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 3000);
    }, 650);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [focus]);
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

  const allFeed = buildFeed(state);
  const feedBid = allFeed.filter((f) => f.kind === 'bid').slice(0, 60);
  const feedAuto = allFeed.filter((f) => f.kind === 'auto').slice(0, 60);
  const freshBid = seenBid ? feedBid.filter((f) => f.t > seenBid).length : 0;
  const freshAuto = seenAuto ? feedAuto.filter((f) => f.t > seenAuto).length : 0;
  const withClose = state.posts.filter((p) => p.closeAt != null && p.closeAt > now);
  const allOn = withClose.length > 0 && withClose.every((p) => p.autoComment);

  return (
    <main>
      <header>
        <div>
          <h1>Lelang Monitor</h1>
          <p className="muted">{state.me ? `@${state.me}` : 'Akun belum terhubung'}{state.mock ? ' · mode demo' : ''}</p>
        </div>
        <div className="headright">
          <div className="clock" aria-label="Jam server WIB">
            <strong>{now ? time(now) : '--:--:--'}</strong>
            <span className="muted">WIB</span>
          </div>
          <button className="iconbtn" onClick={() => location.reload()} aria-label="Muat ulang halaman" title="Muat ulang halaman (ambil versi terbaru)">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
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
          className={state.autoReply.on ? 'on-switch' : ''}
          aria-pressed={state.autoReply.on}
          onClick={() => {
            if (!state.autoReply.on && !confirm('Nyalakan balasan otomatis?\n\nBid berawalan "+" dari akun sah yang berstatus "Disahkan otomatis" dan masuk SETELAH ini akan langsung dibalas di Instagram dengan "bid [total] sah yaa". Bid yang sudah ada tidak dibalas. Bid dari akun di luar daftar tetap tidak dibalas sampai kamu sahkan.')) return;
            act({ type: 'autoreply', on: !state.autoReply.on });
          }}
        >
          Auto-balas bid +: {state.autoReply.on ? 'nyala' : 'mati'}
        </button>
        <button
          className={state.autoDm.on ? 'on-switch' : ''}
          aria-pressed={state.autoDm.on}
          onClick={() => {
            if (!state.autoDm.on && !confirm('Nyalakan DM otomatis ke pemenang?\n\nSetelah lelang close dan pemenangnya ditetapkan, pemenang dikirimi DM "' + state.dmTemplate.replace('{barang}', '[nama barang]').replace('{harga}', '[harga menang]') + '" sekitar ' + (state.dmDelaySec >= 60 ? `${Math.round(state.dmDelaySec / 60)} menit` : `${Math.round(state.dmDelaySec)} detik`) + ' kemudian, hanya kalau bid kemenangannya sudah disahkan, harganya pasti, dan tidak melanggar aturan lelang. Bid yang masih perlu kamu cek tidak memicu DM. Hanya lelang yang close SETELAH ini yang diproses. DM tidak bisa ditarik kembali, jadi periksa pemenang dalam masa tenang itu: mengubah hasil lelang membatalkan DM yang belum terkirim.')) return;
            act({ type: 'autodm', on: !state.autoDm.on });
          }}
        >
          Auto-DM pemenang: {state.autoDm.on ? 'nyala' : 'mati'}
        </button>
        <button className={freshBid ? 'attn' : ''} aria-expanded={feedView === 'bid'} onClick={() => toggleFeed('bid')}>
          Notif bid{freshBid ? ` (${freshBid} baru)` : ''}
        </button>
        <button className={freshAuto ? 'attn' : ''} aria-expanded={feedView === 'auto'} onClick={() => toggleFeed('auto')}>
          Notif otomasi{freshAuto ? ` (${freshAuto} baru)` : ''}
        </button>
        <button aria-expanded={showWinners} onClick={() => setShowWinners(!showWinners)}>
          Pemenang ({state.results.filter((r) => r.status === 'winner').length})
        </button>
        <button aria-expanded={showVerified} onClick={() => setShowVerified(!showVerified)}>
          Akun sah ({state.verifiedCount})
        </button>
      </div>

      {feedView === 'bid' && <FeedPanel title="Notifikasi bid" items={feedBid} seen={seenBid} onSeen={() => markSeen('bid')} onPick={pick} />}
      {feedView === 'auto' && <FeedPanel title="Notifikasi otomasi komentar" items={feedAuto} seen={seenAuto} onSeen={() => markSeen('auto')} onPick={pick} />}

      {showWinners && <Winners results={state.results} />}

      {showVerified && <VerifiedPanel count={state.verifiedCount} act={act} />}

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
          <PostCard key={p.id} p={p} result={state.results.find((r) => r.postId === p.id)} now={now} open={open === p.id} toggle={() => setOpen(open === p.id ? null : p.id)} act={act} />
        ))}
      </ul>
      {state.posts.filter((p) => p.id === open).map((p) => (
        <section key={p.id} className="post detailbox">
          <h2 className="detailtitle">{p.title}</h2>
          <Detail p={p} result={state.results.find((r) => r.postId === p.id)} act={act} />
        </section>
      ))}
      {state.posts.length > 0 && !open && <p className="muted small hint">Geser ke samping untuk melihat lelang lain. Ketuk satu lelang untuk melihat bid-nya.</p>}
    </main>
  );
}

type FeedItem = { key: string; t: number; postId: string; title: string; text: string; tone: string; kind: 'bid' | 'auto'; rowId?: string };

/** Menyusun notifikasi: kelompok "bid" (bid dan komentar masuk, bid terhapus) dan "auto" (komentar dan balasan otomatis). */
function buildFeed(state: State): FeedItem[] {
  const out: FeedItem[] = [];
  for (const p of state.posts) {
    const add = (key: string, t: number | null | undefined, text: string, tone = '', kind: 'bid' | 'auto' = 'bid', rowId?: string) => {
      if (t) out.push({ key: `${p.id}:${key}`, t, postId: p.id, title: p.title, text, tone, kind, rowId });
    };
    for (const r of p.rows) {
      if (r.own) continue;
      if (r.isBid) {
        const hard = r.flags.filter((f) => !SOFT.includes(f)).map((f) => FLAGS[f]);
        add(`b${r.id}`, r.ts, `Bid ${rb(r.amount)} dari @${r.username}${hard.length ? ` · ${hard.join(', ')}${r.autoRejected ? ' · ditolak otomatis' : ''}` : ''}`, hard.length ? 'warn' : '', 'bid', r.id);
      } else add(`c${r.id}`, r.ts, `@${r.username}: ${r.text}`, 'chat', 'bid', r.id);
      if (r.deleted) add(`d${r.id}`, r.deletedAt, `@${r.username} menghapus ${r.isBid ? `bid ${rb(r.amount)}` : 'komentar'}`, 'bad', 'bid', r.id);
      if (r.repliedAuto && r.repliedAt) add(`ra${r.id}`, r.repliedAt, `Balasan otomatis terkirim ke @${r.username} (bid ${rb(r.amount)})`, 'ok', 'auto', r.id);
      if (r.replyFailedAt) add(`rf${r.id}`, r.replyFailedAt, `Balasan otomatis ke @${r.username} GAGAL${r.replyError ? `: ${r.replyError}` : ''}`, 'bad', 'auto', r.id);
    }
    for (const kind of ['ten', 'sniper', 'close'] as Kind[]) {
      const e = p.events[kind];
      if (!e) continue;
      if (e.status === 'sent') add(`e${kind}`, e.sentAt, `Komentar ${KIND_LABEL[kind]} terkirim`, 'ok', 'auto');
      else if (e.status === 'failed') add(`e${kind}`, e.dueAt, `Komentar ${KIND_LABEL[kind]} GAGAL terkirim${e.error ? `: ${e.error}` : ''}`, 'bad', 'auto');
      else if (e.status === 'missed') add(`e${kind}`, e.dueAt, `Komentar ${KIND_LABEL[kind]} tidak terkirim`, 'bad', 'auto');
      else if (e.status === 'skipped') add(`e${kind}`, e.dueAt, `Komentar ${KIND_LABEL[kind]} dilewati${e.error ? ` (${e.error})` : ''}`, 'chat', 'auto');
    }
  }
  for (const r of state.results) {
    if (r.status !== 'winner' || !r.dm) continue;
    const base = { postId: r.postId, title: r.title, kind: 'auto' as const };
    if (r.dm.status === 'sent' && r.dm.at) out.push({ ...base, key: `${r.postId}:dm`, t: r.dm.at, text: `DM pemenang terkirim ke @${r.dm.username}${r.dm.auto ? ' (otomatis)' : ''}`, tone: 'ok' });
    else if (r.dm.status === 'failed' && r.dm.at) out.push({ ...base, key: `${r.postId}:dm`, t: r.dm.at, text: `DM pemenang ke @${r.dm.username} GAGAL${r.dm.error ? `: ${r.dm.error}` : ''}`, tone: 'bad' });
  }
  return out.sort((a, b) => b.t - a.t);
}

/** Daftar notifikasi. Mengetuk satu baris membuka kartu lelangnya (dan menyorot bid-nya kalau ada). */
function FeedPanel({ title, items, seen, onSeen, onPick }: { title: string; items: FeedItem[]; seen: number; onSeen: () => void; onPick: (f: FeedItem) => void }) {
  const fresh = seen ? items.filter((f) => f.t > seen).length : 0;
  return (
    <section className="note feed">
      <div className="rowhead">
        <strong>{title}</strong>
        <button className="mini" onClick={onSeen} disabled={!fresh}>Tandai semua sudah dilihat</button>
      </div>
      {!items.length && <p className="muted">Belum ada.</p>}
      {items.length > 0 && <p className="muted small">Ketuk satu untuk membuka lelangnya.</p>}
      <ul className="vlist">
        {items.map((f) => (
          <li key={f.key} className={`${f.tone}${f.t > seen ? ' fresh' : ''}`}>
            <button className="feeditem" onClick={() => onPick(f)}>
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
  );
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
  // Waktu tayang di Instagram (kalau sudah terbaca) lebih tepat daripada saat Instagram membalas permintaan kirim.
  if (e.status === 'sent') [status, tone] = [e.igAt ? `tayang ${time(e.igAt)}` : `terkirim ${time(e.sentAt!)}`, 'ok'];
  else if (e.status === 'claimed') [status, tone] = ['bersiap…', 'warn'];
  else if (e.status === 'failed') [status, tone] = ['gagal', 'bad'];
  else if (e.status === 'skipped') [status, tone] = ['dilewati, bid kurang', 'off'];
  else if (e.status === 'missed' || e.dueAt < now - 20_000) [status, tone] = ['tidak terkirim', 'bad'];
  else if (!p.autoComment) [status, tone] = ['nonaktif', 'off'];
  return (
    <span className={`chip ${tone}`} title={e.error || (e.status === 'sent' ? `Instagram membalas permintaan kirim pukul ${time(e.sentAt!)}${e.igAt ? `; komentar tayang pukul ${time(e.igAt)}` : ''}` : undefined)}>
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

function PostCard({ p, result, now, open, toggle, act }: { p: Post; result?: State['results'][number]; now: number; open: boolean; toggle: () => void; act: (b: unknown) => Promise<void> }) {
  const ph = phase(p, now);
  const bids = p.rows.filter((r) => r.isBid);
  // Perlu dicek: belum kamu putuskan, dan akunnya belum ada di daftar akun sah atau ada penanda.
  // Bid yang sudah otomatis ditolak (melanggar aturan) tidak perlu dicek lagi.
  const check = bids.filter((r) => !r.override && !r.autoApproved && !r.autoRejected).length;
  return (
    <li id={`card-${p.id}`} className={`post ${ph.key}${open ? ' open' : ''}`}>
      <button className="summary" onClick={toggle} aria-expanded={open}>
        {p.thumb ? <img src={p.thumb} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <span className="thumb" />}
        <span className="info">
          <span className="title">{p.title}</span>
          <span className={`phase ${ph.key}`}>{ph.label}</span>
          {result && <span className="small won">{result.status === 'winner' ? `🏆 @${result.username} · ${rb(result.amount)}` : 'No Winner'}</span>}
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
        {result?.status === 'winner' && result.dm?.status === 'sent' && result.dm.username === result.username && (
          <span className="chip ok">✉ DM terkirim {time(result.dm.at!)}{result.dm.auto ? ' (otomatis)' : ''}</span>
        )}
        {result?.status === 'winner' && result.dm?.status === 'failed' && <span className="chip bad" title={result.dm.error || undefined}>✉ DM gagal</span>}
        {result?.status === 'winner' && !(result.dm?.status === 'sent' && result.dm.username === result.username) && result.dm?.status !== 'sending' && (
          <button className="mini" onClick={() => askAndSendDm(p.id, result, act)} title={`Kirim DM ke @${result.username}`}>✉ Kirim DM</button>
        )}
        <label className="switch">
          <input type="checkbox" checked={p.autoComment} disabled={p.closeAt == null} onChange={(e) => act({ type: 'post', id: p.id, patch: { autoComment: e.target.checked } })} />
          Auto-komentar
        </label>
      </div>

    </li>
  );
}

type Result = State['results'][number];

/** Kotak konfirmasi kirim DM ke pemenang (teks bisa diedit), dipakai di kartu dan di detail lelang. */
async function askAndSendDm(postId: string, result: Result, act: (b: unknown) => Promise<void>) {
  const text = prompt(`Kirim DM ke @${result.username} lewat komentar bid-nya di Instagram (teks bisa diedit, OK untuk mengirim):`, result.dmText);
  if (!text || !text.trim()) return;
  await act({ type: 'dm', id: postId, text: text.trim() });
}

/** Daftar akun sah: cari, tambah satu, impor dari file followers, dan keluarkan. Daftarnya dimuat saat panel dibuka. */
function VerifiedPanel({ count, act }: { count: number; act: (b: unknown) => Promise<void> }) {
  const [list, setList] = useState<{ username: string; at: number; source: 'manual' | 'import' }[] | null>(null);
  const [find, setFind] = useState('');
  const [newUser, setNewUser] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api('/api/verified').then((j) => setList(j.list)).catch((e) => setMsg(String(e.message))), []);
  useEffect(() => {
    load();
  }, [load, count]);

  const importFile = async (file: File) => {
    setMsg('Membaca file…');
    try {
      const usernames = extractUsernames(await file.text());
      if (!usernames.length) return setMsg('Tidak ada username yang terbaca dari file itu.');
      if (!confirm(`Terbaca ${usernames.length.toLocaleString('id-ID')} username dari file.\n\nMasukkan semuanya ke daftar akun sah?`)) return setMsg('');
      const r = await api('/api/action', { type: 'import', usernames });
      setMsg(`${r.added.toLocaleString('id-ID')} akun baru ditambahkan (${(r.found - r.added).toLocaleString('id-ID')} sudah ada di daftar).`);
      load();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  };

  const q = find.trim().replace(/^@/, '').toLowerCase();
  const importedCount = (list || []).filter((v) => v.source === 'import').length;
  const shown = (list || []).filter((v) => !q || v.username.includes(q));
  return (
    <section className="note verified">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!newUser.trim()) return;
          try {
            const r = await api('/api/action', { type: 'addmany', text: newUser });
            const parts = [`${r.added} akun ditambahkan`];
            if (r.found - r.added > 0) parts.push(`${r.found - r.added} sudah ada di daftar${r.upgraded ? ` (${r.upgraded} dinaikkan dari impor menjadi akun sah biasa)` : ''}`);
            if (r.invalid.length) parts.push(`${r.invalid.length} tidak valid dan dilewati: ${r.invalid.join(', ')}`);
            setMsg(parts.join('. ') + '.');
            if (!r.invalid.length) setNewUser('');
            else setNewUser(r.invalid.join('\n'));
            load();
          } catch (err) {
            setMsg(String((err as Error).message));
          }
        }}
      >
        <label htmlFor="newuser">Tambah akun ke daftar akun sah (boleh banyak: pisahkan dengan spasi, koma, atau baris baru)</label>
        <textarea id="newuser" className="textin" rows={4} placeholder="username1 username2&#10;@username3" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={newUser} onChange={(e) => setNewUser(e.target.value)} />
        <button className="primary" disabled={!newUser.trim()}>Tambah</button>
      </form>
      <div>
        <label htmlFor="importfile">Impor dari file followers Instagram (followers_1.json atau .html)</label>
        <input id="importfile" type="file" accept=".json,.html,.htm,.txt,.csv" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f); }} />
      </div>
      {msg && <p className="small" role="status">{msg}</p>}
      <div>
        <label htmlFor="findverified">Cari di daftar ({count.toLocaleString('id-ID')} akun)</label>
        <input id="findverified" className="textin" type="search" placeholder="ketik sebagian username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={find} onChange={(e) => setFind(e.target.value)} />
      </div>
      {list && !list.length && <p className="muted">Daftar masih kosong. Akun masuk ke sini saat bid-nya kamu sahkan dengan ✅.</p>}
      {!list && <p className="muted">Memuat daftar…</p>}
      {importedCount > 0 && (
        <button
          onClick={async () => {
            if (!confirm(`Keluarkan ${importedCount.toLocaleString('id-ID')} akun hasil impor dari daftar akun sah?\n\nAkun yang kamu sahkan sendiri dengan ✅ atau kamu tambahkan manual tidak ikut dikeluarkan.`)) return;
            const r = await api('/api/action', { type: 'unimport' }).catch((e) => ({ removed: 0, error: e.message }));
            setMsg(r.error ? String(r.error) : `${Number(r.removed).toLocaleString('id-ID')} akun hasil impor dikeluarkan.`);
            await act({ type: 'noop' }).catch(() => {});
            load();
          }}
        >
          Batalkan impor ({importedCount.toLocaleString('id-ID')} akun)
        </button>
      )}
      <ul className="vlist">
        {shown.slice(0, 100).map((v) => (
          <li key={v.username}>
            <span>
              <strong>@{v.username}</strong>
              <span className="muted small"> · {v.source === 'import' ? 'impor' : 'sah'} sejak {dateFmt.format(v.at)}</span>
            </span>
            <button className="mini" onClick={async () => { if (!confirm(`Keluarkan @${v.username} dari daftar akun sah?`)) return; await act({ type: 'verify', username: v.username, on: false }); load(); }}>
              Keluarkan
            </button>
          </li>
        ))}
      </ul>
      {shown.length > 100 && <p className="muted small">Menampilkan 100 dari {shown.length.toLocaleString('id-ID')} akun. Pakai kolom cari untuk menemukan akun tertentu.</p>}
    </section>
  );
}

/** Penetapan hasil lelang: pemenang dipilih dari pemilik bid sah (usulan: yang tertinggi), atau "No Winner". Bisa diubah kapan saja. */
function ResultBox({ p, result, act }: { p: Post; result?: Result; act: (b: unknown) => Promise<void> }) {
  // Bid sah tertinggi tiap akun, dari yang terbesar.
  const best = new Map<string, number>();
  for (const r of p.rows) if (r.isBid && r.valid && r.amount != null) best.set(r.username, Math.max(best.get(r.username) ?? 0, r.amount));
  const candidates = [...best].sort((a, b) => b[1] - a[1]);
  const [pick, setPick] = useState('');
  const [editing, setEditing] = useState(false);
  const chosen = candidates.find(([u]) => u === pick) || candidates.find(([u]) => u !== result?.username) || candidates[0];
  const prev = result?.status === 'winner' ? result.username : null;
  const save = async (body: Record<string, unknown>) => {
    await act({ type: 'result', id: p.id, ...body });
    setEditing(false);
    setPick('');
  };

  const summary = result && (
    <div className="result set">
      <span>
        <span className="muted small">Hasil lelang</span>
        <strong>{result.status === 'winner' ? `🏆 @${result.username} · ${rb(result.amount)}` : 'No Winner'}</strong>
        {result.note && <span className="small">{result.note}</span>}
        {result.auto && <span className="muted small">Ditetapkan sistem. Tekan Ubah kalau perlu diganti.</span>}
        {result.status === 'winner' && result.dm?.status === 'sent' && result.dm.username === result.username && (
          <span className="small won">✉ DM terkirim {time(result.dm.at!)}{result.dm.auto ? ' (otomatis)' : ''}</span>
        )}
        {result.status === 'winner' && result.dm?.status === 'sent' && result.dm.username !== result.username && (
          <span className="small warnline">⚠ DM sudah terkirim ke @{result.dm.username}, tapi pemenangnya sekarang @{result.username}. DM tidak bisa ditarik kembali.</span>
        )}
        {result.status === 'winner' && result.dm?.status === 'failed' && (
          <span className="small warnline" title={result.dm.error || undefined}>⚠ DM ke @{result.dm.username} gagal{result.dm.error ? `: ${result.dm.error}` : ''}</span>
        )}
        {result.status === 'winner' && result.dm?.status === 'sending' && <span className="muted small">DM sedang dikirim…</span>}
        {result.status === 'winner' && !(result.dm?.status === 'sent' && result.dm.username === result.username) && (
          <button
            className="mini dmbtn"
            onClick={() => askAndSendDm(p.id, result, act)}
          >
            ✉ Kirim DM
          </button>
        )}
      </span>
      <button className="mini" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? 'Batal' : 'Ubah'}</button>
    </div>
  );
  if (result && !editing) return summary;
  if (!result && (p.closeAt == null || p.closeAt > Date.now())) return null;
  return (
    <>
      {summary}
      <div className="result">
        <h2>{result ? 'Ubah hasil lelang' : 'Tetapkan hasil lelang'}</h2>
        {candidates.length > 0 ? (
          <div className="resultrow">
            <select aria-label="Pilih pemenang" value={chosen[0]} onChange={(e) => setPick(e.target.value)}>
              {candidates.map(([u, a], i) => (
                <option key={u} value={u}>{`@${u} · ${rb(a)}${i === 0 ? ' (bid sah tertinggi)' : ''}${u === prev ? ' (pemenang sekarang)' : ''}`}</option>
              ))}
            </select>
            <button className="primary" onClick={() => confirm(`Tetapkan @${chosen[0]} sebagai pemenang dengan ${rb(chosen[1])}?`) && save({ status: 'winner', username: chosen[0], amount: chosen[1], note: prev && prev !== chosen[0] ? `Menggantikan @${prev}` : undefined })}>
              {result ? 'Ganti pemenang' : 'Tetapkan pemenang'}
            </button>
          </div>
        ) : (
          <p className="muted">Belum ada bid sah di lelang ini.</p>
        )}
        <div className="resultrow">
          {prev && (
            <button onClick={() => confirm(`Tetapkan No Winner dan catat @${prev} sebagai Bid & Run?`) && save({ status: 'none', note: `Bid & Run: @${prev}` })}>
              No Winner · @{prev} Bid &amp; Run
            </button>
          )}
          <button onClick={() => confirm('Tetapkan lelang ini sebagai No Winner?') && save({ status: 'none' })}>No Winner</button>
          {result && !result.auto && <button onClick={() => confirm('Kembalikan hasil lelang ini ke otomatis? Keputusan manualmu dihapus, lalu sistem menetapkan pemenang bawaannya lagi kalau syaratnya terpenuhi.') && save({ status: null })}>Kembalikan ke otomatis</button>}
        </div>
      </div>
    </>
  );
}

/** Rekap pemenang: satu baris per akun, dengan jumlah menang, total nominal, dan barang yang dimenangkan. */
function Winners({ results }: { results: Result[] }) {
  const byUser = new Map<string, Result[]>();
  for (const r of results) if (r.status === 'winner' && r.username) byUser.set(r.username, [...(byUser.get(r.username) || []), r]);
  const rows = [...byUser].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const none = results.filter((r) => r.status === 'none');
  return (
    <section className="note winners">
      <strong>Rekap pemenang</strong>
      {!rows.length && <p className="muted">Belum ada pemenang yang ditetapkan. Buka lelang yang sudah close, lalu tekan "Tetapkan pemenang".</p>}
      {rows.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th>Akun</th><th className="num">Total win</th><th className="num">Total nilai</th><th>Barang yang dimenangkan</th></tr>
            </thead>
            <tbody>
              {rows.map(([u, list]) => (
                <tr key={u}>
                  <td><strong>@{u}</strong></td>
                  <td className="num">{list.length}</td>
                  <td className="num">{rb(list.reduce((s, r) => s + (r.amount || 0), 0))}</td>
                  <td>
                    <ul>
                      {list.map((r) => (
                        <li key={r.postId}>{r.title} <span className="muted small">· {rb(r.amount)}{r.closeAt ? ` · ${dateFmt.format(r.closeAt)}` : ''}{r.auto ? ' · otomatis' : r.note ? ` · ${r.note}` : ''}{r.dm?.status === 'sent' && r.dm.username === r.username ? ' · DM terkirim' : ''}</span></li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {none.length > 0 && (
        <p className="small">
          <strong>No Winner ({none.length}):</strong> <span className="muted">{none.map((r) => `${r.title}${r.note ? ` (${r.note})` : ''}`).join(' · ')}</span>
        </p>
      )}
    </section>
  );
}

function Detail({ p, result, act }: { p: Post; result?: Result; act: (b: unknown) => Promise<void> }) {
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

      <ResultBox p={p} result={result} act={act} />

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
        <button
          title="Uji kirim DM (isi DM pemenang + tautan postingan) ke akun lain, tanpa menetapkan pemenang"
          onClick={async () => {
            const user = prompt('Tes DM: kirim ke akun mana? Akun itu harus sudah berkomentar di postingan ini. Tulis username-nya saja, tanpa @.', '');
            if (!user || !user.trim()) return;
            try {
              const pv = await api('/api/action', { type: 'testdm', id: p.id, username: user, preview: true });
              const text = prompt(`Komentar @${pv.username} yang akan dibalas: "${pv.comment}"\n\nIsi DM (bisa diedit, OK untuk mengirim ke @${pv.username}):`, pv.text);
              if (!text || !text.trim()) return;
              await api('/api/action', { type: 'testdm', id: p.id, username: user, text: text.trim() });
              alert(`DM tes terkirim. Cek DM atau permintaan pesan di akun @${pv.username}.`);
            } catch (e) {
              alert((e as Error).message);
            }
          }}
        >
          🧪 Tes DM
        </button>
        <a href={p.permalink} target="_blank" rel="noreferrer">Buka di Instagram</a>
      </div>
    </div>
  );
}

function BidRow({ r, top, act }: { r: Row; top: boolean; act: (b: unknown) => Promise<void> }) {
  // Membalas komentar bidder di Instagram. Teksnya bisa diedit dulu; OK berarti terkirim.
  const reply = async () => {
    const thread = r.parentId ? `@${r.username} ` : '';
    const warn = r.solid ? '' : '\n\nPERHATIAN: total ini bergantung pada bid sebelumnya yang belum kamu cek. Kalau bid itu nanti kamu tolak, total ini berubah.';
    const text = prompt(`Balas komentar @${r.username} di Instagram (teks bisa diedit, OK untuk mengirim):${warn}`, `${thread}bid ${r.amount == null ? '' : amountText(r.amount)} sah yaa`);
    if (!text || !text.trim()) return;
    if (r.repliedAt && !confirm('Komentar ini sudah pernah kamu balas. Kirim balasan lagi?')) return;
    await act({ type: 'reply', id: r.id, text: text.trim(), again: !!r.repliedAt });
  };
  const set = (value: 'valid' | 'invalid') => act({ type: 'override', id: r.id, value: r.override === value ? null : value });
  return (
    <li id={`bid-${r.id}`} className={`${r.isBid ? (r.valid ? 'valid' : 'invalid') : 'chat'}${top ? ' leader' : ''}`}>
      <span className="when">{time(r.ts)}</span>
      <span className="who">
        <span className="user">
          @{r.username}{r.own ? ' (kamu)' : ''}
          {r.isBid && r.verified && (
            <button
              className="trusted"
              title={r.imported ? 'Akun ini ada di daftar dari impor followers, belum kamu sahkan sendiri. Ketuk untuk mengeluarkannya.' : 'Akun ini ada di daftar akun sah. Ketuk untuk mengeluarkannya.'}
              onClick={() => confirm(`Keluarkan @${r.username} dari daftar akun sah?`) && act({ type: 'verify', username: r.username, on: false })}
            >
              ✓ Akun sah{r.imported ? ' (impor)' : ''}
            </button>
          )}
        </span>
        <span className="text">{r.text}</span>
        {r.isBid && r.relative && (r.override === 'valid' || r.autoApproved) && !r.own && !r.deleted && (
          <button className="mini replybtn" onClick={reply} title="Kirim balasan ke komentar ini di Instagram">
            {r.repliedAt ? (r.repliedAuto ? '✓ Dibalas otomatis' : '✓ Sudah dibalas') : '💬 Balas sah'}
          </button>
        )}
        {r.isBid && (r.flags.length > 0 || r.override || !r.verified || r.autoApproved || r.replyFailedAt || (r.relative && r.valid && !r.solid)) && (
          <span className="flags">
            {r.override && <span className="flag manual">{r.override === 'valid' ? 'Disahkan' : 'Ditolak'}</span>}
            {r.autoApproved && <span className="flag ok">Disahkan otomatis</span>}
            {r.relative && r.valid && !r.solid && <span className="flag soft" title="Totalnya dihitung dari bid sebelumnya yang belum kamu sahkan">Total belum pasti</span>}
            {r.replyFailedAt && <span className="flag" title={r.replyError || undefined}>Balasan otomatis gagal</span>}
            {r.autoRejected && <span className="flag rejected">Ditolak otomatis</span>}
            {!r.override && !r.verified && !r.autoRejected && <span className="flag soft">Belum dicek</span>}
            {r.flags.map((f) => <span key={f} className={`flag${SOFT.includes(f) ? ' soft' : ''}`}>{FLAGS[f]}</span>)}
          </span>
        )}
      </span>
      {r.isBid && (
        <span className="amount">
          <strong>{rb(r.amount)}</strong>
          <span className="decide">
            <button className={r.override === 'valid' || r.autoApproved ? 'on ok' : ''} onClick={() => set('valid')} aria-label="Sah" title="Sah: bid dihitung, akun masuk daftar akun sah" aria-pressed={r.override === 'valid' || r.autoApproved}>✅</button>
            <button className={r.override === 'invalid' || r.override === 'wrong' || r.autoRejected ? 'on bad' : ''} onClick={() => set('invalid')} aria-label="Tolak" title="Tolak: bid ini tidak dihitung" aria-pressed={r.override === 'invalid' || r.autoRejected}>❌</button>
          </span>
        </span>
      )}
    </li>
  );
}
