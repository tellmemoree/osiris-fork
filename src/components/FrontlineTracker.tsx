'use client';

import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Minus, Activity } from 'lucide-react';

interface ChangeData {
  current: { date: string; areaKm2: number; features: number };
  delta_1d: number | null;
  delta_7d: number | null;
  since_date: string | null;
  series: { date: string; areaKm2: number }[];
  snapshots: number;
  note?: string;
}

interface DeltaPatch {
  area_km2: number;
  direction: 'ru_gain' | 'ua_gain';
}

interface DeltaData {
  ru_gain: { type: string; features: { properties: DeltaPatch }[] };
  ua_gain: { type: string; features: { properties: DeltaPatch }[] };
  actual_compare_date: string | null;
  compare_date: string;
}

function Delta({ label, v }: { label: string; v: number | null }) {
  if (v === null || v === undefined) {
    return (
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-white/40">{label}</span>
        <span className="text-white/30">—</span>
      </div>
    );
  }
  const up = v > 0;
  const flat = v === 0;
  // Footprint GROWTH = Russian expansion (bad, red). Shrink = contraction (green).
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  const color = flat ? '#8A8880' : up ? '#FF3D3D' : '#00E676';
  const sign = v > 0 ? '+' : '';
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-white/40">{label}</span>
      <span className="flex items-center gap-1 font-mono tabular-nums" style={{ color }}>
        <Icon size={12} strokeWidth={2.5} />
        {sign}{v.toLocaleString()} km²
      </span>
    </div>
  );
}

/** Find the largest patch across RU or UA gain features. */
function hottestPatch(delta: DeltaData | null): { direction: 'ru_gain' | 'ua_gain'; area_km2: number } | null {
  if (!delta) return null;
  let best: { direction: 'ru_gain' | 'ua_gain'; area_km2: number } | null = null;
  for (const f of (delta.ru_gain?.features || [])) {
    const a = f.properties?.area_km2 ?? 0;
    if (!best || a > best.area_km2) best = { direction: 'ru_gain', area_km2: a };
  }
  for (const f of (delta.ua_gain?.features || [])) {
    const a = f.properties?.area_km2 ?? 0;
    if (!best || a > best.area_km2) best = { direction: 'ua_gain', area_km2: a };
  }
  return best;
}

export default function FrontlineTracker({ isMobile = false }: { isMobile?: boolean }) {
  const [d, setD] = useState<ChangeData | null>(null);
  const [delta, setDelta] = useState<DeltaData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/frontline-changes')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j) => {
          if (alive) {
            setD(j);
            setFailed(false);
          }
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    load();
    const iv = setInterval(load, 3_600_000); // hourly
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  // Fetch directional delta for hottest-axis display
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/frontlines?delta=7', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j: DeltaData) => {
          if (alive) setDelta(j);
        })
        .catch(() => { /* silently ignore — delta is optional */ });
    load();
    const iv = setInterval(load, 3_600_000); // hourly
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  if (failed && !d) return null;
  if (!d) return null;

  const hottest = hottestPatch(delta);
  const compareDate = delta?.actual_compare_date || delta?.compare_date || null;

  return (
    <div
      className={`pointer-events-auto rounded-xl border border-white/10 bg-black/70 px-4 py-3 backdrop-blur-md ${
        isMobile ? 'w-full' : 'w-[230px] shadow-2xl'
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Activity size={13} strokeWidth={2.5} style={{ color: (d.delta_1d ?? d.delta_7d) === null ? '#8A8880' : (d.delta_1d ?? d.delta_7d)! > 0 ? '#FF3D3D' : '#00E676' }} />
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/60">
          Frontline Footprint
        </span>
      </div>

      <div className="mb-2.5 font-mono text-2xl font-bold tabular-nums" style={{ color: '#FFD24A' }}>
        {d.current.areaKm2.toLocaleString()}
        <span className="ml-1 text-xs font-normal text-white/40">km²</span>
      </div>

      <div className="space-y-1.5">
        {d.snapshots < 2 ? (
          <div className="text-[10px] text-white/30 leading-snug">Calibrating — first delta available after 24h</div>
        ) : (
          <>
            <Delta label="24h" v={d.delta_1d} />
            <Delta label={d.since_date ? `vs ${d.since_date}` : '7d'} v={d.delta_7d} />
          </>
        )}
      </div>

      {/* Hottest axis: largest directional patch in the 7-day delta */}
      {hottest && (
        <div className="mt-2.5 border-t border-white/10 pt-2">
          <div className="text-[9px] text-white/30 mb-1 uppercase tracking-widest">Hottest axis</div>
          <div
            className="flex items-center gap-1.5 text-[11px] font-mono tabular-nums font-semibold"
            style={{ color: hottest.direction === 'ru_gain' ? '#FF3D00' : '#1565C0' }}
          >
            {hottest.direction === 'ru_gain' ? '▲ RU' : '▼ UA'}
            <span className="font-normal text-white/50">+{hottest.area_km2.toLocaleString()} km²</span>
          </div>
          {compareDate && (
            <div className="text-[9px] text-white/25 mt-0.5">vs {compareDate} · DeepState</div>
          )}
        </div>
      )}

      {d.note && <div className="mt-2 text-[10px] leading-snug text-white/35">{d.note}</div>}

      <div className="mt-2.5 border-t border-white/10 pt-2 text-[9px] leading-snug text-white/30">
        ▲ RU gain · ▼ UA advance · DeepState
      </div>
    </div>
  );
}
