'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown, ChevronUp, MapPin, ExternalLink, AlertTriangle,
  Newspaper, Clock, Radio, Maximize2, Minimize2, X
} from 'lucide-react';

interface LiveAlertsProps {
  data: any;
  onLocate: (lat: number, lng: number) => void;
  onWatchFeed?: (url: string, name: string) => void;
}

const RISK_COLORS: Record<string, string> = {
  HIGH: '#FF3D3D',
  CRITICAL: '#FF1744',
  ELEVATED: '#FF9500',
  MODERATE: '#FFD700',
  LOW: '#00E676',
};

const TAB_META: Record<string, { flag?: string; text: string }> = {
  ukraine: { flag: '🇺🇦', text: 'UA WAR' },
  russia:  { flag: '🇷🇺', text: 'RU MILBLOG' },
  world:   { flag: '🌍', text: 'WORLD' },
};

const SESSION_STORAGE_KEY = 'osiris_dismissed_alerts';

// Module-level set survives re-renders and component remounts within the same JS module lifetime.
// Hydrated from sessionStorage on first use so dismissed IDs survive unmount/remount.
const seenAlertIds = new Set<string>();
let seenHydrated = false;

function hydrateSeenFromStorage() {
  if (seenHydrated || typeof sessionStorage === 'undefined') return;
  seenHydrated = true;
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) {
      const ids: string[] = JSON.parse(raw);
      ids.forEach(id => seenAlertIds.add(id));
    }
  } catch {}
}

function persistDismissed(id: string) {
  seenAlertIds.add(id);
  try {
    const ids = Array.from(seenAlertIds);
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(ids));
  } catch {}
}

function hashAlert(alert: any): string {
  const type = alert.type ?? 'unknown';
  const title = (alert.title ?? '').slice(0, 60);
  const source = alert.source ?? '';
  // Include the unique URL so distinct articles whose first 60 title chars match
  // (common for war headlines) don't collide into one id — which would produce
  // duplicate React keys and make a single dismiss drop multiple alerts.
  const url = alert.url ?? alert.link ?? '';
  return `${type}|${source}|${url}|${title}`;
}

