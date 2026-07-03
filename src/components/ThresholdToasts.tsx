'use client';

import { useState, useEffect, useRef } from 'react';
import { X, MapPin, ChevronDown, ChevronUp } from 'lucide-react';
import type { ThresholdAlert } from '@/app/api/threshold-alerts/route';

interface Props {
  alerts: ThresholdAlert[];
  onLocate?: (lat: number, lng: number) => void;
  onNewAlert?: (alert: ThresholdAlert) => void;
}

const SEV_COLOR: Record<string, string> = {
  CRITICAL: '#FF1744',
  HIGH: '#FF3D3D',
  ELEVATED: '#FF9500',
  LOW: '#00E676',
};

// Severity rank — higher = worse
const SEV_RANK: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  ELEVATED: 2,
  LOW: 1,
};

const AUTO_DISMISS_MS = 25_000;

function Toast({ alert, onDismiss, onLocate }: {
  alert: ThresholdAlert;
  onDismiss: () => void;
  onLocate?: (lat: number, lng: number) => void;
}) {
  const color = SEV_COLOR[alert.severity] ?? '#FFD700';
  const [progress, setProgress] = useState(100);
  const rafRef = useRef<number>(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const tick = () => {
      const elapsed = Date.now() - startRef.current;
      const pct = Math.max(0, 100 - (elapsed / AUTO_DISMISS_MS) * 100);
      setProgress(pct);
      if (pct > 0) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        onDismiss();
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [onDismiss]);

  return (
    <div
      className="glass-panel pointer-events-auto overflow-hidden"
      style={{ width: 300, borderColor: `${color}33` }}
    >
      {/* Progress bar */}
      <div className="h-0.5 w-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div
          className="h-full transition-none"
          style={{ width: `${progress}%`, background: color, opacity: 0.6 }}
        />
      </div>

      <div className="px-3 py-2.5">
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}80` }} />
            <span className="text-[9px] font-mono font-bold tracking-widest uppercase" style={{ color }}>
              {alert.rule}
            </span>
          </div>
          <button onClick={onDismiss} className="text-white/30 hover:text-white/60 flex-shrink-0">
            <X size={11} />
          </button>
        </div>

        <p className="text-[10px] font-mono font-semibold text-white/85 leading-snug mb-1">
          {alert.title}
        </p>
        <p className="text-[9px] font-mono text-white/45 leading-snug">
          {alert.description}
        </p>

        {alert.lat !== undefined && alert.lng !== undefined && onLocate && (
          <button
            onClick={() => onLocate(alert.lat!, alert.lng!)}
            className="mt-2 flex items-center gap-1 text-[8px] font-mono text-[var(--cyan-primary)] hover:underline"
          >
            <MapPin size={9} /> Fly to location
          </button>
        )}
      </div>
    </div>
  );
}

// A collapsed group card mounts no <Toast>, so it would never auto-dismiss.
// This render-nothing child arms the same 25s timer the Toast uses, calling the
// latest onDismiss via a ref so re-renders don't reset the countdown.
function GroupAutoDismiss({ onDismiss }: { onDismiss: () => void }) {
  const ref = useRef(onDismiss);
  ref.current = onDismiss;
  useEffect(() => {
    const t = setTimeout(() => ref.current(), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, []);
  return null;
}

export default function ThresholdToasts({ alerts, onLocate, onNewAlert }: Props) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [groupExpanded, setGroupExpanded] = useState<Set<string>>(new Set());
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const alert of alerts) {
      if (!dismissed.has(alert.id) && !seenRef.current.has(alert.id)) {
        seenRef.current.add(alert.id);
        onNewAlert?.(alert);
      }
    }
  }, [alerts, dismissed, onNewAlert]);

  const visible = alerts.filter(a => !dismissed.has(a.id));
  if (!visible.length) return null;

  // Build group map keyed on alert.rule
  const groups = new Map<string, ThresholdAlert[]>();
  for (const a of visible) {
    if (!groups.has(a.rule)) groups.set(a.rule, []);
    groups.get(a.rule)!.push(a);
  }
  // Cap rendered groups (not raw alerts) to 5
  const groupList = Array.from(groups.entries()).slice(0, 5);

  const dismissGroup = (ruleAlerts: ThresholdAlert[]) => {
    setDismissed(prev => new Set([...prev, ...ruleAlerts.map(a => a.id)]));
  };

  const toggleGroup = (rule: string) => {
    setGroupExpanded(prev => {
      const next = new Set(prev);
      if (next.has(rule)) {
        next.delete(rule);
      } else {
        next.add(rule);
      }
      return next;
    });
  };

  return (
    <div className="absolute top-16 right-2 z-[400] flex flex-col gap-2 pointer-events-none">
      {groupList.map(([rule, ruleAlerts]) => {
        const count = ruleAlerts.length;

        // Single alert: pass straight through to Toast with no group chrome
        if (count === 1) {
          return (
            <Toast
              key={ruleAlerts[0].id}
              alert={ruleAlerts[0]}
              onLocate={onLocate}
              onDismiss={() => setDismissed(prev => new Set([...prev, ruleAlerts[0].id]))}
            />
          );
        }

        // Multiple alerts: group card with expand/collapse and shared auto-dismiss
        const worstAlert = ruleAlerts.reduce((best, a) =>
          (SEV_RANK[a.severity] ?? 0) > (SEV_RANK[best.severity] ?? 0) ? a : best
        );
        const color = SEV_COLOR[worstAlert.severity] ?? '#FFD700';
        const isExpanded = groupExpanded.has(rule);
        return (
          <div
            key={rule}
            className="glass-panel pointer-events-auto overflow-hidden"
            style={{ width: 300, borderColor: `${color}33` }}
          >
            {/* Thin colored stripe at top — no animation */}
            <div className="h-0.5 w-full" style={{ background: color, opacity: 0.5 }} />

            {/* Auto-dismiss the whole group after 25s even while collapsed */}
            <GroupAutoDismiss onDismiss={() => dismissGroup(ruleAlerts)} />

            {/* Group header */}
            <div className="px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <div
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: color, boxShadow: `0 0 6px ${color}80` }}
                  />
                  <span
                    className="text-[9px] font-mono font-bold tracking-widest uppercase truncate"
                    style={{ color }}
                  >
                    {rule}
                  </span>
                  {/* Count badge */}
                  <span
                    className="ml-1 flex-shrink-0 px-1 py-0.5 rounded text-[8px] font-mono font-bold leading-none"
                    style={{ background: `${color}33`, color }}
                  >
                    {count}
                  </span>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  {/* Expand / collapse chevron */}
                  <button
                    onClick={() => toggleGroup(rule)}
                    className="text-white/30 hover:text-white/60"
                    aria-label={isExpanded ? 'Collapse group' : 'Expand group'}
                  >
                    {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  </button>
                  {/* Dismiss all */}
                  <button
                    onClick={() => dismissGroup(ruleAlerts)}
                    className="text-white/30 hover:text-white/60"
                    aria-label="Dismiss all in group"
                  >
                    <X size={11} />
                  </button>
                </div>
              </div>

              {/* Summary line when collapsed */}
              {!isExpanded && (
                <p className="mt-1.5 text-[9px] font-mono text-white/45 leading-snug">
                  {ruleAlerts[0].title}
                  {count > 1 && <span className="text-white/30"> +{count - 1} more</span>}
                </p>
              )}
            </div>

            {/* Expanded individual toasts */}
            {isExpanded && (
              <div className="flex flex-col gap-1 px-1 pb-1">
                {ruleAlerts.map(alert => (
                  <Toast
                    key={alert.id}
                    alert={alert}
                    onLocate={onLocate}
                    onDismiss={() => setDismissed(prev => new Set([...prev, alert.id]))}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
