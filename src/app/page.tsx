'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import { Layers, BarChart3, Newspaper, Search, X, Globe, MapPinned, Radar, Satellite, Moon, ExternalLink, AlertTriangle, Activity, Database, Wifi, ChevronDown, ChevronUp, Bell, MoreHorizontal, Play, FileText, Network, Crosshair } from 'lucide-react';
import IntelFeed from '@/components/IntelFeed';
import MarketsPanel from '@/components/MarketsPanel';
import ScmPanel from '@/components/ScmPanel';
import SearchBar from '@/components/SearchBar';
import { buildEntityIndex, SearchEntity } from '@/lib/entitySearch';
import ScaleBar from '@/components/ScaleBar';
import ErrorBoundary from '@/components/ErrorBoundary';
import SharePanel from '@/components/SharePanel';
import ViewPresets from '@/components/ViewPresets';
import KeyboardShortcuts from '@/components/KeyboardShortcuts';
import GlobalStatusBar from '@/components/GlobalStatusBar';
import LiveAlerts from '@/components/LiveAlerts';
import FrontlineTracker from '@/components/FrontlineTracker';
import AxisBriefing from '@/components/AxisBriefing';
import ThresholdToasts from '@/components/ThresholdToasts';
import type { ThresholdAlert } from '@/app/api/threshold-alerts/route';
import NotificationDrawer, { type NotificationRecord } from '@/components/NotificationDrawer';
import CommandPalette, { type PaletteCommand } from '@/components/CommandPalette';
import ThreatFusionHUD from '@/components/ThreatFusionHUD';

const OsirisMap = dynamic(() => import('@/components/OsirisMap'), { ssr: false });
const LayerPanel = dynamic(() => import('@/components/LayerPanel'));
const CameraViewer = dynamic(() => import('@/components/CameraViewer'));
const OsintPanel = dynamic(() => import('@/components/OsintPanel'));
const EntityGraphPanel = dynamic(() => import('@/components/EntityGraphPanel'));

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Mobile if narrow, OR landscape phone (short height + moderate width)
      setIsMobile(w < 768 || (h < 500 && w < 1024));
    };
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);
  return isMobile;
}
const UptimeClock = () => {
  const [uptime, setUptime] = useState('--:--:--');
  // Server process uptime, seeded from /api/health (process.uptime, seconds) and
  // ticked locally between resyncs — NOT the time this page has been open.
  const baseRef = useRef<{ serverSec: number; at: number } | null>(null);
  const fmt = (sec: number) => {
    const e = Math.max(0, Math.floor(sec));
    return `${String(Math.floor(e/3600)).padStart(2,'0')}:${String(Math.floor((e%3600)/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`;
  };
  useEffect(() => {
    let alive = true;
    const sync = async () => {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        if (alive && typeof d.uptime === 'number') baseRef.current = { serverSec: d.uptime, at: Date.now() };
      } catch { /* keep last known base across transient failures */ }
    };
    sync();
    const resync = setInterval(sync, 60000);
    const tick = setInterval(() => {
      const b = baseRef.current;
      if (b) setUptime(fmt(b.serverSec + (Date.now() - b.at) / 1000));
    }, 1000);
    return () => { alive = false; clearInterval(resync); clearInterval(tick); };
  }, []);
  return <span className="hidden lg:inline">UPTIME: <span className="text-[var(--gold-primary)]">{uptime}</span></span>;
};

const ZuluClock = () => {
  const [time, setTime] = useState('');
  useEffect(() => {
    const iv = setInterval(() => {
      const now = new Date();
      setTime(`ZULU ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}:${String(now.getUTCSeconds()).padStart(2,'0')}Z`);
    }, 1000);
    return () => clearInterval(iv);
  }, []);
  return <span className="text-[var(--cyan-primary)] font-bold tabular-nums">{time || 'ZULU --:--:--Z'}</span>;
};

/** Real entity count — no fake throughput metrics */
const ActiveEntityCount = ({ data }: { data: Record<string, unknown[]> }) => {
  const count = useMemo(() => {
    if (!data) return 0;
    return Object.values(data).reduce((sum, v) => sum + (Array.isArray(v) ? v.length : 0), 0);
  }, [data]);
  return <span className="text-[var(--alert-green)] font-bold tabular-nums">{count.toLocaleString()}</span>;
};

/** Extracts a watchable YouTube URL from embed/channel URLs */
function getYouTubeWatchUrl(url: string): string {
  if (url.includes('channel=')) return `https://www.youtube.com/channel/${url.split('channel=')[1].split('&')[0]}/live`;
  if (url.includes('/embed/')) return `https://www.youtube.com/watch?v=${url.split('/embed/')[1].split('?')[0]}`;
  return url;
}