export default function LiveAlerts({ data, onLocate, onWatchFeed }: LiveAlertsProps) {
  hydrateSeenFromStorage();

  const [expanded, setExpanded] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [filter, setFilter] = useState<'all' | 'ukraine' | 'russia' | 'world' | 'news' | 'quakes'>('all');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  // Track dismissed IDs in component state so the UI re-renders on dismiss.
  // seenAlertIds (module-level) is the authoritative source; this mirrors it for reactivity.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set(seenAlertIds));

  const toggleItem = (key: string) =>
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const dismissAlert = (id: string) => {
    persistDismissed(id);
    setDismissedIds(new Set(seenAlertIds));
  };

  const dismissGroup = (groupKey: string, groupAlerts: any[]) => {
    groupAlerts.forEach(a => persistDismissed(hashAlert(a)));
    setDismissedIds(new Set(seenAlertIds));
  };

  const BUILTIN_FEEDS = [
    // ── North America ──
    { name: 'NBC News NOW', city: 'New York', country: 'US', lat: 40.759, lng: -73.980, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCeY0bbntWzzVIaj2z3QigXg&autoplay=1&mute=1', category: 'mainstream', region: 'americas' },
    { name: 'CBS News 24/7', city: 'New York', country: 'US', lat: 40.764, lng: -73.973, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC8p1vwvWtl6T73JiExfWs1g&autoplay=1&mute=1', category: 'mainstream', region: 'americas' },
    { name: 'ABC News Live', city: 'New York', country: 'US', lat: 40.763, lng: -73.979, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCBi2mrWuNuyYy4gbM6fU18Q&autoplay=1&mute=1', category: 'mainstream', region: 'americas' },
    { name: 'Bloomberg TV', city: 'New York', country: 'US', lat: 40.756, lng: -73.988, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC_vQ72b7v5n2938v9d5c80w&autoplay=1&mute=1', category: 'finance', region: 'americas' },
    { name: 'C-SPAN', city: 'Washington DC', country: 'US', lat: 38.897, lng: -77.036, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCb--64Gl51jIEVE-GLDAVTg&autoplay=1&mute=1', category: 'government', region: 'americas' },
    { name: 'CBC News', city: 'Toronto', country: 'CA', lat: 43.644, lng: -79.387, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCKy1dAqELon0zgzZPOz9SVw&autoplay=1&mute=1', category: 'mainstream', region: 'americas' },
    // ── Europe ──
    { name: 'Sky News', city: 'London', country: 'GB', lat: 51.500, lng: -0.118, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCoMdktPbSTixAyNGwb-UYkQ&autoplay=1&mute=1', category: 'mainstream', region: 'europe' },
    { name: 'France 24 EN', city: 'Paris', country: 'FR', lat: 48.830, lng: 2.280, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCQfwfsi5VrQ8yKZ-UWmAEFg&autoplay=1&mute=1', category: 'mainstream', region: 'europe' },
    { name: 'DW News', city: 'Berlin', country: 'DE', lat: 52.508, lng: 13.376, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCknLrEdhRCp1aegoMqRaCZg&autoplay=1&mute=1', category: 'mainstream', region: 'europe' },
    { name: 'Euronews', city: 'Lyon', country: 'FR', lat: 45.764, lng: 4.836, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCtUbOIRGKZkW7555n6x6q6g&autoplay=1&mute=1', category: 'mainstream', region: 'europe' },
    { name: 'TRT World', city: 'Istanbul', country: 'TR', lat: 41.008, lng: 28.978, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC7fWeaHZQg1p9-4v98L1D1A&autoplay=1&mute=1', category: 'mainstream', region: 'europe' },
    { name: 'UKRINFORM', city: 'Kyiv', country: 'UA', lat: 50.450, lng: 30.523, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCaDkCK6iFHPE0lmpaYL-WxQ&autoplay=1&mute=1', category: 'conflict', region: 'europe' },
    { name: 'Espreso TV', city: 'Kyiv', country: 'UA', lat: 50.450, lng: 30.523, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCMEiyV8N2J93GdPNltPYM6w&autoplay=1&mute=1', category: 'conflict', region: 'europe' },
    { name: 'Kyiv Independent', city: 'Kyiv', country: 'UA', lat: 50.448, lng: 30.530, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCGAC5yzlYgjKoJABDZ7zEyw&autoplay=1&mute=1', category: 'conflict', region: 'europe' },
    { name: '5 Channel', city: 'Kyiv', country: 'UA', lat: 50.455, lng: 30.520, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCICQXUdfFxgMAlyxssw1-Vw&autoplay=1&mute=1', category: 'conflict', region: 'europe' },
    // ── Middle East ──
    { name: 'Al Jazeera EN', city: 'Doha', country: 'QA', lat: 25.286, lng: 51.534, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCNye-wNBqNL5ZzHSJj3l8Bg&autoplay=1&mute=1', category: 'mainstream', region: 'middleeast' },
    { name: 'Al Mayadeen', city: 'Beirut', country: 'LB', lat: 33.8886, lng: 35.4955, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCZCFHCU-2eGF7V5ciMkoPHw&autoplay=1&mute=1', category: 'conflict', region: 'middleeast' },
    { name: 'LBCI Lebanon', city: 'Beirut', country: 'LB', lat: 33.8930, lng: 35.5018, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCpE6gpKewomi17XDyPfpFjA&autoplay=1&mute=1', category: 'mainstream', region: 'middleeast' },
    // ── Asia Pacific ──
    { name: 'NHK World', city: 'Tokyo', country: 'JP', lat: 35.690, lng: 139.692, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCSPEjw8F2nQDtmUKPFNF7_A&autoplay=1&mute=1', category: 'mainstream', region: 'asia' },
    { name: 'CNA 24/7', city: 'Singapore', country: 'SG', lat: 1.290, lng: 103.852, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC83jt4dlz1Gjl58fzQrrKZg&autoplay=1&mute=1', category: 'mainstream', region: 'asia' },
    { name: 'WION', city: 'New Delhi', country: 'IN', lat: 28.614, lng: 77.209, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC_gUM8rL-Lrg6O3adPW9K1g&autoplay=1&mute=1', category: 'mainstream', region: 'asia' },
    { name: 'Arirang', city: 'Seoul', country: 'KR', lat: 37.566, lng: 126.978, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCw9-5Y1CjW7Qy1Yf5q1y2-Q&autoplay=1&mute=1', category: 'mainstream', region: 'asia' },
    { name: 'ABC AU', city: 'Sydney', country: 'AU', lat: -33.868, lng: 151.209, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC5iLnYoF4Ryb63YdGD9RfWQ&autoplay=1&mute=1', category: 'mainstream', region: 'asia' },
    // ── Africa ──
    { name: 'Africanews', city: 'Pointe-Noire', country: 'CG', lat: -4.778, lng: 11.865, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC5T2fB_W0Z31T0c8yN36a8A&autoplay=1&mute=1', category: 'mainstream', region: 'africa' },
    { name: 'SABC News', city: 'Johannesburg', country: 'ZA', lat: -26.204, lng: 28.047, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC8yH-uI81UUtEMDsowQyx1g&autoplay=1&mute=1', category: 'mainstream', region: 'africa' },
    // ── Latin America ──
    { name: 'teleSUR EN', city: 'Caracas', country: 'VE', lat: 10.491, lng: -66.902, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCmuTmpLY35O3csvhyA6vrkg&autoplay=1&mute=1', category: 'mainstream', region: 'americas' },
  ];

  const TELEGRAM_SOURCES = [
    { name: 'DeepState UA', channel: 'DeepStateUA', side: 'ua' },
    { name: 'WarTranslated', channel: 'wartranslated', side: 'ua' },
    { name: 'Liveuamap', channel: 'Liveuamap', side: 'ua' },
    { name: 'Militaryland', channel: 'Militaryland', side: 'ua' },
    { name: 'UA Insider', channel: 'UA_Insider', side: 'ua' },
    { name: 'UA General Staff', channel: 'GeneralStaffUA', side: 'ua' },
    { name: 'UA Forces', channel: 'ua_forces', side: 'ua' },
    { name: 'Ukraine War Report', channel: 'UkraineWarReport', side: 'ua' },
    { name: 'OSINTtechnical', channel: 'OSINTtechnical', side: 'ua' },
    { name: 'Faytuks', channel: 'Faytuks', side: 'ua' },
    { name: 'Суспільне Новини', channel: 'suspilne_news', side: 'ua' },
    { name: 'Громадське', channel: 'hromadske_ua', side: 'ua' },
    { name: 'Труха⚡️Україна', channel: 'truexanewsua', side: 'ua' },
    { name: 'Сергій Флеш', channel: 'serhii_flash', side: 'ua' },
    { name: 'Оперативно ЗСУ', channel: 'operativnoZSU', side: 'ua' },
    { name: 'Бутусов Плюс', channel: 'butusovplus', side: 'ua' },
    { name: 'Цаплієнко', channel: 'Tsaplienko', side: 'ua' },
    { name: 'Военный осведомитель', channel: 'milinfolive', side: 'ru' },
    { name: 'WarGonzo', channel: 'wargonzo', side: 'ru' },
    { name: 'Поддубный', channel: 'epoddubny', side: 'ru' },
    { name: 'Сладков+', channel: 'sashakots', side: 'ru' },
    { name: 'Два майора', channel: 'dva_majora', side: 'ru' },
    { name: 'Военкор Котенок', channel: 'voenkorKotenok', side: 'ru' },
    { name: 'Рыбарь', channel: 'rybar', side: 'ru' },
    { name: 'МО России', channel: 'mod_russia', side: 'ru' },
  ];

  // Build unified alert feed
  const allAlerts: any[] = [];

  if (data.news) {
    data.news.forEach((a: any) => {
      allAlerts.push({
        type: 'news', title: a.title, description: a.description, source: a.source,
        side: a.side || 'world',
        lat: a.coords?.[0], lng: a.coords?.[1], time: a.published,
        severity: (a.risk_score ?? 1) >= 8 ? 'CRITICAL' : (a.risk_score ?? 1) >= 6 ? 'HIGH' : (a.risk_score ?? 1) >= 4 ? 'ELEVATED' : 'LOW',
        url: a.link,
      });
    });
  }

  if (data.earthquakes) {
    data.earthquakes.slice(0, 5).forEach((eq: any) => {
      allAlerts.push({
        type: 'quake', title: `M${eq.magnitude} - ${eq.place}`, source: 'USGS',
        lat: eq.lat, lng: eq.lng, time: eq.time,
        severity: eq.magnitude >= 6 ? 'CRITICAL' : eq.magnitude >= 4.5 ? 'HIGH' : 'MODERATE',
      });
    });
  }

  // BUILTIN_FEEDS and TELEGRAM_SOURCES are rendered in a separate demoted "SOURCES" section
  // below the alert list — not in allAlerts — so they don't inflate counts or crowd live alerts.

  // Sort newest-first; feeds (no time) go to the end.
  allAlerts.sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return new Date(b.time).getTime() - new Date(a.time).getTime();
  });

  // Assign stable IDs and filter out dismissed alerts.
  const alertsWithIds = allAlerts.map(a => ({ ...a, _id: hashAlert(a) }));
  const visibleAlerts = alertsWithIds.filter(a => !dismissedIds.has(a._id));

  const filtered = filter === 'ukraine' ? visibleAlerts.filter(a => a.type === 'news' && a.side === 'ua') :
    filter === 'russia'  ? visibleAlerts.filter(a => a.type === 'news' && a.side === 'ru') :
    filter === 'world'   ? visibleAlerts.filter(a => a.type === 'news' && a.side === 'world') :
    filter === 'news'    ? visibleAlerts.filter(a => a.type === 'news') :
    filter === 'quakes'  ? visibleAlerts.filter(a => a.type === 'quake') :
    visibleAlerts;

  // Group by alert.type (fallback: alert.side, then 'general').
  const groupKey = (a: any): string => a.type ?? a.side ?? 'general';

  const groups: Map<string, any[]> = new Map();
  for (const a of filtered) {
    const k = groupKey(a);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(a);
  }

  const GROUP_LABEL: Record<string, string> = {
    news: 'NEWS INTEL',
    quake: 'SEISMIC',
    feed: 'LIVE FEEDS',
    general: 'GENERAL',
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'news': return Newspaper;
      case 'quake': return AlertTriangle;
      case 'feed': return Radio;
      default: return Newspaper;
    }
  };

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const content = (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.5, duration: 0.6 }}
      className={`glass-panel flex flex-col overflow-hidden pointer-events-auto transition-all duration-300 ${maximized ? 'fixed inset-4 z-[9999] bg-[#0a0a09]/95 backdrop-blur-3xl' : expanded ? 'shrink-0 h-[500px] max-h-[80vh] resize-y' : 'shrink-0'}`}
    >
      {/* Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        className="flex-shrink-0 flex items-center justify-between px-3 py-2 hover:bg-[var(--hover-accent)] transition-colors cursor-pointer outline-none border-b border-[rgba(255,255,255,0.05)] bg-[rgba(0,0,0,0.3)]"
      >
        <div className="flex items-center gap-2">
          <Radio className="w-3.5 h-3.5 text-[#FF4081]" />
          <span className="hud-text text-[10px] text-[var(--text-primary)]">LIVE ALERTS</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-[#FF4081] animate-osiris-pulse" />
          <button onClick={(e) => { e.stopPropagation(); setMaximized(!maximized); if (!expanded && !maximized) setExpanded(true); }} className="hover:text-white transition-colors" title={maximized ? "Restore" : "Maximize"}>
            {maximized ? <Minimize2 className="w-3 h-3 text-[var(--text-muted)]" /> : <Maximize2 className="w-3 h-3 text-[var(--text-muted)]" />}
          </button>
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={`flex flex-col flex-1 min-h-0 ${maximized ? 'bg-[#0a0a09]' : 'bg-transparent'}`}
          >
            {/* Filters */}
            <div className={`flex-shrink-0 flex flex-wrap gap-1 ${maximized ? 'px-6 py-4 border-b border-[#2A2A28] bg-[#111111]' : 'px-3 py-2 border-b border-[rgba(255,255,255,0.05)]'}`}>
              {(['all', 'ukraine', 'russia', 'world', 'news', 'quakes'] as const).map(f => {
                const meta = TAB_META[f] ?? { text: f.toUpperCase() };
                return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 rounded text-[10px] font-mono tracking-wider transition-all ${filter === f ? 'bg-[var(--cyan-primary)]/20 text-[var(--cyan-primary)] border border-[var(--cyan-primary)]/50' : 'text-[#8A8880] border border-transparent hover:text-[#E8E6E0] hover:bg-[#2A2A28]'}`}
                  style={
                    filter === f && f === 'ukraine' ? { color: '#FF1744', borderColor: 'rgba(255,23,68,0.5)' } :
                    filter === f && f === 'russia'  ? { color: '#5B8FF9', borderColor: 'rgba(91,143,249,0.5)' } : undefined
                  }
                >
                  <span className="inline-flex items-center gap-1 leading-none">
                    {meta.flag && <span>{meta.flag}</span>}
                    <span>{meta.text}</span>
                  </span>
                </button>
                );
              })}
            </div>

            {/* Alert List */}
            <div className={`flex-1 overflow-y-auto styled-scrollbar ${maximized ? 'p-6' : 'p-3'}`}>
              {groups.size === 0 ? (
                <div className="text-center py-4 text-[10px] font-mono text-[var(--text-muted)]">
                  No alerts for this filter
                </div>
              ) : (
                <div className="space-y-3">
                  {Array.from(groups.entries()).map(([gk, groupAlerts]) => (
                    <div key={gk}>
                      {/* Group header */}
                      <div className="flex items-center justify-between mb-1.5 px-1">
                        <span className="text-[9px] font-mono tracking-widest text-[var(--text-muted)] uppercase">
                          {GROUP_LABEL[gk] ?? gk.toUpperCase()} ({groupAlerts.length})
                        </span>
                        <button
                          onClick={() => dismissGroup(gk, groupAlerts)}
                          title="Dismiss all in group"
                          className="text-[8px] font-mono text-[#5C5A54] hover:text-[#FF4081] transition-colors flex items-center gap-1"
                        >
                          <X className="w-2.5 h-2.5" />
                          DISMISS ALL
                        </button>
                      </div>

                      <div className="space-y-2">
                        {groupAlerts.map((alert) => {
                          const Icon = getIcon(alert.type);
                          const sevColor = RISK_COLORS[alert.severity] || '#FFD700';
                          const isItemExpanded = expandedItems.has(alert._id);
                          const isNews = alert.type === 'news';
                          return (
                            <div
                              key={alert._id}
                              onClick={() => {
                                if (alert.lat !== undefined && alert.lng !== undefined) {
                                  onLocate(alert.lat, alert.lng);
                                }
                                if (alert.feedUrl && onWatchFeed) {
                                  onWatchFeed(alert.feedUrl, alert.title);
                                }
                              }}
                              className="w-full text-left p-2.5 rounded-lg bg-[#111111]/60 border border-[#2A2A28] hover:bg-[#1A1A1A] transition-all hover:border-[#3A3A38] group cursor-pointer"
                            >
                              <div className="flex items-start gap-2.5">
                                {/* Severity indicator */}
                                <div className="flex-shrink-0 mt-1">
                                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: sevColor, boxShadow: `0 0 6px ${sevColor}60` }} />
                                </div>

                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start gap-1.5 mb-1">
                                    <Icon className="w-3 h-3 flex-shrink-0 mt-0.5" style={{ color: sevColor }} />
                                    {isNews ? (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); toggleItem(alert._id); }}
                                        className="min-w-0 flex-1 text-left"
                                        title={isItemExpanded ? 'Collapse' : 'Show full text'}
                                      >
                                        {alert.title && (
                                          <span className={`block text-[10px] font-mono font-semibold text-[var(--text-primary)] leading-snug ${isItemExpanded ? '' : 'line-clamp-2'}`}>
                                            {alert.title}
                                          </span>
                                        )}
                                        {alert.description && alert.description !== alert.title && (
                                          <span className={`block text-[10px] font-mono text-[var(--text-secondary)] leading-snug mt-0.5 ${isItemExpanded ? '' : 'line-clamp-4'}`}>
                                            {alert.description}
                                          </span>
                                        )}
                                      </button>
                                    ) : (
                                      <span className="text-[10px] font-mono text-[var(--text-primary)] truncate leading-tight">
                                        {alert.title}
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center justify-between border-t border-[#2A2A28]/50 pt-1.5 mt-1.5">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[9px] font-mono text-[#8A8880] uppercase tracking-wider">{alert.source}</span>
                                      {alert.time && (
                                        <span className="text-[9px] font-mono text-[#5C5A54] flex items-center gap-1 border-l border-[#2A2A28] pl-2">
                                          <Clock className="w-2.5 h-2.5" />
                                          {new Date(alert.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                      )}
                                    </div>
                                    {alert.url && (
                                      <a
                                        href={alert.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[8px] font-mono text-[var(--cyan-primary)] hover:underline"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        SOURCE
                                      </a>
                                    )}
                                  </div>
                                </div>

                                {/* Right column: fly-to pin + dismiss button */}
                                <div className="flex flex-col items-center gap-1 flex-shrink-0 mt-0.5">
                                  {alert.lat !== undefined && (
                                    <MapPin className="w-3 h-3 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
                                  )}
                                  <button
                                    onClick={(e) => { e.stopPropagation(); dismissAlert(alert._id); }}
                                    title="Dismiss"
                                    className="opacity-0 group-hover:opacity-100 transition-opacity text-[#5C5A54] hover:text-[#FF4081]"
                                  >
                                    <X className="w-2.5 h-2.5" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Channel directory — demoted below the live alert stream ── */}
              <div className="flex-shrink-0 border-t border-[rgba(255,255,255,0.05)] mt-1">
                <button
                  onClick={() => setSourcesOpen(o => !o)}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-[9px] font-mono text-[#5C5A54] hover:text-[#8A8880] transition-colors"
                >
                  <span className="tracking-widest">SOURCES ({BUILTIN_FEEDS.length + TELEGRAM_SOURCES.length})</span>
                  {sourcesOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                {sourcesOpen && (
                  <div className="px-3 pb-2 grid grid-cols-2 gap-1 max-h-40 overflow-y-auto">
                    {BUILTIN_FEEDS.map(f => (
                      <button
                        key={f.url}
                        onClick={() => onWatchFeed?.(f.url, f.name)}
                        className="text-left text-[9px] font-mono text-[#8A8880] hover:text-[var(--cyan-primary)] truncate py-0.5"
                        title={`${f.name} — ${f.city}, ${f.country}`}
                      >
                        {f.name}
                      </button>
                    ))}
                    {TELEGRAM_SOURCES.map(t => (
                      <a
                        key={t.channel}
                        href={`https://t.me/s/${t.channel}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[9px] font-mono text-[#8A8880] hover:text-[var(--cyan-primary)] truncate py-0.5"
                        title={t.name}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {t.name}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );

  if (maximized && mounted && typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }

  return content;
}
