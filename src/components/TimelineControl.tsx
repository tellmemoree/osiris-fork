'use client';
import { useState, useEffect, useRef } from 'react';
import { Play, Pause } from 'lucide-react';

export interface TimelineEvent {
  t: number;   // Unix ms
  type: 'news' | 'kab' | 'gdelt' | 'thermal' | 'capture';
}

interface Props {
  replayTime: Date | null;       // null = live mode
  timelineRangeH: number;        // hours shown on the bar
  events: TimelineEvent[];       // for density histogram
  onScrub: (t: Date | null) => void;
  onRangeChange: (h: number) => void;
}

const SPEEDS = [
  { label: '1×', hps: 1 },
  { label: '4×', hps: 4 },
  { label: '12×', hps: 12 },
];
const RANGES = [6, 12, 24, 48];
const TICK_MS = 200; // 5fps — enough for smooth playback, avoids 20×/sec MapLibre source uploads

function fmtUtc(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${hh}:${mm}Z ${dd}/${mo}`;
}

export default function TimelineControl({ replayTime, timelineRangeH, events, onScrub, onRangeChange }: Props) {
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1); // default 4×
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // Keep mutable refs so interval callback always sees current values without
  // needing to be recreated on every replayTime change.
  const replayRef = useRef(replayTime);
  replayRef.current = replayTime;
  const rangeHRef = useRef(timelineRangeH);
  rangeHRef.current = timelineRangeH;

  const nowMs = Date.now();
  const rangeMs = timelineRangeH * 3_600_000;
  const rangeStart = nowMs - rangeMs;
  const currentMs = replayTime ? replayTime.getTime() : nowMs;
  const progress = Math.max(0, Math.min(1, (currentMs - rangeStart) / rangeMs));
  const isLive = !replayTime;

  // ── Density histogram ──────────────────────────────────────────────────────
  const BUCKETS = Math.min(timelineRangeH, 48);
  const bucketMs = rangeMs / BUCKETS;
  const byType = {
    news:    new Array(BUCKETS).fill(0) as number[],
    kab:     new Array(BUCKETS).fill(0) as number[],
    gdelt:   new Array(BUCKETS).fill(0) as number[],
    thermal: new Array(BUCKETS).fill(0) as number[],
    capture: new Array(BUCKETS).fill(0) as number[],
  };
  for (const ev of events) {
    const idx = Math.floor((ev.t - rangeStart) / bucketMs);
    if (idx >= 0 && idx < BUCKETS) byType[ev.type][idx]++;
  }
  const totals = Array.from({ length: BUCKETS }, (_, i) => byType.news[i] + byType.kab[i] + byType.gdelt[i] + byType.thermal[i] + byType.capture[i]);
  const maxBucket = Math.max(...totals, 1);

  // ── Playback interval ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing) return;
    // Clamp so the full window takes at least 10 real seconds — prevents 12× blowing
    // through a 6h window in 0.5s.
    const rawAdvance = SPEEDS[speedIdx].hps * 3_600_000 * (TICK_MS / 1000);
    const minTicks = 10_000 / TICK_MS; // 10s minimum traversal
    const advanceMs = Math.min(rawAdvance, (rangeHRef.current * 3_600_000) / minTicks);
    const iv = setInterval(() => {
      const cur = replayRef.current;
      if (cur === null) {
        // Playing with no replayTime — stop cleanly rather than teleporting to window start.
        onScrub(null);
        setPlaying(false);
        return;
      }
      const next = cur.getTime() + advanceMs;
      if (next >= Date.now()) {
        onScrub(null);    // reached "now" → switch to live
        setPlaying(false);
      } else {
        onScrub(new Date(next));
      }
    }, TICK_MS);
    return () => clearInterval(iv);
  }, [playing, speedIdx, onScrub]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scrub helpers ──────────────────────────────────────────────────────────
  function scrubToX(clientX: number) {
    if (!trackRef.current) return;
    // Recompute rangeStart fresh here — render-time nowMs can be stale by several
    // seconds when there's no data update, which would shrink the effective snap-to-live
    // tolerance below the intended 5s.
    const freshNow = Date.now();
    const freshRangeMs = rangeHRef.current * 3_600_000;
    const freshRangeStart = freshNow - freshRangeMs;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetMs = freshRangeStart + ratio * freshRangeMs;
    onScrub(targetMs >= freshNow - 5_000 ? null : new Date(targetMs));
  }

  function handlePointerDown(e: React.PointerEvent) {
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scrubToX(e.clientX);
  }
  function handlePointerMove(e: React.PointerEvent) {
    if (dragging.current) scrubToX(e.clientX);
  }
  function handlePointerUp() { dragging.current = false; }

  function togglePlay() {
    if (!playing) {
      if (isLive) onScrub(new Date(Date.now() - rangeMs)); // start from window start
      setPlaying(true);
    } else {
      setPlaying(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="glass-panel px-3 py-2 flex flex-col gap-1.5 pointer-events-auto select-none"
         style={{ minWidth: 0 }}>

      {/* ── Controls row ── */}
      <div className="flex items-center gap-1.5 text-[10px] font-mono flex-wrap">

        {/* Play / Pause */}
        <button
          onClick={togglePlay}
          title={playing ? 'Pause' : 'Play timeline'}
          className={`w-6 h-6 rounded flex items-center justify-center transition-colors flex-shrink-0 ${
            playing ? 'bg-[var(--cyan-primary)]/20 text-[var(--cyan-primary)]' : 'hover:bg-white/10 text-white/50'
          }`}
        >
          {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
        </button>

        {/* Speed */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {SPEEDS.map((s, i) => (
            <button key={s.label} onClick={() => setSpeedIdx(i)}
              className={`px-1.5 py-0.5 rounded transition-colors ${
                speedIdx === i
                  ? 'bg-[var(--cyan-primary)]/20 text-[var(--cyan-primary)]'
                  : 'text-white/35 hover:text-white/60'
              }`}>
              {s.label}
            </button>
          ))}
        </div>

        <div className="w-px h-3 bg-white/10 flex-shrink-0" />

        {/* Current time */}
        <span className={`tabular-nums tracking-tight flex-shrink-0 ${isLive ? 'text-[var(--alert-green)] font-bold' : 'text-white/65'}`}>
          {isLive ? '● LIVE' : fmtUtc(currentMs)}
        </span>

        <div className="flex-1 min-w-0" />

        {/* Range */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {RANGES.map(h => (
            <button key={h} onClick={() => { onRangeChange(h); setPlaying(false); }}
              className={`px-1.5 py-0.5 rounded transition-colors ${
                timelineRangeH === h ? 'bg-white/15 text-white/90' : 'text-white/35 hover:text-white/60'
              }`}>
              {h}h
            </button>
          ))}
        </div>

        <div className="w-px h-3 bg-white/10 flex-shrink-0" />

        {/* LIVE button */}
        <button
          onClick={() => { onScrub(null); setPlaying(false); }}
          className={`px-2 py-0.5 rounded font-bold tracking-widest transition-colors flex-shrink-0 ${
            isLive
              ? 'bg-[var(--alert-green)]/15 text-[var(--alert-green)]'
              : 'text-white/35 hover:text-[var(--alert-green)]/70 border border-white/10'
          }`}>
          LIVE
        </button>
      </div>

      {/* ── Scrubber track ── */}
      <div
        ref={trackRef}
        className="relative h-16 cursor-pointer rounded overflow-hidden"
        style={{ touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Density histogram */}
        <div className="absolute inset-0 flex items-end gap-px">
          {totals.map((count, i) => {
            const h = count === 0 ? 0 : Math.max(0.06, count / maxBucket);
            const nF = byType.news[i]    / Math.max(count, 1);
            const kF = byType.kab[i]     / Math.max(count, 1);
            const gF = byType.gdelt[i]   / Math.max(count, 1);
            const tF = byType.thermal[i] / Math.max(count, 1);
            const cF = byType.capture[i] / Math.max(count, 1);
            return (
              <div key={i} className="flex-1 flex flex-col-reverse" style={{ height: `${h * 100}%` }}>
                {nF > 0 && <div style={{ flex: nF, background: 'rgba(34,211,238,0.35)' }} />}
                {kF > 0 && <div style={{ flex: kF, background: 'rgba(251,146,60,0.35)' }} />}
                {gF > 0 && <div style={{ flex: gF, background: 'rgba(250,204,21,0.35)' }} />}
                {tF > 0 && <div style={{ flex: tF, background: 'rgba(255,80,40,0.45)' }} />}
                {cF > 0 && <div style={{ flex: cF, background: 'rgba(180,80,255,0.40)' }} />}
              </div>
            );
          })}
        </div>

        {/* Track base line */}
        <div className="absolute left-0 right-0 top-1/2 h-px bg-white/12 pointer-events-none" />

        {/* Progress fill */}
        {!isLive && (
          <div className="absolute left-0 top-1/2 h-px pointer-events-none"
            style={{ width: `${progress * 100}%`, background: 'rgba(34,211,238,0.55)' }} />
        )}

        {/* Scrub handle */}
        {!isLive && (
          <div className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full pointer-events-none"
            style={{
              left: `calc(${progress * 100}% - 5px)`,
              background: 'var(--cyan-primary)',
              boxShadow: '0 0 6px rgba(34,211,238,0.7)',
              border: '1px solid rgba(255,255,255,0.5)',
            }} />
        )}

        {/* Axis labels */}
        <span className="absolute bottom-0.5 left-0.5 text-[8px] font-mono pointer-events-none"
          style={{ color: 'rgba(255,255,255,0.25)' }}>−{timelineRangeH}h</span>
        <span className="absolute bottom-0.5 right-0.5 text-[8px] font-mono pointer-events-none"
          style={{ color: 'rgba(255,255,255,0.25)' }}>NOW</span>
      </div>

      {/* ── Legend ── */}
      <div className="flex items-center gap-3 text-[8px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-1 rounded-sm" style={{ background: 'rgba(34,211,238,0.6)' }} />
          NEWS/INTEL
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-1 rounded-sm" style={{ background: 'rgba(251,146,60,0.6)' }} />
          KAB THREAT
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-1 rounded-sm" style={{ background: 'rgba(250,204,21,0.6)' }} />
          GLOBAL INC.
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-1 rounded-sm" style={{ background: 'rgba(255,80,40,0.7)' }} />
          THERMAL
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-1 rounded-sm" style={{ background: 'rgba(180,80,255,0.7)' }} />
          CAPTURES
        </span>
      </div>
    </div>
  );
}