export default function Dashboard() {
  const dataRef = useRef<any>({});
  const [dataVersion, setDataVersion] = useState(0);
  const data = dataRef.current;

  const [backendStatus, setBackendStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [mapView, setMapView] = useState({ zoom: 2.5, latitude: 20, longitude: 25.48 });
  const [flyToLocation, setFlyToLocation] = useState<{ lat: number; lng: number; ts: number } | null>(null);
  const [highlight, setHighlight] = useState<{ lat: number; lng: number; ts: number } | null>(null);
  // Searchable index over every live entity array (rebuilt when data changes).
  const entityIndex = useMemo(() => buildEntityIndex(data), [dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const [globalStats, setGlobalStats] = useState<any>(null);
  const mouseCoordsRef = useRef<{ lat: number; lng: number } | null>(null);
  const coordsDisplayRef = useRef<HTMLDivElement>(null);
  const [locationLabel, setLocationLabel] = useState('');
  const [regionDossier, setRegionDossier] = useState<any>(null);
  const [dossierLoading, setDossierLoading] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [activeCamera, setActiveCamera] = useState<any>(null);
  const [spaceWeather, setSpaceWeather] = useState<any>(null);
  const [showLayers, setShowLayers] = useState(true);
  const [showMarkets, setShowMarkets] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [showScmPanel, setShowScmPanel] = useState(true);
  const [showIntel, setShowIntel] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showEntityGraph, setShowEntityGraph] = useState(false);
  const [showFusion, setShowFusion] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'layers'|'markets'|'intel'|'search'|'recon'|'more'|'frontline'|null>(null);
  const [mapProjection, setMapProjection] = useState<'globe'|'mercator'>('globe');
  const [mapStyle, setMapStyle] = useState<'dark'|'satellite'>('dark');
  const [sweepData, setSweepData] = useState<any>(null);
  const [scanTargets, setScanTargets] = useState<any[]>([]);
  const [entityGraphTarget, setEntityGraphTarget] = useState<{ type: string; id: string; label?: string; properties?: Record<string, any> } | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [osirisTheme, setOsirisTheme] = useState<'core'|'ghost'>('core');
  useEffect(() => {
    document.body.classList.toggle('theme-ghost', osirisTheme === 'ghost');
  }, [osirisTheme]);
  const [showFrontlineTracker, setShowFrontlineTracker] = useState(false);
  const [showAxisBriefing, setShowAxisBriefing] = useState(false);
  const [thresholdAlerts, setThresholdAlerts] = useState<ThresholdAlert[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notificationLog, setNotificationLog] = useState<NotificationRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const isMobile = useIsMobile();
  const startTime = useRef(Date.now());
  const geocodeCache = useRef<Map<string, string>>(new Map());
  const geocodeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastGeocodedPos = useRef<{ lat: number; lng: number } | null>(null);

  // ── DEFAULT: Most layers OFF — fast initial load ──
  const [activeLayers, setActiveLayers] = useState({
    flights: false,
    private: false,
    jets: false,
    military: false,
    maritime: true,
    ships: true,
    shadow_fleet: false,
    satellites: false,
    balloons: false,
    cctv: true,
    live_news: true,
    news_intel: true,
    earthquakes: true,
    fires: false,
    weather: false,
    radiation: false,
    infrastructure: false,
    global_incidents: true,
    gps_jamming: false,
    day_night: true,
    cables: true,
    sdk_sea: true,
    sdk_air: true,
    sdk_naval: true,
    sdk_ransomware: false,
    air_raids: false,
    power_outages: false,
    kab_threats: false,
    drone_threats: false,
    missile_threats: false,
    ru_air_raids: false,
    frontlines: false,
    captures: false,
    air_quality: false,
    thermal_aoi: false,
    thermal_aoi_fires_only: false,
    internet_outages: false,
    malware: false,
  });
  // Persist active layer toggles across restarts — read on mount, write on every change.
  // Skip the first write (count=1, initial defaults) so we don't overwrite saved state
  // with defaults before the restore effect has a chance to apply saved values.
  const layerPersistCountRef = useRef(0);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('osiris-layers');
      if (saved) setActiveLayers(prev => ({ ...prev, ...JSON.parse(saved) }));
    } catch {}
  }, []);
  useEffect(() => {
    layerPersistCountRef.current++;
    if (layerPersistCountRef.current < 2) return;
    try { localStorage.setItem('osiris-layers', JSON.stringify(activeLayers)); } catch {}
  }, [activeLayers]);

  const [liveFeedUrl, setLiveFeedUrl] = useState<string | null>(null);
  const [liveFeedName, setLiveFeedName] = useState('');
  const [liveFeedEmbedAllowed, setLiveFeedEmbedAllowed] = useState(true);
  // Splash screen
  useEffect(() => {
    const splashTimer = setTimeout(() => setShowSplash(false), 2500);
    return () => clearTimeout(splashTimer);
  }, []);

  // URL state: parse on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    const lat = parseFloat(p.get('lat') || '');
    const lon = parseFloat(p.get('lon') || '');
    const zoom = parseFloat(p.get('zoom') || '');
    if (!isNaN(lat) && !isNaN(lon)) {
      setFlyToLocation({ lat, lng: lon, ts: Date.now() });
      if (!isNaN(zoom)) setMapView(v => ({ ...v, zoom }));
    }
    const layers = p.get('layers');
    if (layers) {
      const active = layers.split(',');
      setActiveLayers(prev => {
        const next = { ...prev };
        Object.keys(next).forEach(k => { (next as any)[k] = active.includes(k); });
        return next;
      });
    }
  }, []);

  // URL state: update URL on view change (debounced)
  const urlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (urlTimer.current) clearTimeout(urlTimer.current);
    urlTimer.current = setTimeout(() => {
      const p = new URLSearchParams();
      p.set('lat', (mapView.latitude ?? 20).toFixed(4));
      p.set('lon', '0');
      p.set('zoom', mapView.zoom.toFixed(2));
      const active = Object.entries(activeLayers).filter(([,v]) => v).map(([k]) => k).join(',');
      p.set('layers', active);
      const url = `${window.location.pathname}?${p.toString()}`;
      window.history.replaceState(null, '', url);
    }, 1500);
  }, [mapView, activeLayers]);

  // Global Stats Fetch
  useEffect(() => {
    fetch('/api/stats')
      .then(res => res.json())
      .then(d => {
        if (d.stats) setGlobalStats(d.stats);
      })
      .catch(console.error);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as Element)?.tagName)) return;
      if (e.key === 'f' && !e.ctrlKey) {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
      }
      if (e.key === 'l') setShowLayers(p => !p);
      if (e.key === 'm') setShowMarkets(p => !p);
      if (e.key === 'c') setShowScmPanel(p => !p);
      if (e.key === 'i') setShowIntel(p => !p);
      if (e.key === 'r') setFlyToLocation({ lat: 20, lng: 0, ts: Date.now() });
      if (e.key === 'g') setMapProjection(p => p === 'globe' ? 'mercator' : 'globe');
    };
    const fsHandler = () => setIsFullscreen(!!document.fullscreenElement);
    window.addEventListener('keydown', handler);
    document.addEventListener('fullscreenchange', fsHandler);
    return () => { window.removeEventListener('keydown', handler); document.removeEventListener('fullscreenchange', fsHandler); };
  }, []);

  // Mouse coords + reverse geocode (Zero-Render)
  const handleMouseCoords = useCallback((coords: { lat: number; lng: number }) => {
    mouseCoordsRef.current = coords;
    if (coordsDisplayRef.current) {
      coordsDisplayRef.current.innerText = `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`;
    }
    if (geocodeTimer.current) clearTimeout(geocodeTimer.current);
    geocodeTimer.current = setTimeout(async () => {
      if (lastGeocodedPos.current) {
        const d = Math.abs(coords.lat - lastGeocodedPos.current.lat) + Math.abs(coords.lng - lastGeocodedPos.current.lng);
        if (d < 0.5) return; // increased threshold — fewer geocode calls
      }
      const gk = `${coords.lat.toFixed(1)},${coords.lng.toFixed(1)}`; // coarser grid = more cache hits
      if (geocodeCache.current.has(gk)) { setLocationLabel(geocodeCache.current.get(gk)!); lastGeocodedPos.current = coords; return; }
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${coords.lat}&lon=${coords.lng}&format=json&zoom=10&addressdetails=1`, { headers: { 'Accept-Language': 'en' } });
        if (res.ok) {
          const d = await res.json();
          const a = d.address || {};
          const label = [a.city||a.town||a.village||a.county, a.state||a.region, a.country].filter(Boolean).join(', ') || 'Unknown';
          if (geocodeCache.current.size > 500) { const it = geocodeCache.current.keys(); for (let i=0;i<100;i++) { const k = it.next().value; if(k) geocodeCache.current.delete(k); }}
          geocodeCache.current.set(gk, label);
          setLocationLabel(label);
          lastGeocodedPos.current = coords;
        }
      } catch (e) { console.warn('[OSIRIS] Suppressed error:', e instanceof Error ? e.message : e); }
    }, 3000); // 3s debounce (was 1.5s)
  }, []);

  // Region dossier (right-click)
  const handleRightClick = useCallback(async (coords: { lat: number; lng: number }) => {
    setDossierLoading(true); setRegionDossier(null);
    try {
      const res = await fetch(`/api/region-dossier?lat=${coords.lat}&lng=${coords.lng}`);
      if (res.ok) setRegionDossier(await res.json());
    } catch (e) { console.warn('[OSIRIS] Suppressed error:', e instanceof Error ? e.message : e); } finally { setDossierLoading(false); }
  }, []);
  // Entity click handler (hoisted from JSX to comply with Rules of Hooks - Fixes #113)
  const handleEntityClick = useCallback((entity: any) => {
    if (entity?.type === 'cctv') setActiveCamera(entity);
    if (entity?.type === 'live_news' && entity.url) {
      setLiveFeedUrl(entity.url);
      setLiveFeedName(entity.name);
      setLiveFeedEmbedAllowed(entity.embed_allowed !== false);
    }
  }, []);

  // Global handler for map popups to manually open the Intel Graph
  useEffect(() => {
    (window as any).openOsirisIntel = (entity: any) => {
      if (entity?.callsign || entity?.icao24) {
        setEntityGraphTarget({ type: 'aircraft', id: entity.callsign?.trim() || entity.icao24, label: entity.callsign?.trim() || entity.icao24, properties: { model: entity.model, registration: entity.registration, icao24: entity.icao24 } });
        setShowEntityGraph(true);
      } else if (entity?.type === 'vessel' || entity?.mmsi || entity?.imo) {
        setEntityGraphTarget({ type: 'vessel', id: entity.imo || entity.mmsi || entity.name, label: entity.name || entity.imo, properties: { flag: entity.flag, speed: entity.speed, destination: entity.destination } });
        setShowEntityGraph(true);
      } else if (entity?.type === 'ip' && entity?.ip) {
        setEntityGraphTarget({ type: 'ip', id: entity.ip, label: entity.ip, properties: { threat_type: entity.threat_type, status: entity.status } });
        setShowEntityGraph(true);
      } else if (entity?.type === 'country' && entity?.country) {
        setEntityGraphTarget({ type: 'country', id: entity.country, label: entity.country, properties: {} });
        setShowEntityGraph(true);
      }
    };
    return () => { delete (window as any).openOsirisIntel; };
  }, []);

  // ── SHARED FETCH UTILITY (Fixes #107 — single definition, not 3 copies) ──
  const fetchEndpoint = useCallback(async (url: string, transform?: (d: any) => any, options?: RequestInit) => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      // Force the browser to bypass its local disk cache for real-time data
      const res = await fetch(url, { ...options, cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        const d = transform ? transform(json) : json;
        // Don't clobber a previously-good non-empty array with a transient
        // empty one (e.g. Telegram rate-limit returns empty news). Keep last good.
        const merged: Record<string, any> = { ...dataRef.current };
        for (const [k, v] of Object.entries(d)) {
          if (Array.isArray(v) && v.length === 0 && Array.isArray(merged[k]) && merged[k].length > 0) continue;
          merged[k] = v;
        }
        dataRef.current = merged;
        setDataVersion(v => v + 1);
        setBackendStatus('connected');
      }
    } catch (e) {
      console.warn('[OSIRIS] Suppressed error:', e instanceof Error ? e.message : e);
      setBackendStatus('error');
    }
  }, []);

  // ── PROGRESSIVE DATA LOADING (request-optimized) ──
  useEffect(() => {
    // Priority 1: Core feeds (always needed for panels)
    fetchEndpoint('/api/earthquakes');
    fetchEndpoint('/api/news');
    const marketTimer = setTimeout(() => fetchEndpoint('/api/markets', d => ({ markets: d })), 800);

    // Priority 2: Space Weather (needed for MarketsPanel)
    const spaceTimer = setTimeout(async () => {
      try {
        const r = await fetch('/api/space-weather');
        if (r.ok) setSpaceWeather(await r.json());
      } catch (e) { console.warn('[OSIRIS] Suppressed error:', e instanceof Error ? e.message : e); }
    }, 5000);

    // Polling — OPTIMIZED intervals to minimize edge requests
    const intervals = [
      setInterval(() => fetchEndpoint('/api/earthquakes'), 900000),  // 15 min (was 5)
      setInterval(() => fetchEndpoint('/api/news'), 180000),         // 3 min (recover fast from transient empty)
      setInterval(() => fetchEndpoint('/api/markets', d => ({ markets: d })), 900000), // 15 min (was 5)
    ];
    return () => {
      clearTimeout(marketTimer);
      clearTimeout(spaceTimer);
      intervals.forEach(clearInterval);
    };
  }, [fetchEndpoint]);

  // ── LAYER-AWARE DATA LOADING — only fetch when layer is toggled ON ──
  const layerFetchedRef = useRef<Set<string>>(new Set());

  // Single source of truth for "how to fetch each layer's data" — shared by the
  // layer-toggle loader below and by the search bar's ensureSearchSources().
  const LAYER_LOADERS: Record<string, () => void> = useMemo(() => ({
    flights: () => fetchEndpoint('/api/flights'),
    satellites: () => fetchEndpoint('/api/satellites'),
    fires: () => fetchEndpoint('/api/fires'),
    cctv: () => fetchEndpoint('/api/cctv?region=all&v=2'),
    maritime: () => fetchEndpoint('/api/maritime', d => ({ maritime_ports: d.ports, maritime_chokepoints: d.chokepoints, maritime_ships: d.ships })),
    balloons: () => fetchEndpoint('/api/balloons', d => ({ balloons: d.balloons })),
    radiation: () => fetchEndpoint('/api/radiation', d => ({ radiation: d.stations })),
    live_news: () => fetchEndpoint('/api/live-news', d => ({ live_feeds: d.feeds })),
    weather: () => fetchEndpoint('/api/weather', d => ({ weather_events: d.events })),
    infrastructure: () => fetchEndpoint('/api/infrastructure', d => ({ infrastructure: d.infrastructure })),
    gdelt: () => fetchEndpoint('/api/gdelt', d => ({ gdelt: d.events })),
    air_raids: () => fetchEndpoint('/api/air-raids', d => ({ air_raids: d.alerts })),
    power_outages: () => fetchEndpoint('/api/power-outages', d => ({ power_outages: d.outages })),
    kab_threats: () => fetchEndpoint('/api/kab-threats', d => ({ kab_threats: d.threats })),
    weapon_threats: () => fetchEndpoint('/api/weapon-threats', d => ({ weapon_threats: d.threats })),
    drone_threats: () => fetchEndpoint('/api/drone-threats', d => ({ drone_threats: d.threats, drone_waves: d.waves })),
    missile_threats: () => fetchEndpoint('/api/missile-threats', d => ({ missile_routes: d.routes })),
    ru_air_raids: () => fetchEndpoint('/api/ru-air-raids', d => ({ ru_air_raids: d.events })),
    frontlines: () => fetchEndpoint('/api/frontlines', d => ({ frontlines: d.frontlines?.features || [] })),
    captures: () => fetchEndpoint('/api/captures', d => ({ captures: d.captures })),
    air_quality: () => fetchEndpoint('/api/air-quality', d => ({ air_quality: d.stations })),
    thermal_aoi: () => fetchEndpoint('/api/strategic-thermal', d => ({ thermal_aoi: d.aois })),
    internet_outages: () => fetchEndpoint('/api/radar', d => ({ ioda_outages: d.outages })),
    malware: () => fetchEndpoint('/api/malware', d => ({ malware_threats: d.threats })),
  }), [fetchEndpoint]);

  // Fetch a source at most once (does NOT toggle the layer on).
  const loadOnce = useCallback((key: string) => {
    if (layerFetchedRef.current.has(key) || !LAYER_LOADERS[key]) return;
    layerFetchedRef.current.add(key);
    LAYER_LOADERS[key]();
  }, [LAYER_LOADERS]);

  // Pull every searchable entity source once so the search bar can locate any
  // entity by name even while its layer is hidden. Called when search is opened.
  const ensureSearchSources = useCallback(() => {
    ['flights', 'satellites', 'cctv', 'maritime', 'radiation', 'live_news', 'weather', 'infrastructure', 'gdelt', 'kab_threats', 'power_outages'].forEach(loadOnce);
  }, [loadOnce]);

  // Picking an entity from search: fly to it, reveal its layer, and highlight it.
  const handleSelectEntity = useCallback((e: SearchEntity) => {
    const ts = Date.now();
    setFlyToLocation({ lat: e.lat, lng: e.lng, ts });
    setHighlight({ lat: e.lat, lng: e.lng, ts });
    if (e.layerKey) setActiveLayers(prev => ({ ...prev, [e.layerKey]: true }) as typeof prev);
  }, []);

  // ── LAYER-AWARE DATA LOADING — only fetch when layer is toggled ON ──
  useEffect(() => {
    if (activeLayers.flights || activeLayers.military || activeLayers.jets || activeLayers.private) loadOnce('flights');
    if (activeLayers.satellites) loadOnce('satellites');
    if (activeLayers.fires) loadOnce('fires');
    if (activeLayers.cctv) loadOnce('cctv');
    if (activeLayers.maritime || activeLayers.ships || activeLayers.shadow_fleet) loadOnce('maritime');
    if (activeLayers.balloons) loadOnce('balloons');
    if (activeLayers.radiation) loadOnce('radiation');
    if (activeLayers.live_news) loadOnce('live_news');
    if (activeLayers.weather) loadOnce('weather');
    if (activeLayers.infrastructure) loadOnce('infrastructure');
    if (activeLayers.global_incidents) loadOnce('gdelt');
    if (activeLayers.air_raids) loadOnce('air_raids');
    if (activeLayers.power_outages) loadOnce('power_outages');
    if (activeLayers.kab_threats) loadOnce('kab_threats');
    if (activeLayers.air_raids) loadOnce('weapon_threats'); // enriches air-raid popups
    if (activeLayers.drone_threats) loadOnce('drone_threats');
    if (activeLayers.missile_threats) loadOnce('missile_threats');
    if (activeLayers.ru_air_raids) loadOnce('ru_air_raids');
    if (activeLayers.frontlines) loadOnce('frontlines');
    if (activeLayers.captures) loadOnce('captures');
    if (activeLayers.air_quality) loadOnce('air_quality');
    if (activeLayers.thermal_aoi) loadOnce('thermal_aoi');
    if (activeLayers.internet_outages) loadOnce('internet_outages');
    if (activeLayers.malware) loadOnce('malware');
  }, [activeLayers, loadOnce]);

  // Background pre-fetch: populate LayerPanel counts for every layer
  // regardless of whether the user has toggled it on. Runs once, 3 s after
  // mount (after priority-1 loads settle). loadOnce() skips keys already fetched.
  useEffect(() => {
    const t = setTimeout(() => {
      ['flights', 'air_raids', 'kab_threats', 'power_outages',
       'frontlines', 'captures', 'thermal_aoi', 'satellites',
       'fires', 'weather', 'infrastructure', 'gdelt',
       'maritime', 'radiation', 'live_news', 'cctv',
       'air_quality', 'internet_outages', 'malware',
       'weapon_threats', 'drone_threats', 'missile_threats', 'ru_air_raids'].forEach(loadOnce);
    }, 3000);
    return () => clearTimeout(t);
  }, [loadOnce]);

  // Submarine Cables (UI overhaul) — static dataset, fetched once on toggle.
  useEffect(() => {
    if (activeLayers.cables && !layerFetchedRef.current.has('cables')) {
      (async () => {
        try {
          const ts = Date.now();
          const res = await fetch(`/data/submarine-cables.json?v=${ts}`);
          if (res.ok) {
            const cablesData = await res.json();
            dataRef.current = { ...dataRef.current, submarine_cables: cablesData.features };
            setDataVersion(v => v + 1);
          }
        } catch { console.warn('Cables fetch failed'); }
      })();
      layerFetchedRef.current.add('cables');
    }

  }, [activeLayers]);

  // ── LAYER-AWARE POLLING — only poll data for active layers ──
  useEffect(() => {
    const intervals: ReturnType<typeof setInterval>[] = [];
    if (activeLayers.flights || activeLayers.military || activeLayers.jets || activeLayers.private) {
      intervals.push(setInterval(() => fetchEndpoint('/api/flights'), 300000)); // 5 min (was 2 min)
    }

    if (activeLayers.balloons) {
      intervals.push(setInterval(() => fetchEndpoint('/api/balloons', d => ({ balloons: d.balloons })), 300000)); // 5m
    }
    if (activeLayers.radiation) {
      intervals.push(setInterval(() => fetchEndpoint('/api/radiation', d => ({ radiation: d.stations })), 300000)); // 5m
    }
    if (activeLayers.maritime || activeLayers.ships || activeLayers.shadow_fleet) {
      intervals.push(setInterval(() => fetchEndpoint('/api/maritime', d => ({ maritime_ports: d.ports, maritime_chokepoints: d.chokepoints, maritime_ships: d.ships })), 10000)); // 10s
    }
    if (activeLayers.air_raids) {
      intervals.push(setInterval(() => fetchEndpoint('/api/air-raids', d => ({ air_raids: d.alerts })), 60000)); // 1 min
    }
    if (activeLayers.kab_threats) {
      intervals.push(setInterval(() => fetchEndpoint('/api/kab-threats', d => ({ kab_threats: d.threats })), 60000)); // 1 min
    }
    if (activeLayers.drone_threats) {
      intervals.push(setInterval(() => fetchEndpoint('/api/drone-threats', d => ({ drone_threats: d.threats, drone_waves: d.waves })), 60000)); // 1 min — "last 1.5h" data
    }
    if (activeLayers.missile_threats) {
      intervals.push(setInterval(() => fetchEndpoint('/api/missile-threats', d => ({ missile_routes: d.routes })), 60000)); // 1 min — "last 1.5h" data
    }
    if (activeLayers.power_outages) {
      intervals.push(setInterval(() => fetchEndpoint('/api/power-outages', d => ({ power_outages: d.outages })), 300000)); // 5 min
    }
    if (activeLayers.frontlines) {
      intervals.push(setInterval(() => fetchEndpoint('/api/frontlines', d => ({ frontlines: d.frontlines?.features || [] })), 1800000)); // 30 min
    }
    if (activeLayers.air_quality) {
      intervals.push(setInterval(() => fetchEndpoint('/api/air-quality', d => ({ air_quality: d.stations })), 3600000)); // 1 h
    }
    if (activeLayers.thermal_aoi) {
      intervals.push(setInterval(() => fetchEndpoint('/api/strategic-thermal', d => ({ thermal_aoi: d.aois })), 3600000)); // 1 h
    }
    if (activeLayers.captures) {
      intervals.push(setInterval(() => fetchEndpoint('/api/captures', d => ({ captures: d.captures })), 300000)); // 5 min
    }
    if (activeLayers.global_incidents) {
      intervals.push(setInterval(() => fetchEndpoint('/api/gdelt', d => ({ gdelt: d.events })), 300000)); // 5 min
    }
    return () => intervals.forEach(clearInterval);
  }, [activeLayers, fetchEndpoint]);

  // CCTV: loaded once on layer toggle via layerFetchedRef (no viewport polling)

  // ── THRESHOLD ALERTS — poll every 5 min ──
  useEffect(() => {
    const check = () =>
      fetch('/api/threshold-alerts')
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j?.alerts) setThresholdAlerts(j.alerts); })
        .catch(() => {});
    check();
    const iv = setInterval(check, 300_000);
    return () => clearInterval(iv);
  }, []);

  // ── NOTIFICATION LOG — accumulate from threshold alerts ──
  useEffect(() => {
    if (!thresholdAlerts.length) return;
    setNotificationLog(prev => {
      const existingIds = new Set(prev.map(n => n.id));
      const fresh = thresholdAlerts
        .filter(a => !existingIds.has(a.id))
        .map(a => ({ ...a, seenAt: Date.now() }));
      if (!fresh.length) return prev;
      setUnreadCount(c => c + fresh.length);
      return [...fresh, ...prev].slice(0, 200);
    });
  }, [thresholdAlerts]);

  // Reactive layer fetch: handled by layerFetchedRef above (no duplicate)

  // ── OSIRIS SDK — Intelligence Fusion Layer ──
  // Produces node coordinates for the SDK network mesh visualization.
  // Does NOT duplicate existing layer visuals — SDK layer is LINES ONLY.
  // Cameras are excluded — they have their own dedicated layer.
  useEffect(() => {
    const anyActive = activeLayers.sdk_sea || activeLayers.sdk_air || activeLayers.sdk_naval;
    if (!anyActive) {
      dataRef.current = { ...dataRef.current, sdk_entities: [] };
      return;
    }

    const sdkEntities: any[] = [];

    // Air domain (nodes only — no visual duplication)
    const allFlights = [
      ...(data.commercial_flights || []),
      ...(data.private_flights || []),
      ...(data.private_jets || []),
      ...(data.military_flights || []),
    ];
    // Sample flights to keep it clean (every Nth)
    const flightStep = Math.max(1, Math.floor(allFlights.length / 60));
    for (let i = 0; i < allFlights.length; i += flightStep) {
      const f = allFlights[i];
      if (!f.lat || !f.lng) continue;
      sdkEntities.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
        properties: { domain: 'AIR', name: f.callsign?.trim() || 'TRACK', source: 'ADS-B / OpenSky' },
      });
    }

    // Sea domain
    const ships = data.maritime_ships || [];
    const shipStep = Math.max(1, Math.floor(ships.length / 60));
    for (let i = 0; i < ships.length; i += shipStep) {
      const s = ships[i];
      if (!s.lat || !s.lng) continue;
      sdkEntities.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: { domain: 'SEA', name: s.name || `MMSI-${s.mmsi}`, source: 'AIS Stream' },
      });
    }

    // Events — Earthquakes
    if (data.earthquakes?.length) {
      for (const eq of data.earthquakes) {
        if (!eq.lat || !eq.lng) continue;
        sdkEntities.push({
          type: 'Feature', geometry: { type: 'Point', coordinates: [eq.lng, eq.lat] },
          properties: { domain: 'LAND', name: `M${eq.magnitude} ${eq.place || ''}`, source: 'USGS' },
        });
      }
    }

    // GDELT events
    if (data.gdelt?.length) {
      for (const g of data.gdelt) {
        if (!g.lat || !g.lng) continue;
        sdkEntities.push({
          type: 'Feature', geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
          properties: { domain: 'INTEL', name: g.name || 'GDELT Event', source: 'GDELT Project' },
        });
      }
    }

    // News intel
    if (data.news?.length) {
      for (const n of data.news) {
        if (!n.coords || n.coords.length < 2) continue;
        sdkEntities.push({
          type: 'Feature', geometry: { type: 'Point', coordinates: [n.coords[1], n.coords[0]] },
          properties: { domain: 'INTEL', name: n.title || 'SIGINT', source: n.source || 'RSS Feed' },
        });
      }
    }

    dataRef.current = { ...dataRef.current, sdk_entities: sdkEntities };
  }, [dataVersion, activeLayers.sdk_sea, activeLayers.sdk_air, activeLayers.sdk_naval]);

  const flyTo = useCallback((lat: number, lng: number, zoom?: number) => {
    setFlyToLocation({ lat, lng, ts: Date.now() });
    if (zoom) setMapView(v => ({ ...v, zoom }));
  }, []);
  const closeRightPanels = useCallback(() => {
    setShowIntel(false); setShowMarkets(false); setShowAlerts(false);
    setShowEntityGraph(false); setShowSearch(false); setShowFusion(false);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }, []);

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    type LayerKey = keyof typeof activeLayers;
    const LAYER_DEFS: { key: LayerKey; label: string; hint: string }[] = [
      { key: 'flights' as LayerKey, label: 'Commercial Flights', hint: 'ADS-B / OpenSky' },
      { key: 'private' as LayerKey, label: 'Private Aircraft', hint: 'ADS-B' },
      { key: 'jets' as LayerKey, label: 'Private Jets', hint: 'ADS-B' },
      { key: 'military' as LayerKey, label: 'Military Aircraft', hint: 'ADS-B' },
      { key: 'maritime' as LayerKey, label: 'Maritime / Naval', hint: 'Ports · Ships' },
      { key: 'satellites' as LayerKey, label: 'Satellites', hint: 'Orbital tracking' },
      { key: 'cctv' as LayerKey, label: 'CCTV Cameras', hint: 'Public traffic cams' },
      { key: 'earthquakes' as LayerKey, label: 'Earthquakes', hint: 'USGS M2.5+' },
      { key: 'fires' as LayerKey, label: 'Active Fires', hint: 'NASA FIRMS' },
      { key: 'weather' as LayerKey, label: 'Severe Weather', hint: 'EONET + NWS + GDACS' },
      { key: 'global_incidents' as LayerKey, label: 'Global Incidents', hint: 'GDELT events' },
      { key: 'malware' as LayerKey, label: 'Live Malware', hint: 'abuse.ch feed' },
      { key: 'frontlines' as LayerKey, label: 'Frontlines', hint: 'DeepState / Militaryland' },
      { key: 'drone_threats' as LayerKey, label: 'Drone Threats', hint: 'UA threat feed' },
      { key: 'gps_jamming' as LayerKey, label: 'GPS Jamming', hint: 'Interference zones' },
    ].filter(l => l.key in activeLayers);
    const cmds: PaletteCommand[] = [];
    for (const l of LAYER_DEFS) {
      const on = !!activeLayers[l.key];
      cmds.push({ id: `layer:${String(l.key)}`, group: 'LAYERS', title: `${on ? 'Hide' : 'Show'} ${l.label}`, subtitle: l.hint, keywords: `layer toggle ${l.label} ${l.hint}`, icon: <Layers className="w-4 h-4" />, badge: on ? 'ON' : 'OFF', active: on, keepOpen: true, run: () => setActiveLayers(prev => ({ ...prev, [l.key]: !prev[l.key] })) });
    }
    const NAV = [
      { label: 'Ukraine', hint: 'Active conflict', lat: 49, lng: 32, zoom: 6 },
      { label: 'Global View', hint: 'Whole earth', lat: 20, lng: 0, zoom: 2.5 },
      { label: 'Middle East', hint: 'Regional theatre', lat: 30, lng: 45, zoom: 4.5 },
      { label: 'Gaza / Israel', hint: 'Conflict zone', lat: 31.5, lng: 34.7, zoom: 8 },
      { label: 'Taiwan Strait', hint: 'Flashpoint', lat: 24.5, lng: 120, zoom: 6.5 },
      { label: 'Kyiv', hint: 'Capital', lat: 50.45, lng: 30.52, zoom: 9 },
      { label: 'Moscow', hint: 'Capital', lat: 55.75, lng: 37.62, zoom: 9 },
    ];
    for (const n of NAV) {
      cmds.push({ id: `nav:${n.label}`, group: 'NAVIGATE', title: `Fly to ${n.label}`, subtitle: n.hint, keywords: `go navigate ${n.label}`, icon: <Crosshair className="w-4 h-4" />, run: () => flyTo(n.lat, n.lng, n.zoom) });
    }
    cmds.push(
      { id: 'panel:recon', group: 'TOOLS', title: 'Open RECON / OSINT Toolkit', subtitle: 'Scanner · WHOIS · DNS', keywords: 'recon osint scanner', icon: <Radar className="w-4 h-4" />, run: () => { closeRightPanels(); setShowIntel(true); } },
      { id: 'panel:markets', group: 'TOOLS', title: 'Open Markets & Intel', subtitle: 'Indices · commodities', keywords: 'markets stocks', icon: <BarChart3 className="w-4 h-4" />, run: () => { closeRightPanels(); setShowMarkets(true); } },
      { id: 'panel:alerts', group: 'TOOLS', title: 'Open Live Alerts', subtitle: 'Real-time event stream', keywords: 'alerts warnings', icon: <AlertTriangle className="w-4 h-4" />, run: () => { closeRightPanels(); setShowAlerts(true); } },
      { id: 'panel:graph', group: 'TOOLS', title: 'Open Entity Graph', subtitle: 'Link analysis & fusion', keywords: 'entity graph network', icon: <Network className="w-4 h-4" />, run: () => { closeRightPanels(); setShowEntityGraph(true); } },
      { id: 'disp:proj', group: 'DISPLAY', title: mapProjection === 'globe' ? 'Switch to 2D Map' : 'Switch to 3D Globe', subtitle: 'Map projection', keywords: 'globe mercator 2d 3d', icon: <Globe className="w-4 h-4" />, badge: mapProjection === 'globe' ? 'GLOBE' : 'FLAT', active: mapProjection === 'globe', keepOpen: true, run: () => setMapProjection(p => p === 'globe' ? 'mercator' : 'globe') },
      { id: 'disp:style', group: 'DISPLAY', title: mapStyle === 'dark' ? 'Satellite Imagery' : 'Night / Dark Basemap', subtitle: 'Basemap style', keywords: 'satellite dark basemap', icon: <Satellite className="w-4 h-4" />, badge: mapStyle === 'satellite' ? 'SAT' : 'DARK', active: mapStyle === 'satellite', keepOpen: true, run: () => setMapStyle(s => s === 'dark' ? 'satellite' : 'dark') },
      { id: 'disp:theme', group: 'DISPLAY', title: osirisTheme === 'ghost' ? 'Core Protocol (Gold)' : 'Ghost Protocol (Violet)', subtitle: 'Interface theme', keywords: 'theme ghost core gold violet', icon: <Moon className="w-4 h-4" />, badge: osirisTheme === 'ghost' ? 'GHOST' : 'CORE', active: osirisTheme === 'ghost', keepOpen: true, run: () => setOsirisTheme(t => t === 'core' ? 'ghost' : 'core') },
      { id: 'disp:fs', group: 'DISPLAY', title: 'Toggle Fullscreen', subtitle: 'Immersive mode', keywords: 'fullscreen', icon: <MapPinned className="w-4 h-4" />, run: toggleFullscreen },
    );
    return cmds;
  }, [activeLayers, mapProjection, mapStyle, osirisTheme, flyTo, closeRightPanels, toggleFullscreen]);

  const totalFlights = useMemo(() => (
    (data.commercial_flights?.length||0)+(data.private_flights?.length||0)+(data.private_jets?.length||0)+(data.military_flights?.length||0)
  ), [data.commercial_flights, data.private_flights, data.private_jets, data.military_flights]);


  return (
    <main className="fixed inset-0 w-full h-full bg-[var(--bg-void)] overflow-hidden">

      {/* ── SPLASH ── */}
      <AnimatePresence>
        {showSplash && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: 'easeInOut' }}
            className="absolute inset-0 z-[999] flex flex-col items-center justify-center overflow-hidden"
            style={{ background: 'radial-gradient(ellipse at center, #0a0a14 0%, var(--bg-void) 70%)' }}
          >
            {/* ── Scanline CRT overlay ── */}
            <div className="absolute inset-0 pointer-events-none z-[1]" style={{
              backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(212,175,55,0.015) 2px, rgba(212,175,55,0.015) 4px)',
              animation: 'splashScanDrift 8s linear infinite',
            }} />

            {/* ── V4.2 badge — top-left ── */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.6 }}
              transition={{ delay: 0.8, duration: 0.5 }}
              className="absolute top-6 left-6 z-[2] font-mono text-[10px] tracking-[0.3em] text-[var(--gold-primary)]"
            >
              V4.2
            </motion.div>



            {/* ── Geometric tactical logo ── */}
            <div className="relative w-40 h-40 mb-8 flex items-center justify-center z-[2]">
              {/* Outer ring — slow clockwise */}
              <motion.div
                initial={{ opacity: 0, scale: 0.6, rotate: 0 }}
                animate={{ opacity: 1, scale: 1, rotate: 360 }}
                transition={{ opacity: { duration: 0.6 }, scale: { duration: 0.8, ease: 'easeOut' }, rotate: { duration: 20, repeat: Infinity, ease: 'linear' } }}
                className="absolute inset-0 rounded-full"
                style={{ border: '1px solid rgba(212,175,55,0.2)' }}
              >
                <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full" style={{ background: 'var(--gold-primary)', boxShadow: '0 0 12px var(--gold-primary), 0 0 24px rgba(212,175,55,0.3)' }} />
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-1 h-1 rounded-full" style={{ background: 'rgba(212,175,55,0.5)', boxShadow: '0 0 6px rgba(212,175,55,0.3)' }} />
              </motion.div>

              {/* Middle ring — faster counter-clockwise */}
              <motion.div
                initial={{ opacity: 0, scale: 0.4, rotate: 0 }}
                animate={{ opacity: 1, scale: 1, rotate: -360 }}
                transition={{ opacity: { duration: 0.6, delay: 0.15 }, scale: { duration: 0.8, delay: 0.15, ease: 'easeOut' }, rotate: { duration: 12, repeat: Infinity, ease: 'linear' } }}
                className="absolute rounded-full"
                style={{ inset: '18px', border: '1px solid rgba(0,229,255,0.15)' }}
              >
                <div className="absolute top-1/2 right-0 translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full" style={{ background: 'var(--cyan-primary)', boxShadow: '0 0 10px var(--cyan-primary), 0 0 20px rgba(0,229,255,0.2)' }} />
                <div className="absolute bottom-0 left-1/4 translate-y-1/2 w-1 h-1 rounded-full" style={{ background: 'rgba(0,229,255,0.4)' }} />
              </motion.div>

              {/* Inner ring — fastest clockwise */}
              <motion.div
                initial={{ opacity: 0, scale: 0.2, rotate: 0 }}
                animate={{ opacity: 1, scale: 1, rotate: 360 }}
                transition={{ opacity: { duration: 0.6, delay: 0.3 }, scale: { duration: 0.8, delay: 0.3, ease: 'easeOut' }, rotate: { duration: 7, repeat: Infinity, ease: 'linear' } }}
                className="absolute rounded-full"
                style={{ inset: '40px', border: '1px solid rgba(212,175,55,0.25)' }}
              >
                <div className="absolute top-0 left-1/4 -translate-y-1/2 w-1.5 h-1.5 rounded-full" style={{ background: 'var(--gold-primary)', boxShadow: '0 0 8px var(--gold-primary)' }} />
              </motion.div>

              {/* Core circle + crosshair */}
              <motion.div
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.4, duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
                className="relative w-12 h-12 rounded-full flex items-center justify-center"
                style={{ border: '2px solid var(--gold-primary)', boxShadow: '0 0 20px rgba(212,175,55,0.15), inset 0 0 20px rgba(212,175,55,0.05)' }}
              >
                <motion.div
                  animate={{ opacity: [0.3, 0.8, 0.3] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                  className="w-5 h-5 rounded-full"
                  style={{ background: 'radial-gradient(circle, rgba(212,175,55,0.4) 0%, rgba(212,175,55,0.05) 70%)' }}
                />
                {/* Crosshair lines */}
                <div className="absolute w-[1px] h-full" style={{ background: 'linear-gradient(to bottom, transparent, rgba(212,175,55,0.3), transparent)' }} />
                <div className="absolute w-full h-[1px]" style={{ background: 'linear-gradient(to right, transparent, rgba(212,175,55,0.3), transparent)' }} />
              </motion.div>

              {/* Faint pulsing radar sweep */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.15, 0], rotate: [0, 360] }}
                transition={{ opacity: { duration: 3, repeat: Infinity }, rotate: { duration: 3, repeat: Infinity, ease: 'linear' }, delay: 0.6 }}
                className="absolute inset-[10px] rounded-full"
                style={{ background: 'conic-gradient(from 0deg, transparent 0deg, rgba(212,175,55,0.15) 40deg, transparent 80deg)' }}
              />
            </div>

            {/* ── OSIRIS title — letter-by-letter stagger ── */}
            <div className="flex items-center gap-[2px] mb-3 z-[2]">
              {'OSIRIS'.split('').map((letter, i) => (
                <motion.span
                  key={i}
                  initial={{ opacity: 0, y: 20, filter: 'blur(8px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  transition={{ delay: 0.5 + i * 0.08, duration: 0.5, ease: 'easeOut' }}
                  className="text-4xl md:text-5xl font-bold tracking-[0.5em] font-mono"
                  style={{ color: 'var(--text-heading)', textShadow: '0 0 30px rgba(212,175,55,0.2)' }}
                >
                  {letter}
                </motion.span>
              ))}
            </div>

            {/* ── Subtitle — typewriter reveal ── */}
            <div className="overflow-hidden mb-8 z-[2]">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: '100%' }}
                transition={{ delay: 1.2, duration: 0.8, ease: 'easeInOut' }}
                className="overflow-hidden whitespace-nowrap"
              >
                <p className="text-[10px] md:text-[11px] font-mono tracking-[0.5em] text-[var(--gold-primary)]" style={{ opacity: 0.8 }}>
                  GLOBAL INTELLIGENCE PLATFORM
                </p>
              </motion.div>
            </div>

            {/* ── Multi-stage progress bar ── */}
            <div className="w-64 md:w-80 z-[2]">
              {/* Thin progress track */}
              <div className="relative w-full h-[2px] rounded-full overflow-hidden" style={{ background: 'rgba(212,175,55,0.1)' }}>
                <motion.div
                  initial={{ width: '0%' }}
                  animate={{ width: ['0%', '25%', '50%', '78%', '100%'] }}
                  transition={{ duration: 2.2, delay: 0.5, times: [0, 0.25, 0.5, 0.75, 1], ease: 'easeInOut' }}
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ background: 'linear-gradient(90deg, var(--gold-primary), var(--cyan-primary), var(--gold-primary))', boxShadow: '0 0 12px rgba(212,175,55,0.4)' }}
                />
              </div>

              {/* Status messages — cycling */}
              <div className="mt-3 h-4 flex items-center justify-center">
                {[
                  { text: 'ESTABLISHING SECURE CONNECTION...', delay: 0.5 },
                  { text: 'INITIALIZING FEEDS...', delay: 1.1 },
                  { text: 'CALIBRATING SENSORS...', delay: 1.7 },
                  { text: 'SYSTEM READY', delay: 2.2 },
                ].map((stage, i) => (
                  <motion.span
                    key={i}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 1, 1, 0] }}
                    transition={{ delay: stage.delay, duration: 0.6, times: [0, 0.1, 0.7, 1] }}
                    className="absolute text-[9px] font-mono tracking-[0.25em]"
                    style={{ color: i === 3 ? 'var(--cyan-primary)' : 'var(--text-muted)' }}
                  >
                    {stage.text}
                  </motion.span>
                ))}
              </div>
            </div>

            {/* ── Decorative grid lines ── */}
            <div className="absolute inset-0 pointer-events-none z-[0]" style={{ opacity: 0.03 }}>
              <div className="absolute inset-0" style={{
                backgroundImage: 'linear-gradient(rgba(212,175,55,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(212,175,55,0.5) 1px, transparent 1px)',
                backgroundSize: '60px 60px',
              }} />
            </div>

            {/* ── Corner frame accents ── */}
            {[
              { t: '10px', l: '10px', bw: '2px 0 0 2px' },
              { t: '10px', r: '10px', bw: '2px 2px 0 0' },
              { b: '10px', l: '10px', bw: '0 0 2px 2px' },
              { b: '10px', r: '10px', bw: '0 2px 2px 0' },
            ].map((pos, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.3 }}
                transition={{ delay: 0.8 + i * 0.1, duration: 0.5 }}
                className="absolute w-8 h-8 z-[2]"
                style={{ top: pos.t, bottom: pos.b, left: pos.l, right: pos.r, borderWidth: pos.bw, borderStyle: 'solid', borderColor: 'var(--gold-primary)' }}
              />
            ))}



            {/* ── Inline keyframe for scanline drift ── */}

          </motion.div>
        )}
      </AnimatePresence>



      {/* ── THRESHOLD ALERT TOASTS ── */}
      <ThresholdToasts
        alerts={thresholdAlerts}
        onLocate={(lat, lng) => setFlyToLocation({ lat, lng, ts: Date.now() })}
        onNewAlert={(alert) => {
          setNotificationLog(prev => {
            if (prev.some(n => n.id === alert.id)) return prev;
            setUnreadCount(c => c + 1);
            return [{ ...alert, seenAt: Date.now() }, ...prev].slice(0, 200);
          });
        }}
      />

      {/* ── NOTIFICATION DRAWER ── */}
      <NotificationDrawer
        isOpen={notifOpen}
        onClose={() => setNotifOpen(false)}
        notifications={notificationLog}
        onClear={() => setNotificationLog([])}
        onLocate={(lat, lng) => { setFlyToLocation({ lat, lng, ts: Date.now() }); setNotifOpen(false); }}
      />

      {/* ── MAP ── */}
      <ErrorBoundary name="Map">
        <OsirisMap
          key={osirisTheme}
          data={data}
          activeLayers={activeLayers}
          projection={mapProjection}
          mapStyle={mapStyle === 'satellite' ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' : 'dark'}
          onEntityClick={handleEntityClick}
          onMouseCoords={handleMouseCoords}
          onRightClick={handleRightClick}
          onViewStateChange={setMapView}
          initialCenter={[mapView.longitude, mapView.latitude]}
          initialZoom={mapView.zoom}
          flyToLocation={flyToLocation}
          highlight={highlight}
          sweepData={sweepData}
          scanTargets={scanTargets}
          demoMode={demoMode}
          theme={osirisTheme}
        />
      </ErrorBoundary>

      {/* ── MAP VIEW CONTROLS (3D/2D + SATELLITE TOGGLE) ── */}
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 3.5 }}
        className="absolute bottom-[75px] md:bottom-6 left-3 md:left-[315px] z-[200] flex items-center gap-2 pointer-events-none"
      >
        {/* 3D/2D Toggle */}
        <button
          onClick={() => setMapProjection(p => p === 'globe' ? 'mercator' : 'globe')}
          className="glass-panel p-3.5 pointer-events-auto hover:border-[var(--gold-primary)]/40 transition-colors group relative"
          title={mapProjection === 'globe' ? 'Switch to 2D Map' : 'Switch to 3D Globe'}
        >
          {mapProjection === 'globe' ? (
            <MapPinned className="w-5 h-5 text-[var(--gold-primary)] group-hover:scale-110 transition-transform" />
          ) : (
            <Globe className="w-5 h-5 text-[var(--cyan-primary)] group-hover:scale-110 transition-transform" />
          )}
          <span className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 text-[9px] font-mono text-[var(--text-muted)] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity glass-panel px-2 py-1 z-[300]">
            {mapProjection === 'globe' ? '2D MAP' : '3D GLOBE'}
          </span>
        </button>

        {/* Map Style Toggle */}
        <button
          onClick={() => setMapStyle(s => s === 'dark' ? 'satellite' : 'dark')}
          className="glass-panel p-3.5 pointer-events-auto hover:border-[var(--gold-primary)]/40 transition-colors group relative"
          title={mapStyle === 'dark' ? 'Satellite View' : 'Night View'}
        >
          {mapStyle === 'dark' ? (
            <Satellite className="w-5 h-5 text-[var(--alert-green)] group-hover:scale-110 transition-transform" />
          ) : (
            <Moon className="w-5 h-5 text-[var(--cyan-primary)] group-hover:scale-110 transition-transform" />
          )}
          <span className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 text-[9px] font-mono text-[var(--text-muted)] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity glass-panel px-2 py-1 z-[300]">
            {mapStyle === 'dark' ? 'SATELLITE' : 'NIGHT MODE'}
          </span>
        </button>

      </motion.div>

      {/* ── HEADER ── */}
      <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1, delay: 2.5 }} className={`absolute top-4 left-6 z-[200] pointer-events-none flex flex-col`}>
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-bold tracking-[0.4em] text-[var(--gold-primary)] font-mono">OSIRIS</h1>
          <span className="text-[10px] text-[var(--text-muted)] font-mono tracking-[0.15em] opacity-80">GLOBAL INTELLIGENCE COMMAND</span>
        </div>
        <div className="flex items-center gap-4 mt-1">
          <span className="text-[5px] text-[var(--text-muted)] font-mono tracking-[0.3em] uppercase opacity-40">
            POWERED BY OSIRIS OPEN SOURCE INTELLIGENCE · C2 ENGINE: PHYSICAL COMMAND CORE · SENSORS: ORBITAL LATTICE · NET: LYCAN NETWORK
          </span>
        </div>
      </motion.div>

      {/* ── NOTIFICATION BELL (desktop) ── */}
      <motion.button
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 3 }}
        onClick={() => { setNotifOpen(true); setUnreadCount(0); }}
        className="status-bar-desktop absolute top-3.5 right-[340px] z-[210] pointer-events-auto w-8 h-8 flex items-center justify-center rounded-lg glass-panel text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        title="Notification log"
      >
        <Bell className="w-3.5 h-3.5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-[#FF3D3D] text-white text-[8px] font-mono font-bold flex items-center justify-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </motion.button>

      {/* ── TOP-RIGHT STATUS (desktop) — C2 DISPLAY ── */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 3 }} className="status-bar-desktop absolute top-4 right-6 z-[200] pointer-events-none flex items-center gap-4 text-[9px] font-mono tracking-widest text-[var(--text-muted)]">

        <span className="hidden lg:inline-flex items-center gap-1.5">
          <ZuluClock />
        </span>

        <span className="flex items-center gap-1">SYS: <span className={backendStatus === 'connected' ? 'text-[var(--alert-green)]' : 'text-[var(--alert-red)]'}>{backendStatus.toUpperCase()}</span></span>

        {spaceWeather && <span className="hidden lg:inline">SOLAR: <span style={{ color: spaceWeather.storm_color, fontWeight: 700 }}>Kp{spaceWeather.kp_index}</span></span>}

        <span className="hidden lg:inline-flex items-center gap-1">
          <span className="text-[var(--cyan-primary)] font-bold">{Object.values(activeLayers).filter(Boolean).length}</span>
          <span className="text-[var(--text-muted)]/60">FEEDS</span>
        </span>

        <UptimeClock />
        <span className="text-[10px] font-bold tracking-[0.2em] text-[var(--text-muted)] opacity-50 ml-2">V.4.1</span>
      </motion.div>

      {/* ── MOBILE: Compact top status ── */}
      {isMobile && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 2.5 }} className="absolute top-3 right-3 z-[200] pointer-events-auto flex items-center gap-2">
          {spaceWeather && (
            <div
              className="glass-panel px-2 py-1 flex items-center gap-1 text-[7px] font-mono tracking-widest"
              style={{ borderColor: `${spaceWeather.storm_color}44`, background: `${spaceWeather.storm_color}0D` }}
            >
              {spaceWeather.kp_index >= 4 && (
                <div className="w-1 h-1 rounded-full animate-osiris-pulse flex-shrink-0" style={{ background: spaceWeather.storm_color }} />
              )}
              <span style={{ color: spaceWeather.storm_color, fontWeight: 700 }}>
                SOLAR Kp{spaceWeather.kp_index}
              </span>
            </div>
          )}
          <a href='https://ko-fi.com/M8D41ZYW4Z' target='_blank' className="glass-panel px-2 py-1 flex items-center gap-1.5 text-[7px] font-mono tracking-widest hover:opacity-80 transition-opacity border-[var(--gold-primary)]/40 bg-[var(--gold-primary)]/10">
            <div className="w-1 h-1 rounded-full bg-[var(--gold-primary)] animate-osiris-pulse" />
            <span className="text-[var(--gold-primary)] font-bold">SUPPORT PROJECT</span>
          </a>
          <button
            onClick={() => { setNotifOpen(true); setUnreadCount(0); }}
            className="glass-panel p-1.5 flex items-center justify-center relative"
            aria-label="Notifications"
          >
            <Bell className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-[#FF3D3D] text-white flex items-center justify-center text-[6px] font-bold">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>
        </motion.div>
      )}



      {/* ── NEW SIDEBAR (Root Level) ── */}
      {showLayers && !isMobile && <LayerPanel data={data} activeLayers={activeLayers} setActiveLayers={setActiveLayers} theme={osirisTheme} setTheme={setOsirisTheme} />}

      {/* ── RIGHT TOOL STRIP (desktop only — mobile uses bottom nav) ── */}
      {!isMobile && <div className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-col gap-2 z-[250] pointer-events-auto bg-black/40 backdrop-blur-sm p-1 rounded-full border border-white/5">
        <div className="relative group">
          <button onClick={() => { const next = !showSearch; setShowSearch(next); setShowIntel(false); setShowMarkets(false); setShowAlerts(false); if (next) ensureSearchSources(); }} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${showSearch ? 'bg-[var(--gold-primary)]/20' : 'hover:bg-white/10'}`}>
            <Search className={`w-4 h-4 ${showSearch ? 'text-[var(--gold-primary)]' : 'text-white/60'}`} />
          </button>
          {/* Search Panel Slideout — coordinates, places, AND any live entity by name */}
          <AnimatePresence>
            {showSearch && (
              <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="absolute right-12 top-1/2 -translate-y-1/2 w-80 flex justify-end">
                <SearchBar
                  onLocate={(lat, lng) => { setFlyToLocation({ lat, lng, ts: Date.now() }); }}
                  entities={entityIndex}
                  onEnsureLoaded={ensureSearchSources}
                  onSelectEntity={(e) => { handleSelectEntity(e); }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="relative group">
          <button onClick={() => { setShowIntel(!showIntel); setShowSearch(false); setShowMarkets(false); setShowAlerts(false); }} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${showIntel ? 'bg-[var(--cyan-primary)]/20' : 'hover:bg-white/10'}`}>
            <Radar className={`w-4 h-4 ${showIntel ? 'text-[var(--cyan-primary)]' : 'text-white/60'}`} />
          </button>
          {/* OSINT / Recon Panel Slideout */}
          <AnimatePresence>
            {showIntel && (
              <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="absolute right-12 top-1/2 -translate-y-1/2 w-80">
                <OsintPanel onSweepVisualize={setSweepData} onScanGeolocate={(target, data) => {
                  setScanTargets(prev => {
                    const existing = prev.filter(t => t.id !== target);
                    return [{ id: target, timestamp: Date.now(), ...data }, ...existing].slice(0, 10);
                  });
                  setFlyToLocation({ lat: data.lat, lng: data.lng, ts: Date.now() });
                }} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="relative group">
          <button onClick={() => { setShowMarkets(!showMarkets); setShowIntel(false); setShowAlerts(false); setShowSearch(false); }} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${showMarkets ? 'bg-[var(--gold-primary)]/20' : 'hover:bg-white/10'}`}>
            <BarChart3 className={`w-4 h-4 ${showMarkets ? 'text-[var(--gold-primary)]' : 'text-white/60'}`} />
          </button>
          {/* Markets Panel Slideout */}
          <AnimatePresence>
            {showMarkets && (
              <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="absolute right-12 top-1/2 -translate-y-1/2 w-80">
                <MarketsPanel data={data} spaceWeather={spaceWeather} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="relative group">
          <button onClick={() => { setShowAlerts(!showAlerts); setShowIntel(false); setShowMarkets(false); setShowSearch(false); setShowEntityGraph(false); }} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${showAlerts ? 'bg-[#FF3D3D]/20' : 'hover:bg-white/10'}`}>
            <AlertTriangle className={`w-4 h-4 ${showAlerts ? 'text-[#FF3D3D]' : 'text-white/60'}`} />
          </button>
          {/* Alerts Panel Slideout */}
          <AnimatePresence>
            {showAlerts && (
              <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="absolute right-12 top-1/2 -translate-y-1/2 w-80">
                <LiveAlerts data={data} onLocate={(lat, lng) => setFlyToLocation({ lat, lng, ts: Date.now() })} onWatchFeed={(url, name) => { setLiveFeedUrl(url); setLiveFeedName(name); }} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Frontline change tracker toggle */}
        <button
          onClick={() => setShowFrontlineTracker(t => !t)}
          title="Frontline change tracker"
          className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${showFrontlineTracker ? 'bg-[#FF3D3D]/20' : 'hover:bg-white/10'}`}
        >
          <Activity className={`w-4 h-4 ${showFrontlineTracker ? 'text-[#FF3D3D]' : 'text-white/60'}`} />
        </button>

        {/* Axis Briefing toggle */}
        <button
          onClick={() => setShowAxisBriefing(t => !t)}
          title="Axis briefing"
          className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${showAxisBriefing ? 'bg-[var(--gold-primary)]/20' : 'hover:bg-white/10'}`}
        >
          <MapPinned className={`w-4 h-4 ${showAxisBriefing ? 'text-[var(--gold-primary)]' : 'text-white/60'}`} />
        </button>

        {/* Entity graph (Intelligence Layer) toggle */}
        <div className="relative group">
          <button onClick={() => { setShowEntityGraph(!showEntityGraph); setShowIntel(false); setShowMarkets(false); setShowAlerts(false); setShowSearch(false); setShowFusion(false); }} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${showEntityGraph ? 'bg-[#D4AF37]/20' : 'hover:bg-white/10'}`}>
            <Network className={`w-4 h-4 ${showEntityGraph ? 'text-[#D4AF37]' : 'text-white/60'}`} />
          </button>
        </div>

        {/* Threat Fusion HUD toggle */}
        <div className="relative group">
          <button onClick={() => { setShowFusion(f => !f); setShowIntel(false); setShowMarkets(false); setShowAlerts(false); setShowSearch(false); setShowEntityGraph(false); }} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${showFusion ? 'bg-[#FF1744]/20' : 'hover:bg-white/10'}`} title="Global Threat Fusion">
            <Activity className={`w-4 h-4 ${showFusion ? 'text-[#FF1744]' : 'text-white/60'}`} />
          </button>
          {showFusion && (
            <div className="absolute right-12 top-0">
              <ThreatFusionHUD onLocate={(lat: number, lng: number) => { setFlyToLocation({ lat, lng, ts: Date.now() }); setMapView(v => ({ ...v, zoom: Math.max(v.zoom, 5) })); }} />
            </div>
          )}
        </div>

      </div>}

      {/* ── LIVE FEED VIEWER OVERLAY ── */}
      <AnimatePresence>
        {liveFeedUrl && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed inset-0 z-[500] flex items-center justify-center bg-black/70 backdrop-blur-sm"
            onClick={() => setLiveFeedUrl(null)}
          >
            <motion.div
              initial={{ y: 20 }}
              animate={{ y: 0 }}
              className="w-[90vw] max-w-[900px] flex flex-col relative rounded-xl overflow-hidden border border-[var(--border-primary)] shadow-2xl bg-black"
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-2.5 bg-[#111] border-b border-[var(--border-primary)]">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#FF4081] animate-osiris-pulse" />
                  <span className="text-[12px] font-mono font-bold text-white tracking-wider">{liveFeedName}</span>
                  <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-mono text-[9px] font-bold">LIVE STREAM</span>
                  {!liveFeedEmbedAllowed && (
                    <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-mono text-[9px]">EXTERNAL ONLY</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <a
                    href={getYouTubeWatchUrl(liveFeedUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[var(--border-primary)] hover:bg-[var(--gold-primary)] hover:text-black text-white transition-colors text-[11px] font-mono"
                  >
                    <span>Open in YouTube</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  <button onClick={() => setLiveFeedUrl(null)} className="text-white/70 hover:text-white transition-colors p-1">
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Body — iframe or external card */}
              {liveFeedEmbedAllowed ? (
                <div className="w-full aspect-video relative bg-black">
                  <iframe
                    src={liveFeedUrl}
                    className="w-full h-full absolute inset-0"
                    allow="autoplay; encrypted-media"
                    allowFullScreen
                  />
                </div>
              ) : (
                <div className="w-full aspect-video flex items-center justify-center bg-black/95">
                  <div className="text-center px-8">
                    <div className="w-14 h-14 rounded-full bg-[#39FF14]/10 border border-[#39FF14]/20 flex items-center justify-center mx-auto mb-4">
                      <ExternalLink className="w-6 h-6 text-[#39FF14]" />
                    </div>
                    <p className="text-[13px] font-mono font-bold text-white tracking-widest mb-2">EMBED RESTRICTED</p>
                    <p className="text-[11px] font-mono text-white/50 mb-6 max-w-xs">
                      {liveFeedName} does not allow third-party embedding. Click below to open the live stream directly.
                    </p>
                    <a
                      href={getYouTubeWatchUrl(liveFeedUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-6 py-2.5 rounded border border-[#39FF14]/40 text-[#39FF14] font-mono text-[12px] hover:bg-[#39FF14]/10 transition-colors tracking-wider"
                    >
                      <ExternalLink className="w-4 h-4" />
                      OPEN LIVE STREAM
                    </a>
                  </div>
                </div>
              )}

              {/* Footer — only show for embeddable feeds */}
              {liveFeedEmbedAllowed && (
                <div className="bg-[#111]/90 px-4 py-2.5 border-t border-[var(--border-primary)] flex items-center gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-[var(--gold-primary)] shrink-0" />
                  <span className="text-[11px] font-mono text-white/70 leading-relaxed">
                    If you see &ldquo;Video unavailable&rdquo;, use <strong className="text-[var(--gold-primary)]">Open in YouTube</strong> above.
                  </span>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══ MOBILE UI ═══ */}
      {isMobile && (
        <>
          {/* Mobile Bottom Navigation */}
          <div className="mobile-nav">
            <div className="glass-panel mobile-nav-inner">
              {[
                { id: 'layers' as const, icon: Layers, label: 'LAYERS' },
                { id: 'markets' as const, icon: BarChart3, label: 'MARKETS' },
                { id: 'intel' as const, icon: Newspaper, label: 'INTEL' },
                { id: 'recon' as const, icon: Radar, label: 'RECON' },
                { id: 'search' as const, icon: Search, label: 'SEARCH' },
                { id: 'more' as const, icon: MoreHorizontal, label: 'MORE' },
              ].map(tab => (
                <button key={tab.id} onClick={() => setMobilePanel(mobilePanel === tab.id ? null : tab.id)}
                  className={`mobile-nav-btn ${mobilePanel === tab.id ? 'active' : ''}`}>
                  <tab.icon className={`w-4 h-4 ${tab.id === 'recon' ? 'text-[var(--cyan-primary)]' : ''}`} />
                  <span className={tab.id === 'recon' ? 'text-[var(--cyan-primary)]' : ''}>{tab.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Mobile Drawer */}
          <AnimatePresence>
            {mobilePanel && (
              <motion.div
                key="mobile-backdrop"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                onClick={() => setMobilePanel(null)}
                className="fixed inset-0 z-[399] bg-black/40"
                aria-hidden
              />
            )}
            {mobilePanel && (
              <motion.div
                key="mobile-drawer"
                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                className="fixed bottom-[52px] left-0 right-0 z-[400] glass-panel rounded-b-none overflow-y-auto styled-scrollbar"
                style={{ maxHeight: 'min(55vh, calc(100dvh - 100px))', paddingBottom: 'env(safe-area-inset-bottom, 4px)' }}
              >
                <div className="mobile-drawer-handle" />
                <div className="px-3 pb-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="hud-text text-[9px] text-[var(--text-primary)]">
                      {mobilePanel === 'layers' ? 'LAYERS & STATS' : mobilePanel === 'markets' ? 'MARKETS & INTEL' : mobilePanel === 'intel' ? 'INTEL FEED' : mobilePanel === 'recon' ? 'OSIRIS RECON' : mobilePanel === 'more' ? 'MORE TOOLS' : mobilePanel === 'frontline' ? 'FRONTLINE CHANGES' : 'SEARCH'}
                    </span>
                    <button onClick={() => setMobilePanel(null)} className="text-[var(--text-muted)] p-1"><X className="w-4 h-4" /></button>
                  </div>
                  {mobilePanel === 'layers' && (
                    <>
                      <div className="glass-panel-sm p-2 mb-2">
                        <div className="grid grid-cols-5 gap-1 text-center">
                          <div><div className="hud-label" style={{fontSize:'6px'}}>AIR</div><div className="hud-value text-[9px]">{totalFlights.toLocaleString()}</div></div>
                          <div><div className="hud-label" style={{fontSize:'6px'}}>SAT</div><div className="hud-value text-[9px]">{(data.satellites?.length||0)}</div></div>
                          <div><div className="hud-label" style={{fontSize:'6px'}}>CAM</div><div className="hud-value text-[9px]">{(data.cameras?.length||0)}</div></div>
                          <div><div className="hud-label" style={{fontSize:'6px'}}>WX</div><div className="hud-value text-[9px]" style={{color:'var(--accent-weather)'}}>{(data.weather_events?.length||0)}</div></div>
                          <div><div className="hud-label" style={{fontSize:'6px'}}>NUC</div><div className="hud-value text-[9px]" style={{color:'var(--accent-nuclear)'}}>{(data.infrastructure?.length||0)}</div></div>
                        </div>
                      </div>
                      <LayerPanel data={data} activeLayers={activeLayers} setActiveLayers={setActiveLayers} isMobile={true} theme={osirisTheme} setTheme={setOsirisTheme} />
                      <div className="mt-2">
                        <ViewPresets onNavigate={(lat, lng, zoom) => { setFlyToLocation({ lat, lng, ts: Date.now() }); setMapView(v => ({ ...v, zoom })); setMobilePanel(null); }} />
                      </div>
                    </>
                  )}
                  {mobilePanel === 'markets' && <MarketsPanel data={data} spaceWeather={spaceWeather} />}
                  {mobilePanel === 'intel' && <IntelFeed data={data} onLocate={(lat, lng) => { setFlyToLocation({ lat, lng, ts: Date.now() }); setMobilePanel(null); }} />}
                  {mobilePanel === 'search' && (
                    <div className="space-y-2">
                      <SearchBar onLocate={(lat, lng) => { setFlyToLocation({ lat, lng, ts: Date.now() }); setMobilePanel(null); }} entities={entityIndex} onEnsureLoaded={ensureSearchSources} onSelectEntity={(e) => { handleSelectEntity(e); setMobilePanel(null); }} />
                      <SharePanel mapView={mapView} activeLayers={activeLayers} mouseCoords={null} />
                    </div>
                  )}
                  {mobilePanel === 'recon' && (
                    <div className="space-y-2">
                      <OsintPanel isOpen={true} onClose={() => setMobilePanel(null)} isMobile={true} onSweepVisualize={setSweepData} />
                    </div>
                  )}
                  {mobilePanel === 'more' && (
                    <div className="grid grid-cols-2 gap-2">
                      {([
                        { id: 'frontline' as const, icon: Activity, label: 'FRONTLINE', color: '#FF3D3D' },
                      ] as const).map(item => (
                        <button
                          key={item.id}
                          onClick={() => setMobilePanel(item.id)}
                          className="glass-panel-sm flex flex-col items-center gap-2 py-4 hover:bg-white/5 transition-colors rounded-lg"
                        >
                          <item.icon className="w-5 h-5" style={{ color: item.color }} />
                          <span className="hud-text text-[8px]" style={{ color: item.color }}>{item.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {mobilePanel === 'frontline' && (
                    <FrontlineTracker />
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      {/* ── BOTTOM RAW METRICS (desktop) ── */}
      {!isMobile && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 3, duration: 0.8 }} className="desktop-only absolute bottom-4 left-20 z-[200] pointer-events-auto">
          <div className="flex items-center gap-6 text-[8px] font-mono tracking-widest text-[var(--text-muted)] opacity-60">
            <div className="flex gap-2 items-center">
              <span>COORD</span>
              <span ref={coordsDisplayRef} className="text-[var(--gold-primary)] font-bold tabular-nums">—</span>
            </div>
            <div className="flex gap-2 items-center">
              <span>LOC</span>
              <span className="text-[var(--cyan-primary)] truncate max-w-[200px]">{locationLabel || 'HOVER MAP'}</span>
            </div>
            <div className="flex gap-2 items-center">
              <span>Z</span>
              <span className="text-[var(--gold-primary)] font-bold tabular-nums">{mapView.zoom.toFixed(1)}</span>
            </div>
          </div>
        </motion.div>
      )}

      {/* ── Frontline change tracker (desktop) ── */}
      <AnimatePresence>
        {!isMobile && showFrontlineTracker && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.25 }}
            className="absolute bottom-6 right-14 z-[205] pointer-events-none"
          >
            <FrontlineTracker />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Axis Briefing panel (desktop) ── */}
      <AnimatePresence>
        {!isMobile && showAxisBriefing && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.25 }}
            className="absolute bottom-6 right-14 z-[205] pointer-events-none"
          >
            <AxisBriefing show={showAxisBriefing} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Scale Bar (desktop) ── */}
      <div className="desktop-only absolute bottom-[4.5rem] left-[20rem] z-[201] pointer-events-none">
        <ScaleBar zoom={mapView.zoom} latitude={mapView.latitude} />
      </div>

      {/* ── Region Dossier ── */}
      {(regionDossier || dossierLoading) && (
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="absolute top-16 md:top-20 left-2 right-2 md:left-1/2 md:right-auto md:-translate-x-1/2 z-[300] md:w-[480px] max-h-[65vh] overflow-y-auto styled-scrollbar">
          <div className="glass-panel p-5 osiris-glow">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-mono font-bold text-[var(--gold-primary)] tracking-wider">REGION DOSSIER</h2>
              <button onClick={() => { setRegionDossier(null); setDossierLoading(false); }} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xs">✕</button>
            </div>
            {dossierLoading ? (
              <div className="text-center py-8">
                <div className="w-5 h-5 border-2 border-[var(--gold-primary)] border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                <span className="text-[8px] font-mono text-[var(--text-muted)] tracking-widest">COMPILING INTEL...</span>
              </div>
            ) : regionDossier && (
              <div className="space-y-3">
                <div><div className="hud-label mb-0.5">LOCATION</div><div className="text-xs text-[var(--text-primary)]">{regionDossier.location?.display_name}</div></div>
                {regionDossier.country && (
                  <div className="grid grid-cols-2 gap-2">
                    <div><div className="hud-label mb-0.5">COUNTRY</div><div className="text-xs text-[var(--text-primary)]">{regionDossier.country.flag} {regionDossier.country.name}</div></div>
                    <div><div className="hud-label mb-0.5">CAPITAL</div><div className="text-xs text-[var(--text-primary)]">{regionDossier.country.capital}</div></div>
                    <div><div className="hud-label mb-0.5">POPULATION</div><div className="text-xs text-[var(--text-primary)]">{regionDossier.country.population?.toLocaleString()}</div></div>
                    <div><div className="hud-label mb-0.5">REGION</div><div className="text-xs text-[var(--text-primary)]">{regionDossier.country.subregion || regionDossier.country.region}</div></div>
                    <div><div className="hud-label mb-0.5">LANGUAGES</div><div className="text-xs text-[var(--text-primary)]">{regionDossier.country.languages?.join(', ')}</div></div>
                    <div><div className="hud-label mb-0.5">AREA</div><div className="text-xs text-[var(--text-primary)]">{regionDossier.country.area?.toLocaleString()} km²</div></div>
                  </div>
                )}
                {regionDossier.head_of_state && (<div><div className="hud-label mb-0.5">HEAD OF STATE</div><div className="text-xs text-[var(--gold-primary)]">{regionDossier.head_of_state.name}</div><div className="text-[8px] text-[var(--text-muted)]">{regionDossier.head_of_state.position}</div></div>)}
                {regionDossier.wikipedia && (<div><div className="hud-label mb-1">INTELLIGENCE BRIEF</div><div className="flex gap-3">{regionDossier.wikipedia.thumbnail && <img src={regionDossier.wikipedia.thumbnail} alt="" className="w-14 h-14 rounded object-cover flex-shrink-0" />}<p className="text-[8px] text-[var(--text-secondary)] leading-relaxed">{regionDossier.wikipedia.extract}</p></div></div>)}
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* ── Camera Viewer ── */}
      <CameraViewer
        camera={activeCamera}
        onClose={() => setActiveCamera(null)}
        onLocate={(lat, lng) => setFlyToLocation({ lat, lng, ts: Date.now() })}
      />

      {/* ── Entity Graph Panel ── */}
      {showEntityGraph && (
        <EntityGraphPanel
          entity={entityGraphTarget}
          onClose={() => setShowEntityGraph(false)}
        />
      )}

      {/* ── OVERLAYS ── */}
      <div className="vignette absolute inset-0 pointer-events-none z-[2]" />
      <div className="crt-scanlines absolute inset-0 pointer-events-none z-[3] opacity-[0.02]" />
      {/* Corner frames — using explicit classes for Tailwind JIT compatibility */}
      {[
        { pos: 'top-0 left-0', vAnchor: 'top-0', hAnchor: 'left-0', hGrad: 'bg-gradient-to-r', vGrad: 'bg-gradient-to-b' },
        { pos: 'top-0 right-0', vAnchor: 'top-0', hAnchor: 'right-0', hGrad: 'bg-gradient-to-l', vGrad: 'bg-gradient-to-b' },
        { pos: 'bottom-0 left-0', vAnchor: 'bottom-0', hAnchor: 'left-0', hGrad: 'bg-gradient-to-r', vGrad: 'bg-gradient-to-t' },
        { pos: 'bottom-0 right-0', vAnchor: 'bottom-0', hAnchor: 'right-0', hGrad: 'bg-gradient-to-l', vGrad: 'bg-gradient-to-t' },
      ].map((c, i) => (
        <div key={i} className={`absolute ${c.pos} w-16 h-16 pointer-events-none z-[1]`}>
          <div className={`absolute ${c.vAnchor} ${c.hAnchor} w-full h-[1px] ${c.hGrad} from-[var(--gold-primary)]/30 to-transparent`} />
          <div className={`absolute ${c.vAnchor} ${c.hAnchor} w-[1px] h-full ${c.vGrad} from-[var(--gold-primary)]/30 to-transparent`} />
        </div>
      ))}

      {/* Keyboard Shortcuts Overlay */}
      <CommandPalette commands={paletteCommands} />
      <KeyboardShortcuts />

      {/* ── GLOBAL STATUS TICKER (bottom) ── */}
      <GlobalStatusBar />

      {/* Shortcut hint */}
      <div className="desktop-only absolute bottom-[26px] right-5 z-[200] pointer-events-none text-[6px] font-mono text-[var(--text-muted)]/40 tracking-widest">
        [?] SHORTCUTS · [F] FULLSCREEN · [S] SHARE · [R] RESET VIEW
      </div>


    </main>
  );
}
