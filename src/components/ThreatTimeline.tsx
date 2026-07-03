'use client';

import { useEffect, useRef, useState } from 'react';
import { GitMerge } from 'lucide-react';

import type { CorrelatedEventsResponse, CorrelatedEvent, Signal } from '@/app/api/correlated-events/route';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ThreatTimelineProps {
  show: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 60_000; // 1 min

// ---------------------------------------------------------------------------
// Helpers (module scope — stable references, no closure over state)
// ---------------------------------------------------------------------------

function signalColor(type: Signal['type']): string {
  return (
    ({
      air_raid: '#FF5722',
      weapon: '#FF4444',
      kab: '#FF9800',
      drone: '#CE93D8',
      missile: '#FF69B4',
    } as Record<string, string>)[type] ?? '#888'
  );
}

function signalLabel(s: Signal): string {
  if (s.weapon_type) return s.weapon_type;
  return (
    ({
      air_raid: 'AIR RAID',
      weapon: 'WEAPON',
      kab: 'KAB',
      drone: 'DRONE',
      missile: 'MISSILE',
    } as Record<string, string>)[s.type] ?? s.type
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ThreatTimeline({ show }: ThreatTimelineProps) {
  const [data, setData] = useState<CorrelatedEventsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<boolean>(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    if (!show) return;

    let timer: ReturnType<typeof setInterval>;

    const load = () => {
      if (data === null) setLoading(true);
      fetch('/api/correlated-events')
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<CorrelatedEventsResponse>;
        })
        .then((j) => {
          if (!aliveRef.current) return;
          setData(j);
          setError(false);
          setLoading(false);
        })
        .catch(() => {
          if (!aliveRef.current) return;
          setError(true);
          setLoading(false);
        });
    };

    load();
    timer = setInterval(load, POLL_INTERVAL_MS);

    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
    // data intentionally excluded — we only want the spinner on first load,
    // not on every poll cycle. Reading `data` here would also cause a
    // stale-closure problem since `load` captures it at definition time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  if (!show) return null;

  // Sort events newest-first. The backend may return them in any order.
  const events: CorrelatedEvent[] = data?.events
    ? [...data.events].sort(
        (a: CorrelatedEvent, b: CorrelatedEvent) =>
          new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime()
      )
    : [];

  // "Updated N seconds/minutes ago" timestamp from last successful fetch
  const updatedLabel = (() => {
    if (!data?.timestamp) return null;
    const diff = Math.floor((Date.now() - new Date(data.timestamp).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    return `${Math.floor(diff / 60)}m ago`;
  })();

  return (
    <div
      style={{
        width: 280,
        background: 'rgba(10,9,6,0.82)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 8,
        backdropFilter: 'blur(12px)',
        color: '#E8E6E0',
        fontFamily: 'monospace',
        pointerEvents: 'auto',
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <GitMerge size={11} style={{ color: '#FF5722', flexShrink: 0 }} />
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'rgba(232,230,224,0.6)',
          }}
        >
          Threat Timeline
        </span>
        {updatedLabel && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 8,
              color: '#5C5A54',
              whiteSpace: 'nowrap',
            }}
          >
            Updated {updatedLabel}
          </span>
        )}
        {data?.timestamp && !updatedLabel && (
          <span style={{ marginLeft: 'auto', fontSize: 8, color: '#5C5A54' }}>
            {new Date(data.timestamp).toISOString().slice(11, 16)}Z
          </span>
        )}
      </div>

      {/* ── Body ── */}
      {loading && !data && (
        <div style={{ padding: '12px', fontSize: 10, color: '#5C5A54' }}>
          Loading…
        </div>
      )}

      {!loading && error && !data && (
        <div style={{ padding: '12px', fontSize: 10, color: '#FF4444' }}>
          Failed to load correlated signals.
        </div>
      )}

      {data && events.length === 0 && (
        <div style={{ padding: '12px', fontSize: 10, color: '#5C5A54' }}>
          No correlated signals in last 60 min
        </div>
      )}

      {events.length > 0 && (
        <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
          {events.map((event: CorrelatedEvent, idx: number) => (
            <div
              key={event.oblast ?? idx}
              style={{
                borderTop: '1px solid rgba(255,255,255,0.05)',
                padding: '8px 12px',
              }}
            >
              {/* Oblast + tightness */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 4,
                }}
              >
                <span style={{ fontSize: 10, fontWeight: 700, color: '#E8E6E0' }}>
                  {event.oblast}
                </span>
                <span style={{ fontSize: 9, color: '#5C5A54' }}>
                  ±{event.match_tightness_min}m
                </span>
              </div>

              {/* ALARM CONFIRMED badge */}
              {event.alarm_confirmed && (
                <div
                  style={{
                    fontSize: 8,
                    color: '#FF1744',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    marginBottom: 4,
                  }}
                >
                  ⚡ ALARM CONFIRMED
                </div>
              )}

              {/* Signal chips */}
              <div
                style={{
                  display: 'flex',
                  gap: 4,
                  flexWrap: 'wrap',
                  marginBottom: 4,
                }}
              >
                {(event.signals ?? []).map((s: Signal, i: number) => (
                  <span
                    key={i}
                    style={{
                      fontSize: 8,
                      padding: '1px 5px',
                      borderRadius: 3,
                      background: signalColor(s.type),
                      color: '#000',
                      fontWeight: 700,
                    }}
                  >
                    {signalLabel(s)}
                  </span>
                ))}
              </div>

              {/* Snippet from first signal that has one */}
              {(event.signals ?? []).find((s: Signal) => s.snippet) && (
                <div
                  style={{
                    fontSize: 8,
                    color: '#5C5A54',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 240,
                  }}
                >
                  {(event.signals as Signal[]).find((s: Signal) => s.snippet)!.snippet}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
