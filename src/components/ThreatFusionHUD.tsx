'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, ChevronDown, ChevronUp, Crosshair, TrendingUp, TrendingDown, Minus, Radar } from 'lucide-react';
import { type Fusion, type Domain } from '@/lib/fusion';

/**
 * OSIRIS — Global Threat Fusion HUD
 * Reads the server-computed /api/fusion endpoint (a ~2 KB, edge-cached payload)
 * and renders a cinematic radial gauge + domain breakdown + rotating hotspots.
 * One tiny request per client — the heavy six-feed fusion happens once on the
 * server and is cached at Cloudflare's edge, so it stays cheap at 333K/month.
 */

interface Props {
  onLocate?: (lat: number, lng: number) => void;
}

const DOMAIN_ABBR: Record<Domain, string> = {
  CONFLICT: 'CONFLICT', CYBER: 'CYBER', SIGNALS: 'SIGNALS', SEISMIC: 'SEISMIC', AVIATION: 'AVIATION', ATMOSPHERIC: 'ATMOS',
};

function scoreColor(s: number): string {
  if (s >= 80) return '#FF1744';
  if (s >= 60) return '#FF5252';
  if (s >= 40) return '#FF9500';
  if (s >= 20) return '#FFD54F';
  return '#00E676';
}

export default function ThreatFusionHUD({ onLocate }: Props) {
  const [fusion, setFusion] = useState<Fusion | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(false);
  const [hotIdx, setHotIdx] = useState(0);
  const [hoverDomain, setHoverDomain] = useState<Domain | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/fusion', { signal: AbortSignal.timeout(30000) });
      if (r.ok) setFusion(await r.json());
    } catch {
      /* keep last good read */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    // Server payload is edge-cached (60s); polling every 60s just refreshes the read.
    const iv = setInterval(refresh, 60000);
    return () => clearInterval(iv);
  }, [refresh]);

  // Rotate hotspot ticker
  useEffect(() => {
    if (!fusion?.hotspots.length) return;
    const iv = setInterval(() => setHotIdx(i => (i + 1) % fusion.hotspots.length), 3500);
    return () => clearInterval(iv);
  }, [fusion?.hotspots.length]);

  const color = fusion?.level_color || '#00E676';
  const overall = fusion?.overall ?? 0;
  const level = fusion?.threatcon ?? 1;

  // Radial gauge geometry
  const R = 34, C = 2 * Math.PI * R;
  const arc = (overall / 100) * C;

  const TrendIcon = fusion?.trend === 'rising' ? TrendingUp : fusion?.trend === 'falling' ? TrendingDown : Minus;
  const hot = fusion?.hotspots[hotIdx];
  // The WHY panel follows the hovered bar, or defaults to the dominant driver.
  const detail = fusion?.domains.find(d => d.domain === (hoverDomain ?? fusion.dominant_domain));

  return (
    <motion.div
      initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
      className="glass-panel pointer-events-auto overflow-hidden"
      style={{ width: 280, borderColor: `${color}55`, boxShadow: `0 0 28px -8px ${color}55, 0 4px 30px rgba(0,0,0,0.5)` }}
    >
      {/* Header */}
      <button onClick={() => setExpanded(e => !e)} className="w-full flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: `${color}33` }}>
        <div className="flex items-center gap-2">
          <Radar className="w-3.5 h-3.5" style={{ color }} />
          <span className="hud-text text-[10px] text-[var(--text-primary)]">THREAT FUSION</span>
          {loading && <span className="w-1.5 h-1.5 rounded-full animate-osiris-pulse" style={{ background: color }} />}
        </div>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }}>
            {/* Gauge + level */}
            <div className="flex items-center gap-3 px-3 py-3">
              <div className="relative shrink-0" style={{ width: 84, height: 84 }}>
                <svg width="84" height="84" viewBox="0 0 84 84" className="-rotate-90">
                  <circle cx="42" cy="42" r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
                  <motion.circle
                    cx="42" cy="42" r={R} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
                    strokeDasharray={C} initial={{ strokeDashoffset: C }} animate={{ strokeDashoffset: C - arc }}
                    transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
                    style={{ filter: `drop-shadow(0 0 6px ${color})` }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="font-mono font-bold leading-none" style={{ color, fontSize: 26, textShadow: `0 0 12px ${color}99` }}>{level}</span>
                  <span className="hud-label" style={{ fontSize: 6 }}>THREATCON</span>
                </div>
              </div>

              <div className="flex-1 min-w-0">
                <div className="font-mono font-bold text-[13px] tracking-wider" style={{ color }}>{fusion?.level_label || '—'}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="hud-value text-[11px]" style={{ color: 'var(--text-primary)' }}>{overall}<span className="text-[8px] text-[var(--text-muted)]">/100</span></span>
                  <span className="flex items-center gap-0.5 text-[9px] font-mono" style={{ color: fusion?.trend === 'rising' ? '#FF5252' : fusion?.trend === 'falling' ? '#00E676' : 'var(--text-muted)' }}>
                    <TrendIcon className="w-3 h-3" />{fusion?.delta ? (fusion.delta > 0 ? '+' : '') + fusion.delta : '0'}
                  </span>
                </div>
                <div className="hud-label mt-1" style={{ fontSize: 6.5 }}>DOMINANT · <span style={{ color: 'var(--text-secondary)' }}>{fusion?.dominant_domain || '—'}</span></div>
              </div>
            </div>

            {/* Domain bars — hover any bar to see WHY it scores that way */}
            <div className="px-3 pb-1 space-y-1">
              {fusion?.domains.map(d => {
                const active = hoverDomain === d.domain;
                return (
                  <div
                    key={d.domain}
                    onMouseEnter={() => setHoverDomain(d.domain)}
                    onMouseLeave={() => setHoverDomain(null)}
                    className="flex items-center gap-2 rounded px-1 -mx-1 py-0.5 cursor-help transition-colors"
                    style={{ background: active ? `${scoreColor(d.score)}14` : 'transparent' }}
                  >
                    <span className="hud-label w-[54px] shrink-0" style={{ fontSize: 7, color: active ? scoreColor(d.score) : undefined }}>{DOMAIN_ABBR[d.domain]}</span>
                    <div className="flex-1 h-[5px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                      <motion.div initial={{ width: 0 }} animate={{ width: `${d.score}%` }} transition={{ duration: 0.8, ease: 'easeOut' }}
                        className="h-full rounded-full" style={{ background: scoreColor(d.score), boxShadow: `0 0 6px ${scoreColor(d.score)}88` }} />
                    </div>
                    <span className="font-mono text-[9px] w-5 text-right tabular-nums" style={{ color: scoreColor(d.score) }}>{d.score}</span>
                  </div>
                );
              })}
            </div>

            {/* WHY panel — FIXED height so hovering never resizes the HUD (no flicker).
                Evidence behind the hovered (or dominant) domain. */}
            {detail && (
              <div className="mx-3 mb-2 rounded-lg border overflow-hidden flex flex-col" style={{ height: 138, borderColor: `${scoreColor(detail.score)}33`, background: `${scoreColor(detail.score)}0a` }}>
                <div className="flex items-center justify-between px-2.5 py-1.5 border-b shrink-0" style={{ borderColor: `${scoreColor(detail.score)}22` }}>
                  <span className="font-mono font-bold text-[9px] tracking-wider" style={{ color: scoreColor(detail.score) }}>
                    {DOMAIN_ABBR[detail.domain]} · {detail.score}/100
                  </span>
                  <span className="font-mono text-[7px] tracking-wider px-1 py-0.5 rounded" style={{ color: scoreColor(detail.score), background: `${scoreColor(detail.score)}18` }}>
                    +{detail.contribution} PTS · WT {Math.round(detail.weight * 100)}%
                  </span>
                </div>
                <div className="hud-label px-2.5 pt-1.5 shrink-0" style={{ fontSize: 6.5 }}>{detail.method}</div>
                {/* Scrollable, fixed-height driver list — constant panel height regardless of count */}
                <div className="flex-1 overflow-y-auto styled-scrollbar px-2.5 py-1 space-y-1">
                  {detail.drivers.length === 0 && <div className="text-[9px] text-[var(--text-muted)]">No significant activity in this domain.</div>}
                  {detail.drivers.map((dr, i) => (
                    <div key={i} className="flex items-start gap-1.5">
                      <span className="w-1 h-1 rounded-full mt-1.5 shrink-0" style={{ background: scoreColor(dr.sev ?? detail.score) }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[9px] text-[var(--text-primary)] truncate leading-tight">{dr.label}</div>
                        {dr.sub && <div className="text-[7.5px] text-[var(--text-muted)] font-mono truncate">{dr.sub}</div>}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="hud-label px-2.5 py-1 border-t shrink-0" style={{ fontSize: 6, borderColor: 'rgba(255,255,255,0.06)' }}>
                  {hoverDomain ? 'HOVER-SELECTED' : `DOMINANT DRIVER · THREATCON ${level}`}
                </div>
              </div>
            )}

            {/* Hotspot ticker */}
            {hot && (
              <button
                onClick={() => onLocate?.(hot.lat, hot.lng)}
                className="w-full flex items-center gap-2 px-3 py-2 border-t text-left hover:bg-[var(--hover-accent)] transition-colors"
                style={{ borderColor: `${color}22` }}
                title="Locate on map"
              >
                <Crosshair className="w-3 h-3 shrink-0" style={{ color: scoreColor(hot.severity) }} />
                <AnimatePresence mode="wait">
                  <motion.div key={hotIdx} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.25 }} className="min-w-0 flex-1">
                    <div className="text-[9px] font-mono truncate" style={{ color: 'var(--text-primary)' }}>{hot.label}</div>
                    <div className="hud-label" style={{ fontSize: 6 }}>{hot.domain} · SEV {hot.severity}</div>
                  </motion.div>
                </AnimatePresence>
                <span className="hud-label shrink-0" style={{ fontSize: 6 }}>{hotIdx + 1}/{fusion?.hotspots.length}</span>
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
