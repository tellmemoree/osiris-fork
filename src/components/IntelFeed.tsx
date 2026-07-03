'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Newspaper, ChevronDown, ChevronUp, ExternalLink, MapPin, Zap, Maximize2, Minimize2 } from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════
   OSIRIS — Intelligence Feed
   SIGINT-style news aggregation with risk scoring
   ═══════════════════════════════════════════════════════════════ */

interface IntelFeedProps {
  data: any;
  onLocate?: (lat: number, lng: number) => void;
}

function getRiskClass(score: number): string {
  if (score >= 8) return 'risk-critical';
  if (score >= 6) return 'risk-high';
  if (score >= 4) return 'risk-medium';
  return 'risk-low';
}

function getRiskLabel(score: number): string {
  if (score >= 8) return 'CRITICAL';
  if (score >= 6) return 'HIGH';
  if (score >= 4) return 'ELEVATED';
  return 'LOW';
}

function timeAgo(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return '';
  }
}

type SideFilter = 'all' | 'ua' | 'ru' | 'world';

interface NewsItem {
  title?: string;
  description?: string;
  link?: string;
  source?: string;
  published?: string;
  side?: string;
  risk_score?: number;
  coords?: [number, number];
  machine_assessment?: string;
}

export default function IntelFeed({ data, onLocate }: IntelFeedProps) {
  const [expanded, setExpanded] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [filter, setFilter] = useState<SideFilter>('all');
  // Per-item full-text toggle — tap a story to read the whole thing.
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const toggleItem = (key: string) =>
    setOpenItems(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const isLoading = data.news === undefined;
  const allNews: NewsItem[] = data.news || [];
  const news = filter === 'all' ? allNews : allNews.filter((n) => (n.side || 'world') === filter);
  const countFor = (side: SideFilter) =>
    side === 'all' ? allNews.length : allNews.filter((n) => (n.side || 'world') === side).length;

  const TABS: { id: SideFilter; label: string }[] = [
    { id: 'all', label: 'ALL' },
    { id: 'ua', label: '🇺🇦 UA' },
    { id: 'ru', label: '🇷🇺 RU' },
    { id: 'world', label: '🌍 WORLD' },
  ];

  const content = (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.6, duration: 0.6 }}
      className={`glass-panel flex flex-col overflow-hidden pointer-events-auto transition-all duration-300 ${maximized ? 'fixed inset-4 z-[9999] bg-[#0a0a09]/95 backdrop-blur-3xl' : ''}`}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-4 py-3 hover:bg-[var(--hover-accent)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <Newspaper className="w-3.5 h-3.5 text-[var(--gold-primary)]" />
          <span className="hud-text text-[12px] text-[var(--text-primary)]">SIGINT FEED</span>
          <span className="gotham-tag gotham-tag--info" style={{ fontSize: '8px', padding: '1px 5px' }}>{allNews.length}</span>
          {allNews.some((n) => (n.risk_score ?? 0) >= 8) && (
            <span className="gotham-tag gotham-tag--critical" style={{ fontSize: '7px', padding: '1px 4px' }}>ALERTS</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--alert-green)] animate-osiris-pulse" />
          <button onClick={(e) => { e.stopPropagation(); setMaximized(!maximized); if (!expanded && !maximized) setExpanded(true); }} className="hover:text-white transition-colors" title={maximized ? "Restore" : "Maximize"}>
            {maximized ? <Minimize2 className="w-3 h-3 text-[var(--text-muted)]" /> : <Maximize2 className="w-3 h-3 text-[var(--text-muted)]" />}
          </button>
          {expanded ? <ChevronUp className="w-3 h-3 text-[var(--text-muted)]" /> : <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />}
        </div>
      </button>

      {/* News Items */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            {/* Side filters (UA / RU / WORLD) */}
            <div className="flex gap-1 px-3 pt-2 pb-1">
              {TABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setFilter(t.id)}
                  className={`px-2 py-1 rounded text-[9px] font-mono tracking-wider transition-all ${filter === t.id ? 'bg-[var(--hover-accent)] text-[var(--text-primary)] border border-[var(--border-primary)]' : 'text-[var(--text-muted)] border border-transparent hover:text-[var(--text-secondary)]'}`}
                  style={
                    filter === t.id && t.id === 'ua' ? { color: '#FF1744', borderColor: 'rgba(255,23,68,0.5)' } :
                    filter === t.id && t.id === 'ru' ? { color: '#5B8FF9', borderColor: 'rgba(91,143,249,0.5)' } : undefined
                  }
                >
                  {t.label} {countFor(t.id)}
                </button>
              ))}
            </div>

            <div className={`${maximized ? 'max-h-[calc(100vh-180px)]' : 'max-h-[400px]'} overflow-y-auto styled-scrollbar divide-y divide-[var(--border-secondary)]`}>
              {news.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <span className="text-[11px] font-mono text-[var(--text-muted)] tracking-widest">
                    {isLoading ? 'LOADING INTEL FEED...' : 'AWAITING INTELLIGENCE...'}
                  </span>
                </div>
              ) : (
                news.slice(0, 40).map((item, i) => {
                  const itemKey = `${item.source ?? ''}-${item.published ?? ''}-${i}`;
                  const isOpen = openItems.has(itemKey);
                  // Strip leading title text from description to avoid showing the headline twice.
                  const rawDesc = item.description ?? '';
                  const titlePrefix = item.title ?? '';
                  const body = titlePrefix.length > 0 && rawDesc.startsWith(titlePrefix)
                    ? rawDesc.slice(titlePrefix.length).replace(/^[\s\n.,:;–—-]+/, '')
                    : rawDesc;
                  const hasBody = body.length > 20;
                  return (
                    <div
                      key={itemKey}
                      role="button"
                      tabIndex={0}
                      className="px-4 py-2.5 hover:bg-[var(--hover-accent)] transition-colors cursor-pointer"
                      onClick={() => toggleItem(itemKey)}
                      onKeyDown={(e) => { if (e.key === 'Enter') toggleItem(itemKey); }}
                    >
                      {/* Top row: risk badge + source + time */}
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[9px] font-mono font-bold tracking-widest ${getRiskClass(item.risk_score ?? 0)}`}>
                          {getRiskLabel(item.risk_score ?? 0)}
                        </span>
                        <span className="text-[8px] font-mono text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded">
                          {item.source}
                        </span>
                        {item.coords && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const c = item.coords;
                              if (c) onLocate?.(c[0], c[1]);
                            }}
                            className="text-[var(--text-muted)] hover:text-[var(--cyan-primary)] transition-colors"
                          >
                            <MapPin className="w-2.5 h-2.5" />
                          </button>
                        )}
                        <span className="text-[8px] font-mono text-[var(--text-muted)] ml-auto">
                          {timeAgo(item.published ?? '')}
                        </span>
                      </div>

                      {/* Title */}
                      <h4 className={`text-[11px] text-[var(--text-primary)] font-semibold leading-snug ${isOpen ? '' : 'line-clamp-2'}`}>
                        {item.title}
                      </h4>

                      {/* Body / full story */}
                      {hasBody && (
                        <p className={`text-[10px] text-[var(--text-secondary)] leading-snug mt-1 whitespace-pre-line ${isOpen ? '' : 'line-clamp-3'}`}>
                          {body}
                        </p>
                      )}

                      {/* Machine Assessment (if critical) */}
                      {item.machine_assessment && (
                        <div className="mt-1.5 flex items-start gap-1.5 bg-red-950/20 border border-red-900/20 rounded px-2 py-1">
                          <Zap className="w-2.5 h-2.5 text-red-400 flex-shrink-0 mt-0.5" />
                          <span className="text-[9px] font-mono text-red-400/80 leading-relaxed">
                            {item.machine_assessment}
                          </span>
                        </div>
                      )}

                      {/* Footer: expand hint + source link */}
                      <div className="mt-1.5 flex items-center justify-between">
                        {hasBody ? (
                          <span className="text-[8px] font-mono text-[var(--text-muted)] tracking-wider">
                            {isOpen ? '▲ COLLAPSE' : '▼ TAP TO EXPAND'}
                          </span>
                        ) : <span />}
                        {item.link && (
                          <a
                            href={item.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-[9px] font-mono text-[var(--cyan-primary)] hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="w-2.5 h-2.5" />
                            SOURCE
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );

  // When maximized, portal to document.body so `fixed inset-4` is viewport-relative —
  // otherwise the mobile drawer's framer-motion transform traps it and "maximize"
  // shrinks the panel instead of going fullscreen. (Mirrors MarketsPanel.)
  if (maximized && mounted && typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }

  return content;
}
