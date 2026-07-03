'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPin, X } from 'lucide-react';
import type { AxisBriefingResponse, AxisData, NewsItem } from '@/app/api/axis-briefing/route';

interface AxisBriefingProps {
  show: boolean;
  focusedAxis?: string | null;
  onAxisFocus?: (name: string | null, bbox: [number, number, number, number] | null) => void;
}

const POLL_INTERVAL_MS = 30 * 60 * 1000;
const GOLD = '#FFD24A';
const CYAN = '#00BCD4';

// [minLng, minLat, maxLng, maxLat]
const AXIS_BBOXES: Record<string, [number, number, number, number]> = {
  Kharkiv:     [36.00, 49.50, 38.00, 50.50],
  Lyman:       [37.50, 48.90, 38.80, 49.50],
  Bakhmut:     [37.50, 48.50, 38.50, 49.00],
  Avdiivka:    [37.50, 47.70, 38.50, 48.30],
  Zaporizhzhia:[35.00, 47.00, 37.50, 47.80],
  Huliaipole:  [35.50, 47.50, 37.00, 48.20],
  Kherson:     [32.00, 46.20, 34.50, 47.00],
  Sumy:        [33.50, 50.50, 35.50, 51.50],
};

function HeadlineList({ news }: { news: NewsItem[] }) {
  if (!news.length) {
    return <p className="text-[10px] text-white/30 italic">No recent reports</p>;
  }
  return (
    <ul className="space-y-0.5 mt-1">
      {news.map((item, i) => (
        <li key={i} className="text-[10px] leading-tight">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noopener noreferrer"
              className="truncate block max-w-full hover:underline"
              style={{ color: CYAN }} title={item.title}>
              {item.title}
            </a>
          ) : (
            <span className="truncate block max-w-full" style={{ color: CYAN }}>{item.title}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function AxisRow({ axis, isFocused, onFocus }: {
  axis: AxisData;
  isFocused: boolean;
  onFocus: (name: string | null) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <div className="border-t border-white/10 pt-2 mt-2 first:border-t-0 first:pt-0 first:mt-0">
      <button type="button"
        onClick={() => setCollapsed(c => !c)}
        className="flex items-baseline justify-between w-full text-left gap-2 group">
        <span className="text-[11px] font-bold text-white/80 group-hover:text-white transition-colors">
          {axis.name}
        </span>
        <span className="font-mono tabular-nums text-[11px] shrink-0" style={{ color: GOLD }}>
          {axis.areaKm2.toLocaleString()} km²
        </span>
      </button>

      {/* Map-pin focus button */}
      <button type="button"
        onClick={(e) => { e.stopPropagation(); onFocus(isFocused ? null : axis.name); }}
        className="mt-0.5 flex items-center gap-1 text-[9px] transition-colors"
        style={{ color: isFocused ? '#FF3D3D' : 'rgba(255,255,255,0.3)' }}
        title={isFocused ? 'Clear focus' : 'Focus on map'}>
        <MapPin size={10} strokeWidth={2} />
        {isFocused ? 'focused' : 'focus'}
      </button>

      {!collapsed && <HeadlineList news={axis.news} />}
    </div>
  );
}

export default function AxisBriefing({ show, focusedAxis, onAxisFocus }: AxisBriefingProps) {
  const [data, setData] = useState<AxisBriefingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    if (!show) return;
    let timer: ReturnType<typeof setInterval>;
    const load = () => {
      setLoading(prev => data === null ? true : prev);
      fetch('/api/axis-briefing')
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<AxisBriefingResponse>; })
        .then(j => { if (!aliveRef.current) return; setData(j); setError(null); setLoading(false); })
        .catch((e: unknown) => { if (!aliveRef.current) return; setError(e instanceof Error ? e.message : 'Fetch failed'); setLoading(false); });
    };
    load();
    timer = setInterval(load, POLL_INTERVAL_MS);
    return () => { aliveRef.current = false; clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  const handleFocus = (name: string | null) => {
    if (!onAxisFocus) return;
    const bbox = name ? (AXIS_BBOXES[name] ?? null) : null;
    onAxisFocus(name, bbox);
  };

  if (!show) return null;

  return (
    <div className={[
      'pointer-events-auto rounded-xl border border-white/10',
      'bg-black/70 px-4 py-3 backdrop-blur-md shadow-2xl',
      'w-full sm:w-[260px]',
    ].join(' ')}>
      <div className="mb-2 flex items-center gap-2">
        <MapPin size={13} strokeWidth={2.5} style={{ color: '#FF3D3D' }} />
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/60">
          Axis Briefing
        </span>
        {focusedAxis && (
          <button type="button" onClick={() => handleFocus(null)}
            className="ml-auto flex items-center gap-1 text-[9px] text-white/40 hover:text-white/70 transition-colors">
            <X size={10} /> Show all
          </button>
        )}
        {data && !focusedAxis && (
          <span className="ml-auto text-[9px] text-white/25 tabular-nums">
            {new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>

      {loading && !data && <p className="text-[10px] text-white/40 animate-pulse">Loading axis data…</p>}
      {!loading && error && !data && <p className="text-[10px] text-red-400/70">{error}</p>}

      {data && data.axes.length > 0 && (
        <div className="max-h-[55vh] overflow-y-auto">
          {data.axes
            .filter(axis => !focusedAxis || axis.name === focusedAxis)
            .map(axis => (
              <AxisRow key={axis.name} axis={axis}
                isFocused={focusedAxis === axis.name}
                onFocus={handleFocus} />
            ))}
        </div>
      )}

      {data && data.axes.length === 0 && (
        <p className="text-[10px] text-white/30">No axis data available.</p>
      )}

      <div className="mt-2.5 border-t border-white/10 pt-2 text-[9px] leading-snug text-white/30">
        Area = DeepState occupied polygons · News = Telegram OSINT
      </div>
    </div>
  );
}
