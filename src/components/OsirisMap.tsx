'use client';

import { useEffect, useRef, useState, useCallback, memo } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { parseThermalLatest } from '@/lib/osint-utils';
import { deadReckon, uncertaintyRadiusKm, uncertaintyRing } from '@/lib/dark-vessel-dr';

// ── Popup XSS escaping ──
// Map popups are assembled as raw HTML strings and injected via Popup.setHTML,
// so every value that comes from scraped feeds (Telegram/RSS via /api/news),
// third-party APIs (ADS-B, AIS, Shodan, SatNOGS…), or the SDK ingest endpoint
// must be escaped for its context before interpolation. Numeric/coordinate and
// operator-computed values (colors, coords.toFixed) don't need escaping.

// HTML text / double-quoted attribute context.
function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
// Inside an inline on*="...'VALUE'..." handler's single-quoted JS string literal:
// JS-escape first (so HTML entity-decoding can't reconstitute a quote), then
// HTML-escape for the attribute layer.
function jsAttr(v: unknown): string {
  const js = String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n\t]+/g, ' ');
  return esc(js);
}
// href/src URL from feed data: permit only http(s), otherwise neutralise
// (blocks javascript:, data:, etc.). Quote-escaped for the attribute.
function safeUrl(v: unknown): string {
  const s = String(v ?? '').trim();
  return /^https?:\/\//i.test(s) ? esc(s) : '#';
}

// Normalises apostrophe variants in oblast names so vadimklimenko API curly-quote
// strings (U+2019 etc.) match the straight-quote values in the GeoJSON file.
// Used both in the air-raid fill useEffect and the oblast-pressure useEffect.
function normalizeApos(s: string): string {
  return s.replace(/['''ʼ]/g, "'");
}

// Maps power-outage canonical region names (from /api/power-outages) to the
// name_en values used in ukraine-oblasts.geojson for polygon highlighting.
// Kyiv City and Kyiv Oblast are intentionally separate entries.
const OUTAGE_REGION_TO_GEOJSON: Record<string, string> = {
  'Vinnytska Oblast':        'Vinnytsia oblast',
  'Volynska Oblast':         'Volyn oblast',
  'Dnipropetrovska Oblast':  'Dnipropetrovsk oblast',
  'Donetska Oblast':         'Donetsk oblast',
  'Zhytomyrska Oblast':      'Zhytomyr oblast',
  'Zakarpatska Oblast':      'Zakarpattia oblast',
  'Zaporizka Oblast':        'Zaporizhzhia oblast',
  'Ivano-Frankivska Oblast': 'Ivano-Frankivsk oblast',
  'Kyivska Oblast':          'Kyiv oblast',
  'Kyiv City':               'Kyiv',
  'Kirovohradska Oblast':    'Kirovohrad oblast',
  'Luhanska Oblast':         'Luhansk oblast',
  'Lvivska Oblast':          'Lviv oblast',
  'Mykolaivska Oblast':      'Mykolaiv oblast',
  'Odeska Oblast':           'Odesa oblast',
  'Poltavska Oblast':        'Poltava oblast',
  'Rivnenska Oblast':        'Rivne oblast',
  'Sumska Oblast':           'Sumy oblast',
  'Ternopilska Oblast':      'Ternopil oblast',
  'Kharkivska Oblast':       'Kharkiv oblast',
  'Khersonska Oblast':       'Kherson oblast',
  'Khmelnytska Oblast':      'Khmelnytskyi oblast',
  'Cherkaska Oblast':        'Cherkasy oblast',
  'Chernivtetska Oblast':    'Chernivtsi oblast',
  'Chernihivska Oblast':     'Chernihiv oblast',
};

interface OsirisMapProps {
  data: any;
  activeLayers: Record<string, boolean>;
  onEntityClick?: (entity: any) => void;
  onMouseCoords?: (coords: { lat: number; lng: number }) => void;
  onRightClick?: (coords: { lat: number; lng: number }) => void;
  onViewStateChange?: (vs: { zoom: number; latitude: number; longitude: number }) => void;
  flyToLocation?: { lat: number; lng: number; ts: number } | null;
  highlight?: { lat: number; lng: number; ts: number } | null;
  projection?: 'mercator' | 'globe';
  mapStyle?: string;
  sweepData?: any;
  scanTargets?: any[];
  demoMode?: boolean;
  theme?: 'core' | 'ghost';
  initialCenter?: [number, number];
  initialZoom?: number;
  replayTime?: Date | null;
  focusedAxisBbox?: [number, number, number, number] | null;
  onMapReady?: () => void;
}

function computeSolarTerminator(): [number, number][] {
  const now = new Date();
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
  const declination = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  const decRad = declination * Math.PI / 180;
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  const subsolarLng = (12 - utcHours) * 15;
  const points: [number, number][] = [];
  for (let lng = -180; lng <= 180; lng += 2) {
    const lngRad = (lng - subsolarLng) * Math.PI / 180;
    const lat = Math.atan(-Math.cos(lngRad) / Math.tan(decRad)) * 180 / Math.PI;
    points.push([lng, lat]);
  }
  const darkSide = declination >= 0 ? -90 : 90;
  points.push([180, darkSide]);
  points.push([-180, darkSide]);
  points.push(points[0]);
  return points;
}

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

// Unified Threats — maps each `ttype` to its map-icon id and popup badge color.
// Every type gets a visually distinct glyph (not just a distinct color); see
// createThreatIcons() below for how each glyph is drawn. 'uav' is the generic/
// unclassified drone bucket — visually distinct from 'fpv' (delta-wing glyph).
const THREAT_TYPE_META: Record<string, { icon: string; color: string; label: string }> = {
  fpv:       { icon: 'fpv',       color: '#FFB300', label: 'FPV-дрон' },
  cruise:    { icon: 'cruise',    color: '#FF5252', label: 'Крилата ракета' },
  ballistic: { icon: 'ballistic', color: '#E040FB', label: 'Балістика' },
  kab:       { icon: 'kab',       color: '#FF6B00', label: 'Керована авіабомба' },
  aviation:  { icon: 'aviation',  color: '#536DFE', label: 'Авіація' },
  recon:     { icon: 'recon',     color: '#26C6DA', label: 'Розвідка' },
  uav:       { icon: 'uav',       color: '#CDDC39', label: 'БпЛА' },
};

function OsirisMap({ data, activeLayers, onEntityClick, onMouseCoords, onRightClick, onViewStateChange, flyToLocation, highlight, projection = 'globe', mapStyle = 'dark', sweepData, scanTargets = [], demoMode = false, theme = 'core', initialCenter, initialZoom, replayTime = null, focusedAxisBbox = null, onMapReady }: OsirisMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const dataRef = useRef<any>(data);
  const weaponThreatsRef = useRef<any[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const prevStyleRef = useRef(mapStyle);

  // Keep dataRef and weaponThreatsRef current on every render so stale-closure
  // click handlers registered in map.on('load') can read live data without
  // being re-registered.
  dataRef.current = data;
  weaponThreatsRef.current = Array.isArray(data.weapon_threats) ? data.weapon_threats : [];

  // Create aircraft icon on canvas (for WebGL symbol layer)
  const createIcon = useCallback((map: maplibregl.Map, id: string, color: string, size: number) => {
    if (map.hasImage(id)) return;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cx = size / 2, cy = size / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy - size * 0.4);
    ctx.lineTo(cx - size * 0.12, cy + size * 0.1);
    ctx.lineTo(cx - size * 0.4, cy + size * 0.2);
    ctx.lineTo(cx - size * 0.4, cy + size * 0.3);
    ctx.lineTo(cx - size * 0.12, cy + size * 0.15);
    ctx.lineTo(cx, cy + size * 0.35);
    ctx.lineTo(cx + size * 0.12, cy + size * 0.15);
    ctx.lineTo(cx + size * 0.4, cy + size * 0.3);
    ctx.lineTo(cx + size * 0.4, cy + size * 0.2);
    ctx.lineTo(cx + size * 0.12, cy + size * 0.1);
    ctx.closePath();
    ctx.fill();
    map.addImage(id, { width: size, height: size, data: new Uint8Array(ctx.getImageData(0, 0, size, size).data) });
  }, []);

  // Create helicopter icon on canvas — a rotor-disc glyph (crossed blades over a
  // hub) that reads clearly as a helicopter and is visually distinct from the
  // fixed-wing arrow above. Near rotationally symmetric, so it stays legible
  // regardless of heading.
  const createHeliIcon = useCallback((map: maplibregl.Map, id: string, color: string, size: number) => {
    if (map.hasImage(id)) return;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cx = size / 2, cy = size / 2;
    const reach = size * 0.42 * 0.707; // half-diagonal of the rotor span
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(2, size * 0.09);
    ctx.lineCap = 'round';
    // Rotor blades (X)
    ctx.beginPath();
    ctx.moveTo(cx - reach, cy - reach); ctx.lineTo(cx + reach, cy + reach);
    ctx.moveTo(cx + reach, cy - reach); ctx.lineTo(cx - reach, cy + reach);
    ctx.stroke();
    // Fuselage hub
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.17, 0, Math.PI * 2);
    ctx.fill();
    map.addImage(id, { width: size, height: size, data: new Uint8Array(ctx.getImageData(0, 0, size, size).data) });
  }, []);

  const createDot = useCallback((map: maplibregl.Map, id: string, color: string, size: number) => {
    if (map.hasImage(id)) return;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(size/2, size/2, size/2 - 1, 0, Math.PI * 2);
    ctx.fill();
    map.addImage(id, { width: size, height: size, data: new Uint8Array(ctx.getImageData(0, 0, size, size).data) });
  }, []);

  // Draws one of the 7 Unified Threat glyphs (plus an optional white selection
  // ring) onto a canvas and registers it via map.addImage. Each type gets a
  // genuinely different shape — not just a recolor — so the legend, map icon,
  // and popup badge all read as distinct at a glance:
  //   fpv       — hub-and-spoke / molecule glyph (short-range FPV + loitering munitions)
  //   cruise    — missile silhouette (elongated body + tail fins)
  //   ballistic — hooked/curved downward arrow (ballistic arc)
  //   kab       — teardrop/bomb shape
  //   aviation  — chevron/plane silhouette (MiG-31K carrier, etc.)
  //   recon     — eye glyph
  //   uav       — solid delta-wing with tail notch (generic/unclassified drone)
  const createThreatIcon = useCallback((map: maplibregl.Map, ttype: string, color: string, selected: boolean) => {
    const id = selected ? `threat-${ttype}-selected` : `threat-${ttype}`;
    if (map.hasImage(id)) return;
    const size = selected ? 34 : 22;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cx = size / 2, cy = size / 2;
    // Selected variant: reserve an outer ring, draw the glyph slightly smaller inside it.
    const ringW = selected ? Math.max(2, size * 0.07) : 0;
    const r = size / 2 - (selected ? ringW + 2 : 1);

    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    switch (ttype) {
      case 'fpv': {
        // Hub + 5 spokes with small dots at each end — reads as an interconnected node graph.
        ctx.lineWidth = Math.max(1.5, size * 0.06);
        const spokes = 5;
        for (let i = 0; i < spokes; i++) {
          const ang = (Math.PI * 2 * i) / spokes - Math.PI / 2;
          const ex = cx + Math.cos(ang) * r * 0.85;
          const ey = cy + Math.sin(ang) * r * 0.85;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(ex, ey, Math.max(1.2, size * 0.07), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1.8, size * 0.11), 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'cruise': {
        // Missile silhouette: pointed nose, tapered body, two tail fins.
        const bodyW = r * 0.34, bodyTop = cy - r * 0.85, bodyBot = cy + r * 0.45;
        ctx.beginPath();
        ctx.moveTo(cx, bodyTop);
        ctx.lineTo(cx + bodyW, cy - r * 0.1);
        ctx.lineTo(cx + bodyW, bodyBot);
        ctx.lineTo(cx + bodyW * 1.9, bodyBot + r * 0.35);
        ctx.lineTo(cx + bodyW * 0.4, bodyBot + r * 0.05);
        ctx.lineTo(cx - bodyW * 0.4, bodyBot + r * 0.05);
        ctx.lineTo(cx - bodyW * 1.9, bodyBot + r * 0.35);
        ctx.lineTo(cx - bodyW, bodyBot);
        ctx.lineTo(cx - bodyW, cy - r * 0.1);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'ballistic': {
        // Hooked downward arc — a ballistic-arc arrow bending down into a point.
        ctx.lineWidth = Math.max(2, size * 0.13);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(cx, cy - r * 0.15, r * 0.7, Math.PI * 1.1, Math.PI * 1.85);
        ctx.stroke();
        // Arrowhead at the end of the arc, pointing down-right.
        const tipX = cx + r * 0.62, tipY = cy + r * 0.5;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - r * 0.32, tipY - r * 0.08);
        ctx.lineTo(tipX - r * 0.06, tipY - r * 0.36);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'kab': {
        // Teardrop / bomb shape: round body + tapered tail fin.
        ctx.beginPath();
        ctx.arc(cx, cy - r * 0.05, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.22, cy + r * 0.35);
        ctx.lineTo(cx + r * 0.22, cy + r * 0.35);
        ctx.lineTo(cx, cy + r * 0.9);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'aviation': {
        // Upward chevron with wings — plane silhouette (same family as MiG-31K carrier icon).
        ctx.beginPath();
        ctx.moveTo(cx, cy - r * 0.8);
        ctx.lineTo(cx - r * 0.15, cy + r * 0.15);
        ctx.lineTo(cx - r * 0.85, cy + r * 0.55);
        ctx.lineTo(cx - r * 0.85, cy + r * 0.8);
        ctx.lineTo(cx - r * 0.15, cy + r * 0.5);
        ctx.lineTo(cx, cy + r * 0.85);
        ctx.lineTo(cx + r * 0.15, cy + r * 0.5);
        ctx.lineTo(cx + r * 0.85, cy + r * 0.8);
        ctx.lineTo(cx + r * 0.85, cy + r * 0.55);
        ctx.lineTo(cx + r * 0.15, cy + r * 0.15);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'recon': {
        // Eye glyph: outer almond (two arcs) + pupil.
        ctx.lineWidth = Math.max(1.5, size * 0.08);
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.85, cy);
        ctx.quadraticCurveTo(cx, cy - r * 0.6, cx + r * 0.85, cy);
        ctx.quadraticCurveTo(cx, cy + r * 0.6, cx - r * 0.85, cy);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.28, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'uav': {
        // Solid delta-wing with a tail notch — generic/unclassified drone silhouette.
        ctx.beginPath();
        ctx.moveTo(cx, cy - r * 0.85);          // nose
        ctx.lineTo(cx + r * 0.8, cy + r * 0.6); // right wingtip
        ctx.lineTo(cx, cy + r * 0.25);          // tail notch
        ctx.lineTo(cx - r * 0.8, cy + r * 0.6); // left wingtip
        ctx.closePath();
        ctx.fill();
        break;
      }
      default: {
        // Fallback dot for any unrecognised ttype.
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Selected variant: white ring around the whole glyph, drawn last (on top).
    if (selected) {
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = ringW;
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2 - ringW / 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    map.addImage(id, { width: size, height: size, data: new Uint8Array(ctx.getImageData(0, 0, size, size).data) });
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;

    // ── DEMO MODE SPINNING ──
    let spinReq: number | undefined = undefined;
    let isSpinning = false;
    
    const startSpinning = () => {
      if (!map) return;
      isSpinning = true;
      let lastTime = performance.now();
      
      const frame = (time: number) => {
        if (!isSpinning) return;
        
        // Only spin if the user is not actively dragging or zooming the map
        if (!map.isMoving() && !map.isZooming()) {
          const dt = time - lastTime;
          const center = map.getCenter();
          // Adjust spin speed: 0.5 degrees per second
          center.lng += (0.5 * dt) / 1000;
          map.setCenter(center);
        }
        
        lastTime = time;
        spinReq = requestAnimationFrame(frame);
      };
      
      spinReq = requestAnimationFrame(frame);
    };

    if (demoMode) {
      startSpinning();
    } else {
      isSpinning = false;
      if (spinReq) cancelAnimationFrame(spinReq);
    }

    return () => {
      isSpinning = false;
      if (spinReq) cancelAnimationFrame(spinReq);
      if (typeof window !== 'undefined' && (window as any)._globeSpinTimer) {
        clearInterval((window as any)._globeSpinTimer);
      }
    };
  }, [mapReady, demoMode]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: initialCenter ?? [25.48, 42.70], zoom: initialZoom ?? 6.5, minZoom: 1.5, maxZoom: 18,
      attributionControl: false,
      maxPitch: 85,
      transformRequest: (url: string) => {
        // Route all CARTO CDN requests through the internal Next.js proxy API
        if (url.includes('cartocdn.com')) {
          const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
          return { url: `${baseUrl}/api/proxy-tiles?url=${encodeURIComponent(url)}` };
        }
        return { url };
      },
    });

    map.on('load', () => {
      mapRef.current = map;

      // Theme colors
      const isGhost = theme === 'ghost';
      const phantomPurple = '#B388FF';
      const cameraColor = isGhost ? phantomPurple : '#00E676';
      const flightCom = isGhost ? phantomPurple : '#00E5FF';
      const flightPriv = isGhost ? phantomPurple : '#FFD700';
      const flightGov = isGhost ? phantomPurple : '#FF9500';
      const flightMil = isGhost ? phantomPurple : '#FF3D3D';

      // Create icons — each category isolated in its own try/catch so a
      // canvas/addImage failure (e.g. iOS Safari returning a null 2d context
      // under memory/context pressure) in one category can NEVER abort the
      // others from registering.
      try {
        createIcon(map, 'plane-cyan', flightCom, 24);
        createIcon(map, 'plane-green', flightPriv, 24);
        createIcon(map, 'plane-pink', flightGov, 24);
        createIcon(map, 'plane-red', flightMil, 24);
        createIcon(map, 'plane-grey', isGhost ? phantomPurple : '#555555', 24);
      } catch (e) {
        console.error('[OsirisMap] plane icon init failed (continuing without plane icons):', e);
      }
      // Helicopter variants (one per flight-category colour) — selected per
      // feature via aircraft_category in the flight symbol layers below.
      try {
        createHeliIcon(map, 'heli-cyan', flightCom, 24);
        createHeliIcon(map, 'heli-green', flightPriv, 24);
        createHeliIcon(map, 'heli-pink', flightGov, 24);
        createHeliIcon(map, 'heli-red', flightMil, 24);
      } catch (e) {
        console.error('[OsirisMap] heli icon init failed (continuing without heli icons):', e);
      }
      try {
        createDot(map, 'dot-gold', isGhost ? phantomPurple : '#D4AF37', 8);
        createDot(map, 'dot-red', '#FF3D3D', 10);
        createDot(map, 'dot-orange', '#FF9500', 10);
        createDot(map, 'dot-green', '#00E676', 10);
        createDot(map, 'dot-fire', '#FF6B00', 10);
        createDot(map, 'dot-cctv', cameraColor, 10);
      } catch (e) {
        console.error('[OsirisMap] dot icon init failed (continuing without dot icons):', e);
      }

      // Unified Threats — 7 distinct glyphs + white-ring "-selected" variants.
      try {
        for (const [, meta] of Object.entries(THREAT_TYPE_META)) {
          createThreatIcon(map, meta.icon, meta.color, false);
          createThreatIcon(map, meta.icon, meta.color, true);
        }
      } catch (e) {
        console.error('[OsirisMap] threat icon init failed (continuing without threat icons):', e);
      }

      // Sources
      const sources = ['flights','military','jets','private-fl','satellites','earthquakes','gdelt','gps-jamming','day-night','cctv','fires','weather','infrastructure','maritime','maritime-choke','maritime-ships','live-news','sigint-news','conflict-zones', 'balloons', 'radiation', 'ip-sweep-devices', 'ip-sweep-pulse', 'ip-sweep-connections', 'scan-targets', 'sdk-entities', 'sdk-links', 'air-raid-alerts', 'power-outages', 'frontlines', 'frontline-ru-gain', 'frontline-ua-gain', 'axis-focus', 'air-quality', 'ioda-outages', 'malware-nodes', 'thermal-aoi', 'captures', 'network-mesh', 'shadow-fleet-tracks', 'alarm-vectors', 'unified-threats', 'threat-trails', 'dark-vessel-uncertainty', 'dark-vessel-dr', 'railway-incidents', 'correlated-events'];
      sources.forEach(s => map.addSource(s, { type: 'geojson', data: EMPTY_FC }));

      // Static rail network — loaded directly from public/ukraine-railways.geojson (ODbL)
      map.addSource('ukraine-rail', { type: 'geojson', data: '/ukraine-railways.geojson' });

      // Warning icon generator (parameterized — eliminates 3x copy-paste)
      const createWarningIcon = (id: string, color: string) => {
        const s = 20;
        const c = document.createElement('canvas');
        c.width = s; c.height = s;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(s/2, 1);
        ctx.lineTo(s - 1, s - 1);
        ctx.lineTo(1, s - 1);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('!', s/2, s - 4);
        map.addImage(id, { width: s, height: s, data: new Uint8Array(ctx.getImageData(0, 0, s, s).data) });
      };
      try {
        createWarningIcon('warn-icon', '#FF1744');
        createWarningIcon('warn-orange', '#FF9500');
        createWarningIcon('warn-yellow', '#FFD500');
      } catch (e) {
        console.error('[OsirisMap] warning-icon init failed (continuing):', e);
      }

      map.addLayer({ id: 'conflict-icons', type: 'symbol', source: 'conflict-zones', layout: {
        'icon-image': ['match', ['get','severity'], 'war','warn-icon', 'high','warn-orange', 'warn-yellow'],
        'icon-size': ['interpolate',['linear'],['zoom'], 1,0.6, 4,0.8, 8,1],
        'icon-allow-overlap': true,
        'text-field': ['get','label'],
        'text-size': ['interpolate',['linear'],['zoom'], 1,7, 4,9, 8,11],
        'text-font': ['Open Sans Bold'],
        'text-offset': [0, 1.4],
        'text-allow-overlap': false,
      }, paint: {
        'text-color': ['match', ['get','severity'], 'war','#FF1744', 'high','#FF9500', '#FFD500'],
        'text-halo-color': '#000', 'text-halo-width': 1.5, 'text-opacity': 0.9,
      }});


      // Day/Night
      map.addLayer({ id: 'day-night-fill', type: 'fill', source: 'day-night', paint: { 'fill-color': '#000022', 'fill-opacity': 0.35 }});

      // Earthquakes
      map.addLayer({ id: 'eq-circles', type: 'circle', source: 'earthquakes', paint: {
        'circle-radius': ['interpolate',['linear'],['get','magnitude'], 2.5,4, 5,12, 7,24],
        'circle-color': ['interpolate',['linear'],['get','magnitude'], 2.5,'#FFD700', 4,'#FF9500', 6,'#FF1744'],
        'circle-opacity': 0.6, 'circle-blur': 0.3, 'circle-stroke-width': 1, 'circle-stroke-color': '#FFD700', 'circle-stroke-opacity': 0.3,
      }});
      map.addLayer({ id: 'eq-label', type: 'symbol', source: 'earthquakes', filter: ['>=',['get','magnitude'],4.5], layout: {
        'text-field': ['concat','M',['to-string',['get','magnitude']]], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0,1.5],
      }, paint: { 'text-color': '#FFD700', 'text-halo-color': '#000', 'text-halo-width': 1 }});

      // Fires
      map.addLayer({ id: 'fires-heat', type: 'circle', source: 'fires', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,2, 5,4, 10,8],
        'circle-color': '#FF6B00', 'circle-opacity': 0.5, 'circle-blur': 0.5,
      }});

      // Ukraine admin boundary fill sources (static assets).
      // Separate source copies for raid vs outage fills so their colours don't blend.
      map.addSource('ukraine-oblast-fill', { type: 'geojson', data: '/ukraine-oblasts.geojson' });
      map.addSource('ukraine-oblast-raid-fill', { type: 'geojson', data: '/ukraine-oblasts.geojson' });
      map.addSource('ukraine-district-fill', { type: 'geojson', data: '/ukraine-districts.geojson' });

      // Oblast fill — shown when level==='oblast' alert; district fill when level==='district'.
      // Both layers sit below the dot layers so dots render on top.
      map.addLayer({ id: 'raid-oblast-fill', type: 'fill', source: 'ukraine-oblast-raid-fill',
        filter: ['in', ['get', 'name_en'], ['literal', []]],
        paint: { 'fill-color': '#FF1744', 'fill-opacity': 0.22 }
      });
      map.addLayer({ id: 'raid-oblast-outline', type: 'line', source: 'ukraine-oblast-raid-fill',
        filter: ['in', ['get', 'name_en'], ['literal', []]],
        paint: { 'line-color': '#FF1744', 'line-width': 1.5, 'line-opacity': 0.55 }
      });
      map.addLayer({ id: 'raid-district-fill', type: 'fill', source: 'ukraine-district-fill',
        filter: ['in', ['get', 'name_ua'], ['literal', []]],
        paint: { 'fill-color': '#FF1744', 'fill-opacity': 0.28 }
      });
      map.addLayer({ id: 'raid-district-outline', type: 'line', source: 'ukraine-district-fill',
        filter: ['in', ['get', 'name_ua'], ['literal', []]],
        paint: { 'line-color': '#FF1744', 'line-width': 1, 'line-opacity': 0.6 }
      });

      // Power outage region fills — amber/yellow, same oblast source as raid fills.
      // Kyiv City ('Kyiv') and Kyiv Oblast ('Kyiv oblast') are separate features in
      // ukraine-oblasts.geojson so both can be highlighted independently.
      map.addLayer({ id: 'outage-oblast-fill', type: 'fill', source: 'ukraine-oblast-fill',
        filter: ['in', ['get', 'name_en'], ['literal', []]],
        paint: { 'fill-color': '#FFD500', 'fill-opacity': 0.16 }
      });
      map.addLayer({ id: 'outage-oblast-outline', type: 'line', source: 'ukraine-oblast-fill',
        filter: ['in', ['get', 'name_en'], ['literal', []]],
        paint: { 'line-color': '#FFD500', 'line-width': 1.5, 'line-opacity': 0.50 }
      });

      // Oblast Pressure Index — amber-to-red choropleth (separate from outage fills).
      // Color and opacity are overridden per-feature via setPaintProperty in the
      // oblast-pressure useEffect; these defaults only show when filter passes but
      // before the first data-driven override lands.
      map.addLayer({ id: 'pressure-oblast-fill', type: 'fill', source: 'ukraine-oblast-fill',
        filter: ['in', ['get', 'name_en'], ['literal', []]],
        paint: { 'fill-color': '#FF7043', 'fill-opacity': 0.30 },
      });
      map.addLayer({ id: 'pressure-oblast-outline', type: 'line', source: 'ukraine-oblast-fill',
        filter: ['in', ['get', 'name_en'], ['literal', []]],
        paint: { 'line-color': '#FF7043', 'line-width': 1.2, 'line-opacity': 0.6 },
      });

      // Frontline (DeepState/Militaryland) — occupied-zone fills + outlines. Uses
      // each feature's own DeepState style colors; fills sit under the dot/label
      // layers added below so markers stay legible.
      map.addLayer({ id: 'frontline-fill', type: 'fill', source: 'frontlines',
        filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
        paint: { 'fill-color': ['coalesce', ['get', 'fill'], '#FF3D3D'], 'fill-opacity': 0.18 }});
      map.addLayer({ id: 'frontline-line', type: 'line', source: 'frontlines',
        paint: { 'line-color': ['coalesce', ['get', 'stroke'], '#FF3D3D'], 'line-width': 1.4, 'line-opacity': 0.85 }});

      // Directional frontline delta — 7-day gain/loss patches (DeepState boolean diff).
      // RU gain (#FF3D00 orange-red, distinct from occupied #FF3D3D) — Russian advance zones.
      // UA gain (#1565C0 blue) — Ukrainian recovery zones.
      map.addLayer({ id: 'frontline-ru-gain-fill', type: 'fill', source: 'frontline-ru-gain',
        filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
        paint: { 'fill-color': '#FF3D00', 'fill-opacity': 0.38 }});
      map.addLayer({ id: 'frontline-ru-gain-line', type: 'line', source: 'frontline-ru-gain',
        paint: { 'line-color': '#FF3D00', 'line-width': 1.8, 'line-opacity': 0.9 }});
      map.addLayer({ id: 'frontline-ua-gain-fill', type: 'fill', source: 'frontline-ua-gain',
        filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
        paint: { 'fill-color': '#1565C0', 'fill-opacity': 0.38 }});
      map.addLayer({ id: 'frontline-ua-gain-line', type: 'line', source: 'frontline-ua-gain',
        paint: { 'line-color': '#1565C0', 'line-width': 1.8, 'line-opacity': 0.9 }});

      // Axis briefing bbox focus highlight
      map.addLayer({ id: 'axis-focus-fill', type: 'fill', source: 'axis-focus',
        paint: { 'fill-color': '#FFD24A', 'fill-opacity': 0.07 } });
      map.addLayer({ id: 'axis-focus-line', type: 'line', source: 'axis-focus',
        paint: { 'line-color': '#FFD24A', 'line-width': 1.5, 'line-opacity': 0.8, 'line-dasharray': [3, 3] } });

      // Air quality (Open-Meteo) — PM2.5 station dots, colored by AQI band.
      map.addLayer({ id: 'aq-glow', type: 'circle', source: 'air-quality', paint: {
        'circle-radius': 13, 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-blur': 1 }});
      map.addLayer({ id: 'aq-dots', type: 'circle', source: 'air-quality', paint: {
        'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.9,
        'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(0,0,0,0.4)' }});
      map.addLayer({ id: 'aq-label', type: 'symbol', source: 'air-quality', minzoom: 4, layout: {
        'text-field': ['concat', ['get', 'city'], '  PM2.5 ', ['to-string', ['get', 'pm25']]],
        'text-size': 9, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
        paint: { 'text-color': '#cfd8dc', 'text-halo-color': '#000', 'text-halo-width': 1 }});

      // Strategic Thermal AOIs — FIRMS fires × airfields/rail/logistics/naval/power/ammo/news.
      const thermalCatColor: any = ['match', ['get', 'category'],
        'airfield', '#00E5FF', 'oil', '#FF9500', 'rail', '#FFD700',
        'logistics', '#FFA500', 'naval', '#4FC3F7', 'power', '#FF6B00',
        'ammo', '#FF3D3D', 'news', '#D4AF37', '#FF6B00'];
      // Glow radius scales with FRP: low-FRP fires get base radius, high-FRP
      // (depot/refinery infernos) bloom larger so they read from low zoom.
      map.addLayer({ id: 'thermal-aoi-glow', type: 'circle', source: 'thermal-aoi', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          1, ['*', 10, ['interpolate', ['linear'], ['coalesce', ['get', 'maxFrp'], 0], 0, 1, 5, 1.5, 20, 2.4, 100, 3.8, 500, 5.5]],
          5, ['*', 16, ['interpolate', ['linear'], ['coalesce', ['get', 'maxFrp'], 0], 0, 1, 5, 1.5, 20, 2.4, 100, 3.8, 500, 5.5]],
          10, ['*', 24, ['interpolate', ['linear'], ['coalesce', ['get', 'maxFrp'], 0], 0, 1, 5, 1.5, 20, 2.4, 100, 3.8, 500, 5.5]],
        ] as any,
        'circle-color': thermalCatColor,
        'circle-opacity': ['case', ['boolean', ['get', 'confirmed'], false], 0.12, 0.03] as any,
        'circle-blur': 1,
      }});
      map.addLayer({ id: 'thermal-aoi-dots', type: 'circle', source: 'thermal-aoi', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 4, 5, 7, 10, 11] as any,
        'circle-color': thermalCatColor,
        // unconfirmed: half-opacity; confirmed: near-full
        'circle-opacity': ['case', ['boolean', ['get', 'confirmed'], false], 0.88, 0.38] as any,
        'circle-stroke-width': ['case', ['boolean', ['get', 'confirmed'], false], 1.5, 2] as any,
        // Stroke color encodes confidence tier (high→green, med→amber, low→grey, news→blue).
        // The hit/videoConfirmed status stays on stroke-width above, not on color.
        'circle-stroke-color': ['match', ['get', 'confidence'],
          'high', '#00E676',
          'med',  '#FFD700',
          'low',  '#9E9E9E',
          'news', '#64B5F6',
          '#9E9E9E'] as any,
        'circle-stroke-opacity': ['case', ['boolean', ['get', 'confirmed'], false], 0.45, 0.9] as any,
      }});
      // Label confirmed strikes (fire OR video) with the site/article name
      map.addLayer({ id: 'thermal-aoi-label', type: 'symbol', source: 'thermal-aoi', minzoom: 5,
        filter: ['boolean', ['get', 'confirmed'], false],
        layout: { 'text-field': ['get', 'name'], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 1.8], 'text-anchor': 'top', 'text-allow-overlap': false },
        paint: { 'text-color': '#FF9500', 'text-halo-color': '#000', 'text-halo-width': 1 }});
      // Unconfirmed news markers: bright amber "?" centred on the dot — unmissable
      map.addLayer({ id: 'thermal-aoi-unconfirmed-label', type: 'symbol', source: 'thermal-aoi', minzoom: 4,
        filter: ['!', ['boolean', ['get', 'confirmed'], false]],
        layout: { 'text-field': '?', 'text-size': 14, 'text-font': ['Open Sans Bold'], 'text-offset': [0, 0], 'text-anchor': 'center', 'text-allow-overlap': true },
        paint: { 'text-color': '#FF8C00', 'text-halo-color': '#000', 'text-halo-width': 1.5 }});
      // Territorial Captures — RU red, UA blue, Conflicted neutral gold.
      map.addLayer({ id: 'capture-glow', type: 'circle', source: 'captures', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 12, 5, 20, 10, 30],
        'circle-color': ['case', ['boolean', ['get', 'conflicted'], false],
          '#FFB300',
          ['match', ['get', 'side'], 'ru', '#FF3D3D', 'ua', '#2979FF', '#888888'],
        ],
        'circle-opacity': ['interpolate', ['linear'], ['get', 'count'], 1, 0.05, 3, 0.14],
        'circle-blur': 1,
      }});
      map.addLayer({ id: 'capture-dots', type: 'circle', source: 'captures', paint: {
        // Radius and opacity scale with corroboration count — count=1 stays small/dim.
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          1,  ['interpolate', ['linear'], ['get', 'count'], 1, 2, 4, 5],
          5,  ['interpolate', ['linear'], ['get', 'count'], 1, 4, 4, 8],
          10, ['interpolate', ['linear'], ['get', 'count'], 1, 6, 4, 12],
        ],
        'circle-color': ['case', ['boolean', ['get', 'conflicted'], false],
          '#FFB300',
          ['match', ['get', 'side'], 'ru', '#FF3D3D', 'ua', '#2979FF', '#888888'],
        ],
        'circle-opacity': ['interpolate', ['linear'], ['get', 'count'], 1, 0.40, 3, 0.88],
        'circle-stroke-width': ['case', ['boolean', ['get', 'conflicted'], false], 2.5, 1.5],
        // Stroke color encodes confidence tier; conflicted status stays on stroke-width above.
        'circle-stroke-color': ['match', ['get', 'confidence'],
          'high', '#00E676',
          'med',  '#FFD700',
          'low',  '#9E9E9E',
          '#9E9E9E'],
        'circle-stroke-opacity': ['interpolate', ['linear'], ['get', 'count'], 1, 0.15, 3, 0.45],
      }});

      // Air Raid Alerts — pulsing red (Ukraine-specific alerts).
      // Oblast-wide alerts render larger; raion (district) alerts render tighter.
      map.addLayer({ id: 'raid-glow', type: 'circle', source: 'air-raid-alerts', paint: {
        // Zoom interpolate must be top-level; district (0.55x) sizing goes in each stop.
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          1,  ['case', ['==', ['get','level'], 'district'], 6.6, 12],
          5,  ['case', ['==', ['get','level'], 'district'], 11, 20],
          10, ['case', ['==', ['get','level'], 'district'], 16.5, 30]],
        'circle-color': '#FF1744', 'circle-opacity': 0.12, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'raid-dots', type: 'circle', source: 'air-raid-alerts', paint: {
        // District alerts (0.7x) render tighter than oblast-wide.
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          1,  ['case', ['==', ['get','level'], 'district'], 3.5, 5],
          5,  ['case', ['==', ['get','level'], 'district'], 5.6, 8],
          10, ['case', ['==', ['get','level'], 'district'], 8.4, 12]],
        'circle-color': '#FF1744', 'circle-opacity': 0.9,
        'circle-stroke-width': 2, 'circle-stroke-color': '#FF1744', 'circle-stroke-opacity': 0.5,
      }});
      map.addLayer({ id: 'raid-label', type: 'symbol', source: 'air-raid-alerts', minzoom: 4, layout: {
        'text-field': ['get','regionName'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.8], 'text-allow-overlap': false,
      }, paint: { 'text-color': '#FF1744', 'text-halo-color': '#000', 'text-halo-width': 1 }});

      // Unified Threats — single point-icon layer replacing the old separate
      // kab/mig31k point layers and the drone-route/missile-routes connected-line
      // meshes (removed: those drew dashed lines between unrelated waypoints,
      // which was the #1 user complaint). Standalone rotated icons only — no
      // connecting lines. Soft glow halo beneath the icons, same recipe as
      // raid-glow/kab-glow (interpolated circle-radius + low opacity + blur).
      //
      // Features carry no `color` property (only `ttype`) — color is derived
      // here via the same ttype->color mapping as THREAT_TYPE_META/createThreatIcon,
      // so the glow/label tint actually matches each type instead of always
      // falling back to one color.
      const THREAT_TTYPE_COLOR_MATCH: any = ['match', ['get', 'ttype'],
        'fpv', '#FFB300', 'cruise', '#FF5252', 'ballistic', '#E040FB',
        'kab', '#FF6B00', 'aviation', '#536DFE', 'recon', '#26C6DA',
        'uav', '#CDDC39', '#CDDC39',
      ];
      // Base icon-image: static per-ttype match, no feature-state. MapLibre/Mapbox
      // GL forbid feature-state expressions in LAYOUT properties (paint-only) —
      // using one here silently drops icon-image entirely, which is why the
      // previous version rendered no icon at all (and therefore nothing to
      // click, since there was no rendered feature to hit-test). Selection is
      // instead handled by a separate overlay layer below, filtered via
      // setFilter — the same pattern this file already uses everywhere else
      // for click-to-highlight (see raid-oblast-fill/neptun-raion-fill etc.).
      const THREAT_ICON_MATCH: any = ['match', ['get', 'ttype'],
        'fpv', 'threat-fpv', 'cruise', 'threat-cruise', 'ballistic', 'threat-ballistic',
        'kab', 'threat-kab', 'aviation', 'threat-aviation', 'recon', 'threat-recon',
        'uav', 'threat-uav', 'threat-uav',
      ];
      // Drone trail lines — historical breadcrumb path for each moving chain,
      // rendered behind the glow+icon so the dot stays visually dominant.
      map.addLayer({ id: 'threat-trail-line', type: 'line', source: 'threat-trails', paint: {
        'line-color': ['coalesce', ['get', 'color'], '#FFFFFF'],
        'line-width': 1.5,
        'line-opacity': 0.45,
        'line-dasharray': [2, 2],
      }});
      map.addLayer({ id: 'unified-threat-glow', type: 'circle', source: 'unified-threats', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 13, 5, 22, 10, 34],
        'circle-color': THREAT_TTYPE_COLOR_MATCH, 'circle-opacity': 0.14, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'unified-threat-icons', type: 'symbol', source: 'unified-threats', layout: {
        'icon-image': THREAT_ICON_MATCH,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 5, 0.85, 10, 1.1],
        // null bearing → unrotated icon (still rendered, never hidden).
        'icon-rotate': ['coalesce', ['get', 'bearing'], 0],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
      }});
      // Selected-state overlay — same source, filtered (via setFilter in the
      // click handler below) down to just the clicked feature's `tid`, drawn
      // with the larger white-ringed "-selected" icon variant. Starts with a
      // filter that matches nothing. Uses `tid` (stable chain id across polls)
      // rather than `fid` (a fresh per-response array index) so a moving
      // drone's highlighted state survives a poll instead of silently
      // dropping when the array order shifts.
      map.addLayer({ id: 'unified-threat-icons-selected', type: 'symbol', source: 'unified-threats',
        filter: ['==', ['get', 'tid'], ''],
        layout: {
          'icon-image': ['concat', THREAT_ICON_MATCH, '-selected'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 5, 0.85, 10, 1.1],
          'icon-rotate': ['coalesce', ['get', 'bearing'], 0],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
        },
      });
      map.addLayer({ id: 'unified-threat-label', type: 'symbol', source: 'unified-threats', minzoom: 4,
        layout: {
          'text-field': ['get', 'title'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
          'text-offset': [0, 1.9], 'text-allow-overlap': false,
        },
        paint: { 'text-color': THREAT_TTYPE_COLOR_MATCH, 'text-halo-color': '#000', 'text-halo-width': 1 },
      });

      // Alarm-Vector inference layer — dashed lines + arrow markers derived from
      // the temporal sequence of air-raid alarm activations across oblasts.
      // Source is pre-registered in the sources array above; layers are controlled
      // via activeLayers.alarm_vectors independently from the drone/missile toggles.
      map.addLayer({
        id: 'alarm-vector-line',
        type: 'line',
        source: 'alarm-vectors',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': '#FF9800',
          'line-width': 1.5,
          'line-opacity': 0.5,
          'line-dasharray': [4, 3],
        },
      });
      map.addLayer({
        id: 'alarm-vector-arrow',
        type: 'symbol',
        source: 'alarm-vectors',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'text-field': '➤',
          'text-size': 14,
          'text-rotate': ['-', ['get', 'bearing'], 90],
          'text-rotation-alignment': 'map',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': ['match', ['get', 'confidence'], 'high', '#FF9800', '#FF980088'],
          'text-halo-color': '#000',
          'text-halo-width': 1,
        },
      });
      map.addLayer({
        id: 'alarm-vector-label',
        type: 'symbol',
        source: 'alarm-vectors',
        filter: ['==', ['geometry-type'], 'LineString'],
        minzoom: 5,
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'label'],
          'text-size': 8,
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#FF9800',
          'text-opacity': 0.6,
          'text-halo-color': '#000000',
          'text-halo-width': 1,
        },
      });

      // RU Oblast Alerts — red (Russian border oblast drone/strike incursions).
      // Note: 'ru-air-raids' is NOT in the sources array above — registered explicitly here.
      map.addSource('ru-air-raids', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'ru-raid-glow', type: 'circle', source: 'ru-air-raids', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 14, 5, 24, 10, 36],
        'circle-color': ['match', ['get', 'status'], 'all-clear', '#607D8B', 'unknown', '#FF9800', '#EF5350'],
        'circle-opacity': ['match', ['get', 'status'], 'all-clear', 0.05, 0.11],
        'circle-blur': 1,
      }});
      map.addLayer({ id: 'ru-raid-dots', type: 'circle', source: 'ru-air-raids', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 5, 5, 9, 10, 13],
        'circle-color': ['match', ['get', 'status'], 'all-clear', '#607D8B', 'unknown', '#FF9800', '#EF5350'],
        'circle-opacity': ['match', ['get', 'status'], 'all-clear', 0.45, 0.85],
        'circle-stroke-width': 2,
        'circle-stroke-color': ['match', ['get', 'status'], 'all-clear', '#607D8B', 'unknown', '#FF9800', '#FF1744'],
        'circle-stroke-opacity': 0.5,
      }});
      map.addLayer({ id: 'ru-raid-label', type: 'symbol', source: 'ru-air-raids', minzoom: 4, layout: {
        'text-field': ['concat',
          ['match', ['get', 'status'], 'all-clear', '[CLEAR] ', 'unknown', '[?] ', 'ALERT: '],
          ['get', 'oblast'],
        ],
        'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.9], 'text-allow-overlap': false,
      }, paint: {
        'text-color': ['match', ['get', 'status'], 'all-clear', '#607D8B', 'unknown', '#FF9800', '#EF5350'],
        'text-halo-color': '#000', 'text-halo-width': 1,
      }});

      // Power Outages — amber/yellow grid-down indicators
      map.addLayer({ id: 'outage-glow', type: 'circle', source: 'power-outages', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,10, 5,16, 10,24],
        'circle-color': '#FFD500', 'circle-opacity': 0.1, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'outage-dots', type: 'circle', source: 'power-outages', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,4, 5,7, 10,10],
        'circle-color': ['match', ['get','type'], 'emergency','#FF6B00', '#FFD500'],
        'circle-opacity': 0.85,
        'circle-stroke-width': 1.5, 'circle-stroke-color': '#FFD500', 'circle-stroke-opacity': 0.4,
      }});
      map.addLayer({ id: 'outage-label', type: 'symbol', source: 'power-outages', minzoom: 4, layout: {
        'text-field': ['get','regionName'], 'text-size': 8, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.6], 'text-allow-overlap': false,
      }, paint: { 'text-color': '#FFD500', 'text-halo-color': '#000', 'text-halo-width': 1 }});

      // CCTV — outer glow ring
      map.addLayer({ id: 'cctv-glow', type: 'circle', source: 'cctv', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,5, 5,8, 10,14, 14,20],
        'circle-color': cameraColor, 'circle-opacity': 0.08, 'circle-blur': 1,
      }});
      // CCTV — main dot
      map.addLayer({ id: 'cctv-dots', type: 'circle', source: 'cctv', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,3, 5,5, 10,8, 14,12],
        'circle-color': cameraColor, 'circle-opacity': 0.8,
        'circle-stroke-width': 2, 'circle-stroke-color': cameraColor, 'circle-stroke-opacity': 0.5,
      }});
      // CCTV — labels at zoom 10+
      map.addLayer({ id: 'cctv-label', type: 'symbol', source: 'cctv', minzoom: 10, layout: {
        'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.8], 'text-max-width': 12, 'text-allow-overlap': false,
      }, paint: { 'text-color': cameraColor, 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.7 }});

      // ══ NETWORK INTEL — IODA Internet Outages ══
      map.addLayer({ id: 'ioda-glow', type: 'circle', source: 'ioda-outages', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,14, 5,24, 10,36],
        'circle-color': '#00E5FF', 'circle-opacity': 0.12, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'ioda-dots', type: 'circle', source: 'ioda-outages', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,4, 5,7, 10,12],
        'circle-color': ['interpolate',['linear'],['get','score'], 0,'#00E5FF', 15000,'#FFD700', 50000,'#FF1744'],
        'circle-opacity': 0.85,
        'circle-stroke-width': 2, 'circle-stroke-color': '#00E5FF', 'circle-stroke-opacity': 0.5,
      }});
      map.addLayer({ id: 'ioda-label', type: 'symbol', source: 'ioda-outages', minzoom: 3, layout: {
        'text-field': ['concat',['get','country'],' OUTAGE'], 'text-size': 9, 'text-font': ['Open Sans Bold'],
        'text-offset': [0, 2], 'text-max-width': 14, 'text-allow-overlap': false,
      }, paint: { 'text-color': '#00E5FF', 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.8 }});

      // ══ NETWORK INTEL — Live Malware (abuse.ch) ══
      map.addLayer({ id: 'malware-glow', type: 'circle', source: 'malware-nodes', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,10, 5,18, 10,28],
        'circle-color': '#FF1744', 'circle-opacity': 0.1, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'malware-dots', type: 'circle', source: 'malware-nodes', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,3, 5,5, 10,8],
        'circle-color': ['match', ['get','threat_type'], 'botnet_c2','#FF1744', 'malware_url','#FF9500', '#FF1744'],
        'circle-opacity': 0.9,
        'circle-stroke-width': 1.5, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-opacity': 0.5,
      }});
      map.addLayer({ id: 'malware-label', type: 'symbol', source: 'malware-nodes', minzoom: 4, layout: {
        'text-field': ['get','malware'], 'text-size': 8, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.8], 'text-max-width': 10, 'text-allow-overlap': false,
      }, paint: { 'text-color': '#FF1744', 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.7 }});

      // ── NETWORK INTEL MESH (SDK STYLE) ──
      map.addLayer({ id: 'network-mesh-atmo', type: 'line', source: 'network-mesh', paint: {
        'line-color': ['match', ['get','threat_type'], 'ioda','#00E5FF', '#FF1744'],
        'line-width': ['interpolate',['linear'],['zoom'], 1, 2, 5, 4, 10, 8],
        'line-opacity': 0.08,
        'line-blur': 4,
      }});
      map.addLayer({ id: 'network-mesh-glow', type: 'line', source: 'network-mesh', paint: {
        'line-color': ['match', ['get','threat_type'], 'ioda','#4DD0E1', '#FF5252'],
        'line-width': ['interpolate',['linear'],['zoom'], 1, 1, 5, 2, 10, 4],
        'line-opacity': 0.2,
        'line-blur': 1.5,
      }});
      map.addLayer({ id: 'network-mesh-core', type: 'line', source: 'network-mesh', paint: {
        'line-color': ['match', ['get','threat_type'], 'ioda','#E0F7FA', '#FFCDD2'],
        'line-width': ['interpolate',['linear'],['zoom'], 1, 0.2, 5, 0.5, 10, 1.5],
        'line-opacity': 0.4,
      }});

      // GDELT / Conflict Events (confidence-tiered)
      map.addLayer({ id: 'gdelt-dots', type: 'circle', source: 'gdelt', paint: {
        'circle-color': [
          'match', ['get', 'confidence'],
          'confirmed', '#FF3D3D',
          'reported',  '#FF9500',
          'unverified','#FFD54F',
          '#FF3D3D', // default
        ],
        'circle-radius': [
          'match', ['get', 'confidence'],
          'confirmed', 6,
          'reported',  4,
          3, // unverified + default
        ],
        'circle-opacity': [
          'match', ['get', 'confidence'],
          'unverified', 0.4,
          0.8,
        ],
        'circle-stroke-width': 1,
        'circle-stroke-color': [
          'match', ['get', 'confidence'],
          'confirmed', '#FF3D3D',
          'reported',  '#FF9500',
          'unverified','#FFD54F',
          '#FF3D3D',
        ],
        'circle-stroke-opacity': 0.3,
      }});

      // GPS Jamming
      map.addLayer({ id: 'jam-fill', type: 'circle', source: 'gps-jamming', paint: { 'circle-radius': ['match', ['get', 'severity'], 'high', 40, 'medium', 25, 15] as any, 'circle-color': '#FF0000', 'circle-opacity': 0.15, 'circle-blur': 1 }});
      map.addLayer({ id: 'jam-label', type: 'symbol', source: 'gps-jamming', layout: {
        'text-field': ['concat','GPS JAM ',['to-string',['get','severity']],'%'], 'text-size': 10, 'text-font': ['Open Sans Bold'], 'text-allow-overlap': true,
      }, paint: { 'text-color': '#FF4444', 'text-halo-color': '#000', 'text-halo-width': 1 }});

      // Weather Events (NASA EONET — storms, volcanoes)
      map.addLayer({ id: 'weather-glow', type: 'circle', source: 'weather', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,12, 5,20, 10,30],
        'circle-color': '#E040FB', 'circle-opacity': 0.1, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'weather-dots', type: 'circle', source: 'weather', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,5, 5,8, 10,14],
        'circle-color': ['match', ['get','icon'], 'cyclone','#E040FB', 'volcano','#FF1744', '#E040FB'],
        'circle-opacity': 0.8,
        'circle-stroke-width': 2, 'circle-stroke-color': '#E040FB', 'circle-stroke-opacity': 0.4,
      }});
      map.addLayer({ id: 'weather-label', type: 'symbol', source: 'weather', layout: {
        'text-field': ['get','title'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 2], 'text-max-width': 14, 'text-allow-overlap': false,
      }, paint: { 'text-color': '#E040FB', 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.8 }});

      // Nuclear Infrastructure
      map.addLayer({ id: 'infra-glow', type: 'circle', source: 'infrastructure', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,8, 5,14, 10,22],
        'circle-color': ['case', ['in', 'SEISMIC RISK', ['get', 'status']], '#FF9500', '#76FF03'],
        'circle-opacity': 0.08, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'infra-dots', type: 'circle', source: 'infrastructure', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,4, 5,6, 10,10],
        'circle-color': ['case', 
          ['in', 'SEISMIC RISK', ['get', 'status']], '#FF9500',
          ['==', ['get','status'], 'Active Conflict Zone'], '#FF1744', 
          ['==', ['get','status'], 'Destroyed / Decommissioning'], '#757575', 
          '#76FF03'
        ],
        'circle-opacity': 0.8,
        'circle-stroke-width': 2, 'circle-stroke-color': ['case', ['in', 'SEISMIC RISK', ['get', 'status']], '#FF9500', '#76FF03'], 'circle-stroke-opacity': 0.4,
      }});
      map.addLayer({ id: 'infra-label', type: 'symbol', source: 'infrastructure', minzoom: 5, layout: {
        'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 2], 'text-max-width': 14, 'text-allow-overlap': false,
      }, paint: { 'text-color': ['case', ['in', 'SEISMIC RISK', ['get', 'status']], '#FF9500', '#76FF03'], 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.7 }});

      // Satellites
      map.addLayer({ id: 'sat-glow', type: 'circle', source: 'satellites', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,3, 5,6], 'circle-color': ['get','color'], 'circle-opacity': 0.3, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'sat-dots', type: 'circle', source: 'satellites', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,1.5, 5,3], 'circle-color': ['get','color'], 'circle-opacity': 1.0,
      }});

      // Maritime — ports & naval bases
      map.addLayer({ id: 'maritime-glow', type: 'circle', source: 'maritime', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,6, 5,12, 10,20],
        'circle-color': ['match', ['get','type'], 'naval','#FF3D3D', 'energy','#FF9500', '#00BCD4'],
        'circle-opacity': 0.1, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'maritime-dots', type: 'circle', source: 'maritime', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,3, 5,5, 10,9],
        'circle-color': ['match', ['get','type'], 'naval','#FF3D3D', 'energy','#FF9500', '#00BCD4'],
        'circle-opacity': 0.85,
        'circle-stroke-width': 2, 'circle-stroke-color': ['match', ['get','type'], 'naval','#FF3D3D', 'energy','#FF9500', '#00BCD4'], 'circle-stroke-opacity': 0.4,
      }});
      map.addLayer({ id: 'maritime-label', type: 'symbol', source: 'maritime', minzoom: 4, layout: {
        'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.8], 'text-max-width': 12, 'text-allow-overlap': false,
      }, paint: { 'text-color': '#00BCD4', 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.7 }});

      // Maritime chokepoints — pulsing warning diamonds
      map.addLayer({ id: 'choke-glow', type: 'circle', source: 'maritime-choke', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,10, 5,18, 10,28],
        'circle-color': '#FF9500', 'circle-opacity': 0.12, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'choke-dots', type: 'circle', source: 'maritime-choke', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,4, 5,7, 10,12],
        'circle-color': ['match', ['get','risk'], 'CRITICAL','#FF1744', 'HIGH','#FF9500', 'ELEVATED','#FFD700', '#00E676'],
        'circle-opacity': 0.9,
        'circle-stroke-width': 2, 'circle-stroke-color': '#FF9500', 'circle-stroke-opacity': 0.5,
      }});
      map.addLayer({ id: 'choke-label', type: 'symbol', source: 'maritime-choke', minzoom: 3, layout: {
        'text-field': ['get','name'], 'text-size': 10, 'text-font': ['Open Sans Bold'],
        'text-offset': [0, 2], 'text-max-width': 14, 'text-allow-overlap': false,
      }, paint: { 'text-color': '#FF9500', 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.9 }});

      // Live News — broadcast dots
      map.addLayer({ id: 'news-glow', type: 'circle', source: 'live-news', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,8, 5,14, 10,22],
        'circle-color': '#FF4081', 'circle-opacity': 0.1, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'news-dots', type: 'circle', source: 'live-news', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,4, 5,6, 10,10],
        'circle-color': '#FF4081', 'circle-opacity': 0.85,
        'circle-stroke-width': 2, 'circle-stroke-color': '#FF4081', 'circle-stroke-opacity': 0.5,
      }});
      map.addLayer({ id: 'news-label', type: 'symbol', source: 'live-news', minzoom: 4, layout: {
        'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.8], 'text-max-width': 12, 'text-allow-overlap': false,
      }, paint: { 'text-color': '#FF4081', 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.8 }});

      // SIGINT RSS news - gold markers
      map.addLayer({ id: 'sigint-news-glow', type: 'circle', source: 'sigint-news', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,6, 5,10, 10,18],
        'circle-color': '#D4AF37', 'circle-opacity': 0.12, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'sigint-news-dots', type: 'circle', source: 'sigint-news', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,3, 5,5, 10,8],
        'circle-color': '#D4AF37', 'circle-opacity': 0.9,
        'circle-stroke-width': 1.5, 'circle-stroke-color': '#FFF8DC', 'circle-stroke-opacity': 0.6,
      }});
      map.addLayer({ id: 'sigint-news-label', type: 'symbol', source: 'sigint-news', minzoom: 5, layout: {
        'text-field': ['get','source'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.6], 'text-max-width': 10, 'text-allow-overlap': false,
      }, paint: { 'text-color': '#D4AF37', 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.85 }});

      // ══ IP SWEEP — Neighborhood device visualization ══
      map.addLayer({ id: 'sweep-connections', type: 'line', source: 'ip-sweep-connections', paint: {
        'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.3, 'line-dasharray': [2, 4],
      }});
      map.addLayer({ id: 'sweep-pulse-ring', type: 'circle', source: 'ip-sweep-pulse', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 8,40, 12,80, 16,160],
        'circle-color': 'transparent', 'circle-opacity': 0.6,
        'circle-stroke-width': 2, 'circle-stroke-color': '#FF3D3D', 'circle-stroke-opacity': 0.4,
      }});
      map.addLayer({ id: 'sweep-device-glow', type: 'circle', source: 'ip-sweep-devices', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 8,8, 12,16, 16,30],
        'circle-color': ['get', 'color'], 'circle-opacity': 0.15, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'sweep-device-dots', type: 'circle', source: 'ip-sweep-devices', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 8,3, 12,6, 16,10],
        'circle-color': ['get', 'color'], 'circle-opacity': 0.95,
        'circle-stroke-width': 1.5, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-opacity': 0.6,
      }});
      map.addLayer({ id: 'sweep-device-labels', type: 'symbol', source: 'ip-sweep-devices', minzoom: 13, layout: {
        'text-field': ['concat', ['get', 'device_type'], '\n', ['get', 'ip']],
        'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 2.2], 'text-max-width': 12, 'text-allow-overlap': false,
      }, paint: {
        'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.5, 'text-opacity': 0.9,
      }});

      // ══ SCAN TARGETS — Geolocated individual scans ══
      map.addLayer({ id: 'scan-targets-glow', type: 'circle', source: 'scan-targets', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,12, 5,25, 10,40],
        'circle-color': '#FF3D3D', 'circle-opacity': 0.2, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'scan-targets-dots', type: 'circle', source: 'scan-targets', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,5, 5,8, 10,12],
        'circle-color': '#FF3D3D', 'circle-opacity': 0.95,
        'circle-stroke-width': 2, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-opacity': 0.8,
      }});
      map.addLayer({ id: 'scan-targets-label', type: 'symbol', source: 'scan-targets', layout: {
        'text-field': ['get', 'id'], 'text-size': 11, 'text-font': ['Open Sans Bold'],
        'text-offset': [0, 2], 'text-max-width': 14, 'text-allow-overlap': false,
      }, paint: { 'text-color': '#FF3D3D', 'text-halo-color': '#000', 'text-halo-width': 1.5, 'text-opacity': 0.9 }});

      // Flight layers (WebGL symbol — GPU rendered, handles 50K+ smooth).
      // Each layer picks a plane or helicopter glyph per feature via
      // aircraft_category; helis aren't heading-rotated (their rotor glyph reads
      // the same at any angle, and "direction" is meaningless for a hovering one).
      const flightLayers = [
        { id: 'fl-commercial', src: 'flights', plane: 'plane-cyan', heli: 'heli-cyan' },
        { id: 'fl-private', src: 'private-fl', plane: 'plane-green', heli: 'heli-green' },
        { id: 'fl-jets', src: 'jets', plane: 'plane-pink', heli: 'heli-pink' },
        { id: 'fl-military', src: 'military', plane: 'plane-red', heli: 'heli-red' },
      ];
      flightLayers.forEach(l => {
        map.addLayer({ id: l.id, type: 'symbol', source: l.src, layout: {
          'icon-image': ['match', ['get','aircraft_category'], 'heli', l.heli, l.plane],
          'icon-size': ['interpolate',['linear'],['zoom'], 1,0.4, 5,0.7, 10,1],
          'icon-rotate': ['match', ['get','aircraft_category'], 'heli', 0, ['get','heading']],
          'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        }, paint: { 'icon-opacity': 0.85 }});
      });

      // Balloons (moving entities)
      map.addLayer({ id: 'balloon-dots', type: 'circle', source: 'balloons', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,3, 5,5, 10,7],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.8,
        'circle-stroke-width': 1, 'circle-stroke-color': '#fff', 'circle-stroke-opacity': 0.5,
      }});
      map.addLayer({ id: 'balloon-label', type: 'symbol', source: 'balloons', minzoom: 4, layout: {
        'text-field': ['get','callsign'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.2], 'text-max-width': 12, 'text-allow-overlap': false,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1 }});

      // Radiation (glow based on reading level)
      map.addLayer({ id: 'rad-glow', type: 'circle', source: 'radiation', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,10, 5,20, 10,40],
        'circle-color': ['match', ['get','status'], 'DANGER','#FF1744', 'WARNING','#FF9500', '#AB47BC'],
        'circle-opacity': 0.15, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'rad-dots', type: 'circle', source: 'radiation', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,4, 5,6, 10,8],
        'circle-color': ['match', ['get','status'], 'DANGER','#FF1744', 'WARNING','#FF9500', '#AB47BC'],
        'circle-opacity': 0.9,
        'circle-stroke-width': 2, 'circle-stroke-color': ['match', ['get','status'], 'DANGER','#FF1744', 'WARNING','#FF9500', '#AB47BC'], 'circle-stroke-opacity': 0.4,
      }});
      map.addLayer({ id: 'rad-label', type: 'symbol', source: 'radiation', minzoom: 5, layout: {
        'text-field': ['concat', ['to-string', ['get','reading']], ' nSv/h'], 'text-size': 9, 'text-font': ['Open Sans Bold'],
        'text-offset': [0, 1.5], 'text-allow-overlap': false,
      }, paint: { 'text-color': ['match', ['get','status'], 'DANGER','#FF1744', 'WARNING','#FF9500', '#AB47BC'], 'text-halo-color': '#000', 'text-halo-width': 1 }});

      // ══ OSIRIS SDK — Lattice Intelligence Mesh ══
      // Polybolos Style: Delicate, translucent, steel-blue splined mesh

      // ── SEA domain (Distinct Solid Lines) ──
      // Removed glow to match the clean, diagrammatic look of submarinecablemap.com
      map.addLayer({ id: 'sdk-sea', type: 'line', source: 'sdk-links', filter: ['==',['get','domain'],'SEA'], paint: {
        'line-color': ['coalesce', ['get', 'color'], '#1976D2'], // Single solid color from properties
        'line-width': ['interpolate',['linear'],['zoom'], 1, 0.8, 5, 1.5, 10, 2.5],
        'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.3, 5, 0.5, 10, 0.7],
      }});

      // ── AIR domain (Steel Gray / Cyan) ──
      map.addLayer({ id: 'sdk-air-atmo', type: 'line', source: 'sdk-links', filter: ['==',['get','domain'],'AIR'], paint: {
        'line-color': '#4DD0E1',
        'line-width': ['interpolate',['linear'],['zoom'], 1, 1.5, 5, 5, 10, 8],
        'line-opacity': 0.04,
        'line-blur': 3,
      }});
      map.addLayer({ id: 'sdk-air-glow', type: 'line', source: 'sdk-links', filter: ['==',['get','domain'],'AIR'], paint: {
        'line-color': '#80DEEA',
        'line-width': ['interpolate',['linear'],['zoom'], 1, 0.8, 5, 2, 10, 4],
        'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.08, 5, 0.12, 10, 0.18],
        'line-blur': 1,
      }});
      map.addLayer({ id: 'sdk-air', type: 'line', source: 'sdk-links', filter: ['==',['get','domain'],'AIR'], paint: {
        'line-color': '#B2EBF2',
        'line-width': ['interpolate',['linear'],['zoom'], 1, 0.15, 5, 0.6, 10, 1.2],
        'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.2, 5, 0.35, 10, 0.5],
      }});

      // ── INTEL domain (Deep Steel / Violet) ──
      map.addLayer({ id: 'sdk-intel-atmo', type: 'line', source: 'sdk-links', filter: ['==',['get','domain'],'INTEL'], paint: {
        'line-color': '#7986CB',
        'line-width': ['interpolate',['linear'],['zoom'], 1, 2.5, 5, 7, 10, 12],
        'line-opacity': 0.06,
        'line-blur': 5,
      }});
      map.addLayer({ id: 'sdk-intel-glow', type: 'line', source: 'sdk-links', filter: ['==',['get','domain'],'INTEL'], paint: {
        'line-color': '#9FA8DA',
        'line-width': ['interpolate',['linear'],['zoom'], 1, 1.2, 5, 3, 10, 6],
        'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.12, 5, 0.18, 10, 0.25],
        'line-blur': 2,
      }});
      map.addLayer({ id: 'sdk-intel', type: 'line', source: 'sdk-links', filter: ['==',['get','domain'],'INTEL'], paint: {
        'line-color': '#C5CAE9',
        'line-width': ['interpolate',['linear'],['zoom'], 1, 0.3, 5, 1, 10, 2],
        'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.3, 5, 0.45, 10, 0.7],
      }});

      // Maritime Ships (moving entities) — normal vessels only (shadow fleet
      // is a separate toggle/layer below). Filter excludes shadow_fleet.
      map.addLayer({ id: 'ship-dots', type: 'circle', source: 'maritime-ships',
        filter: ['!=', ['get','shadow_fleet'], true], paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1,3, 5,5, 10,8],
        'circle-color': ['match', ['get','type'], 'military','#FF1744', 'tanker','#FF9500', 'cargo','#00BCD4', '#fff'],
        'circle-opacity': 0.8,
      }});
      map.addLayer({ id: 'ship-label', type: 'symbol', source: 'maritime-ships', minzoom: 5,
        filter: ['!=', ['get','shadow_fleet'], true], layout: {
        'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.2], 'text-allow-overlap': false,
      }, paint: { 'text-color': ['match', ['get','type'], 'military','#FF1744', 'tanker','#FF9500', 'cargo','#00BCD4', '#fff'], 'text-halo-color': '#000', 'text-halo-width': 1 }});

      // Shadow fleet (sanctioned / dark vessels) — independent toggle, magenta, larger.
      map.addLayer({ id: 'ship-shadow-dots', type: 'circle', source: 'maritime-ships',
        filter: ['==', ['get','shadow_fleet'], true], paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1,5, 5,7, 10,10],
        'circle-color': '#E040FB',
        // Dim vessels that have gone AIS-dark (last position is stale) so a
        // hours-old track is visibly distinct from a live one.
        'circle-opacity': ['case', ['get','stale'], 0.35, 0.9],
        'circle-stroke-width': 1.5, 'circle-stroke-color': '#E040FB',
        'circle-stroke-opacity': ['case', ['get','stale'], 0.3, 0.6],
      }});
      map.addLayer({ id: 'ship-shadow-label', type: 'symbol', source: 'maritime-ships', minzoom: 3,
        filter: ['==', ['get','shadow_fleet'], true], layout: {
        'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.4], 'text-allow-overlap': false,
      }, paint: { 'text-color': '#E040FB', 'text-halo-color': '#000', 'text-halo-width': 1 }});

      // ══ UKRAINE RAIL NETWORK — static from public/ukraine-railways.geojson (ODbL) ══
      map.addLayer({
        id:     'rail-network-line',
        type:   'line',
        source: 'ukraine-rail',
        paint: {
          'line-color':   '#78909C',
          'line-width':   ['interpolate', ['linear'], ['zoom'], 4, 0.5, 8, 1.5],
          'line-opacity': 0.7,
        },
      });

      // ══ RAILWAY STRIKE INCIDENTS — Telegram-derived, oblast-level precision ══
      map.addLayer({
        id:     'rail-strike-dots',
        type:   'circle',
        source: 'railway-incidents',
        paint: {
          'circle-radius':       6,
          'circle-color':        '#FF5722',
          'circle-opacity':      0.9,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#000',
          'circle-stroke-opacity': 0.7,
        },
      });
      map.addLayer({
        id:     'rail-strike-label',
        type:   'symbol',
        source: 'railway-incidents',
        minzoom: 5,
        layout: {
          'text-field':        ['get', 'source'],
          'text-size':         9,
          'text-font':         ['Open Sans Regular'],
          'text-offset':       [0, 1.6],
          'text-max-width':    12,
          'text-allow-overlap': false,
        },
        paint: {
          'text-color':       '#FF5722',
          'text-halo-color':  '#000',
          'text-halo-width':  1,
          'text-opacity':     0.85,
        },
      });

      // Shadow Fleet Track Lines — age-faded dashed polylines, one segment per
      // consecutive position pair. Opacity fades from near-full (fresh) to near-zero
      // (24h old) via data-driven interpolation on the ageHours property.
      map.addLayer({
        id: 'shadow-track-line',
        type: 'line',
        source: 'shadow-fleet-tracks',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#E040FB',
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1, 8, 2.5],
          'line-dasharray': [2, 2],
          'line-opacity': ['interpolate', ['linear'], ['get', 'ageHours'], 0, 0.9, 24, 0.12],
        },
      });

      // ── AIS Dark Vessel Dead-Reckoning layers ──
      // Expanding uncertainty ring — fill fades out as elapsed time grows.
      map.addLayer({ id: 'dark-vessel-uncertainty-fill', type: 'fill', source: 'dark-vessel-uncertainty', paint: {
        'fill-color': '#E040FB',
        'fill-opacity': ['interpolate', ['linear'], ['get', 'elapsedHours'], 0, 0.25, 6, 0.05],
      }});
      // Hollow circle marker for the DR estimated position.
      map.addLayer({ id: 'dark-vessel-dr-point', type: 'circle', source: 'dark-vessel-dr', paint: {
        'circle-radius': 6,
        'circle-color': 'transparent',
        'circle-stroke-color': '#E040FB',
        'circle-stroke-width': 2,
        'circle-opacity': 0.8,
      }});
      // "DR EST" text label above the DR point.
      map.addLayer({ id: 'dark-vessel-dr-label', type: 'symbol', source: 'dark-vessel-dr', minzoom: 3, layout: {
        'text-field': 'DR EST',
        'text-size': 9,
        'text-font': ['Open Sans Regular'],
        'text-offset': [0, -1.4],
        'text-allow-overlap': false,
      }, paint: { 'text-color': '#E040FB', 'text-halo-color': '#000', 'text-halo-width': 1 }});

      // ── Correlated Events — multi-signal oblast correlation (ring + label) ──
      // Pulse-style ring: alarm_confirmed = red (#FF1744), unconfirmed = orange (#FF6D00).
      map.addLayer({
        id: 'correlated-ring',
        type: 'circle',
        source: 'correlated-events',
        paint: {
          'circle-radius': 18,
          'circle-color': ['case', ['boolean', ['get', 'alarm_confirmed'], false], '#FF1744', '#FF6D00'],
          'circle-opacity': 0.25,
          'circle-stroke-color': ['case', ['boolean', ['get', 'alarm_confirmed'], false], '#FF1744', '#FF6D00'],
          'circle-stroke-width': 2,
          'circle-stroke-opacity': 0.8,
        },
      });
      map.addLayer({
        id: 'correlated-label',
        type: 'symbol',
        source: 'correlated-events',
        minzoom: 4,
        layout: {
          'text-field': ['get', 'oblast'],
          'text-size': 9,
          'text-font': ['Open Sans Regular'],
          'text-offset': [0, 2.2],
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': ['case', ['boolean', ['get', 'alarm_confirmed'], false], '#FF1744', '#FF6D00'],
          'text-halo-color': '#000',
          'text-halo-width': 1,
        },
      });

      // Hide disputed boundary lines from the Carto base style (e.g. dashed
      // line drawn between Crimea and mainland Ukraine). Regex catches any
      // variant name the CDN may use without hard-coding layer IDs.
      map.getStyle().layers.forEach((l: any) => {
        if (/disputed/i.test(l.id)) {
          try { map.setLayoutProperty(l.id, 'visibility', 'none'); } catch {}
        }
      });

      setMapReady(true);
      onMapReady?.();
    });

    // Events
    let lastMove = 0;
    map.on('mousemove', e => {
      const now = Date.now();
      if (now - lastMove > 100) {
        lastMove = now;
        onMouseCoords?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      }
    });
    map.on('contextmenu', e => { e.preventDefault(); onRightClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }); });
    map.on('moveend', () => { const c = map.getCenter(); onViewStateChange?.({ zoom: map.getZoom(), latitude: c.lat, longitude: c.lng }); });

    // ── POPUP HELPER ──
    const popup = (coords: any, html: string) => {
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({ closeButton: true, maxWidth: '420px', offset: 14 }).setLngLat(coords).setHTML(html).addTo(map);
    };
    const pStyle = `background:rgba(12,14,26,0.95);backdrop-filter:blur(16px);border-radius:10px;padding:16px;font-family:'JetBrains Mono',monospace;`;
    const linkStyle = `display:inline-block;margin-top:8px;padding:5px 12px;font-size:10px;letter-spacing:0.12em;text-decoration:none;border-radius:5px;font-family:'JetBrains Mono',monospace;`;

    // ── Flights (with FlightAware + ADS-B Exchange links) ──
    ['fl-commercial','fl-private','fl-jets','fl-military'].forEach(layer => {
      map.on('click', layer, e => {
        if (!e.features?.length) return;
        const p = e.features[0].properties as any;
        const coords = (e.features[0].geometry as any).coordinates;
        const cs = (p.callsign||'').trim();
        const icao = String(p.icao24||'');
        popup(coords, `<div style="${pStyle}border:1px solid rgba(212,175,55,0.3);">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <span style="color:#D4AF37;font-size:16px;font-weight:700;letter-spacing:0.1em;">${esc(cs)}</span>
            <span style="color:#5C5A54;font-size:10px;">${esc(icao)}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:11px;">
            <div><span style="color:#5C5A54;font-size:9px;">MODEL</span><br/><span style="color:#E8E6E0;">${esc(p.model)||'—'}</span></div>
            <div><span style="color:#5C5A54;font-size:9px;">ALT</span><br/><span style="color:#00E5FF;">${p.alt?Math.round(p.alt)+'m':'—'}</span></div>
            <div><span style="color:#5C5A54;font-size:9px;">SPEED</span><br/><span style="color:#E8E6E0;">${esc(p.speed_knots)||'—'}kt</span></div>
            <div><span style="color:#5C5A54;font-size:9px;">HDG</span><br/><span style="color:#E8E6E0;">${Math.round(p.heading||0)}°</span></div>
            <div><span style="color:#5C5A54;font-size:9px;">REG</span><br/><span style="color:#E8E6E0;">${esc(p.registration)||'—'}</span></div>
            <div><span style="color:#5C5A54;font-size:9px;">POS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(2)},${coords[0].toFixed(2)}</span></div>
          </div>
          <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;">
            <a href="https://www.flightaware.com/live/flight/${encodeURIComponent(cs)}" target="_blank" style="${linkStyle}color:#D4AF37;border:1px solid rgba(212,175,55,0.4);background:rgba(212,175,55,0.1);">⚡ FLIGHTAWARE</a>
            <a href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(icao)}" target="_blank" style="${linkStyle}color:#00E5FF;border:1px solid rgba(0,229,255,0.4);background:rgba(0,229,255,0.1);">📡 ADS-B</a>
            <a href="https://www.radarbox.com/data/flights/${encodeURIComponent(cs)}" target="_blank" style="${linkStyle}color:#FF69B4;border:1px solid rgba(255,105,180,0.4);background:rgba(255,105,180,0.1);">📍 RADARBOX</a>
          </div>
          <button onclick="window.openOsirisIntel({ callsign: '${jsAttr(cs)}', icao24: '${jsAttr(icao)}', model: '${jsAttr(p.model||'')}', registration: '${jsAttr(p.registration||'')}' })" style="width:100%;margin-top:8px;padding:6px 12px;background:rgba(212,175,55,0.15);border:1px solid rgba(212,175,55,0.5);color:#D4AF37;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:bold;letter-spacing:0.1em;border-radius:4px;cursor:pointer;">[ DEEP DIVE INTEL ]</button>
        </div>`);
        onEntityClick?.(p);
      });
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    });

    // ── CCTV (opens CameraViewer panel) ──
    map.on('click', 'cctv-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      // Emit the camera data so the CameraViewer opens
      onEntityClick?.({
        type: 'cctv',
        id: p.id,
        name: p.name,
        city: p.city,
        country: p.country,
        source: p.source,
        feed_url: p.feed_url,
        stream_url: p.stream_url,
        stream_type: p.stream_type,
        external_url: p.external_url,
        lat: coords[1],
        lng: coords[0],
      });
      // Also fly to the camera
      map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), 13), duration: 1000 });
    });

    // ── Earthquakes (with USGS link) ──
    map.on('click', 'eq-circles', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,149,0,0.3);">
        <div style="color:#FF9500;font-size:14px;font-weight:700;margin-bottom:4px;">M${esc(p.magnitude)} EARTHQUAKE</div>
        <div style="font-size:9px;color:#E8E6E0;margin-bottom:8px;">${esc(p.place)||'Unknown location'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;">
          <div><span style="color:#5C5A54;">DEPTH</span><br/><span style="color:#E8E6E0;">${esc(p.depth)||'—'}km</span></div>
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(3)}, ${coords[0].toFixed(3)}</span></div>
        </div>
        <a href="${p.source === 'NIGGG-BAS' ? 'https://ndc.niggg.bas.bg/' : `https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(p.id||'')}`}" target="_blank" style="${linkStyle}color:#FF9500;border:1px solid rgba(255,149,0,0.4);background:rgba(255,149,0,0.1);">📊 ${p.source === 'NIGGG-BAS' ? 'NIGGG-BAS' : 'USGS DETAILS'}</a>
      </div>`);
    });

    // ── Satellites (SatNOGS powered) ──
    map.on('click', 'sat-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid rgba(212,175,55,0.3);">
        <div style="color:#D4AF37;font-size:12px;font-weight:700;letter-spacing:0.1em;margin-bottom:4px;">🛰️ ${esc(p.name)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:9px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">MISSION</span><br/><span style="color:${esc(p.color)||'#aaa'};">${esc(p.mission)||'Unknown'}</span></div>
          <div><span style="color:#5C5A54;">ALT</span><br/><span style="color:#00E5FF;">${p.alt ? esc(p.alt)+' km' : '—'}</span></div>
          <div><span style="color:#5C5A54;">POS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(2)}°, ${coords[0].toFixed(2)}°</span></div>
        </div>
        ${p.noradId ? `<a href="https://db.satnogs.org/satellite/${encodeURIComponent(p.noradId)}/" target="_blank" style="display:block;text-align:center;padding:4px;margin-top:6px;font-size:8px;font-family:monospace;letter-spacing:0.1em;text-decoration:none;color:#00E5FF;border:1px solid rgba(0,229,255,0.4);background:rgba(0,229,255,0.1);border-radius:2px;cursor:pointer;">🔭 SOURCE: SATNOGS</a>` : ''}
      </div>`);
    });

    // ── Fires (with NASA FIRMS link) ──
    map.on('click', 'fires-heat', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,107,0,0.3);">
        <div style="color:#FF6B00;font-size:12px;font-weight:700;margin-bottom:6px;">🔥 ACTIVE FIRE DETECTED</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">BRIGHTNESS</span><br/><span style="color:#FF6B00;">${esc(p.brightness)||'—'}K</span></div>
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(3)}°, ${coords[0].toFixed(3)}°</span></div>
        </div>
        <a href="https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;l:noaa20-viirs,viirs,modis_a,modis_t;@${coords[0]},${coords[1]},10z" target="_blank" style="${linkStyle}color:#FF6B00;border:1px solid rgba(255,107,0,0.4);background:rgba(255,107,0,0.1);">🛰️ NASA FIRMS MAP</a>
      </div>`);
    });

    // ── Thermal Strike AOIs ──
    map.on('click', 'thermal-aoi-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const catLabel = (p.category || 'site').toUpperCase();
      const catColor = { airfield: '#00E5FF', oil: '#FF9500', rail: '#FFD700', logistics: '#FFA500', naval: '#4FC3F7', power: '#FF6B00', ammo: '#FF3D3D', news: '#D4AF37' }[p.category as string] || '#FF6B00';
      const confColor = p.confidence === 'high' ? '#00E676' : p.confidence === 'med' ? '#FFD700' : p.confidence === 'low' ? '#888' : '#8B7355';
      const weapon = p.weapon || '';
      const weaponColor = weapon === 'MISSILE' ? '#FF4444' : weapon === 'SHAHED' ? '#FF9500' : weapon === 'GLIDE BOMB' ? '#FF6B00' : weapon === 'ARTILLERY' ? '#FFD700' : '';
      const isNews = p.category === 'news';
      let sourcesHtml = '';
      let snippetHtml = '';
      try {
        const srcs = JSON.parse(p.sources || '[]') as any[];
        if (srcs.length > 0) {
          const first = srcs[0];
          // For site markers that received merged news/Telegram sources, show the best-extracted
          // snippet from the first contributing article (not just the raw title).
          if (!isNews && (first.snippet || first.title)) {
            const text = (first.snippet || first.title) as string;
            snippetHtml = `<div style="font-size:9px;color:#8A8880;line-height:1.4;margin-bottom:6px;font-style:italic;">"${esc(text.slice(0, 120))}"</div>`;
          }
          const linkRows = srcs.filter((s: any) => s.link || s.source).map((s: any) => {
            const label = (s.snippet || s.title) as string | undefined;
            return `<div style="margin-bottom:3px;line-height:1.4;">${s.link ? `<a href="${safeUrl(s.link)}" target="_blank" style="color:#D4AF37;text-decoration:none;">${esc(s.source)||'source'}</a>` : `<span style="color:#D4AF37;">${esc(s.source)}</span>`}${label ? `<span style="color:#666;font-size:8px;"> — ${esc(label.slice(0,90))}</span>` : ''}</div>`;
          }).join('');
          sourcesHtml = linkRows ? `<div style="font-size:9px;margin-top:6px;">${linkRows}</div>` : '';
        }
      } catch { /* ignore */ }
      popup(coords, `<div style="${pStyle}border:1px solid ${catColor}40;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
          <span style="background:${catColor}22;color:${catColor};font-size:9px;padding:2px 5px;border-radius:2px;letter-spacing:0.08em;">${esc(catLabel)}</span>
          ${p.bilateral ? `<span style="color:#FFD700;font-size:9px;">· UA+RU</span>` : ''}
          ${p.videoConfirmed ? `<span style="color:#00E5FF;font-size:9px;">· 🎥 VIDEO</span>` : ''}
        </div>
        ${weapon ? `<div style="margin-bottom:8px;"><span style="background:${weaponColor}22;color:${weaponColor};font-size:9px;padding:2px 7px;border-radius:2px;letter-spacing:0.1em;font-weight:600;">${esc(weapon)}</span></div>` : ''}
        <div style="font-size:8px;color:#5C5A54;letter-spacing:0.08em;margin-bottom:3px;">${isNews ? 'REPORT' : 'TARGET'}</div>
        <div style="font-size:${isNews ? '10' : '12'}px;color:#E8E6E0;${isNews ? 'line-height:1.4;' : 'font-weight:600;'}margin-bottom:8px;">${esc(p.name)||'Unknown'}</div>
        ${snippetHtml}
        <div style="display:flex;align-items:center;gap:6px;font-size:9px;margin-bottom:6px;flex-wrap:wrap;">
          <span style="color:#5C5A54;">CONF</span><span style="color:${confColor};">${esc((p.confidence||'—').toUpperCase())}</span>
          <span style="color:#3A3832;">·</span>
          <span style="color:#5C5A54;">FIRES</span><span style="color:#FF6B00;">${Number(p.fireCount)||0}</span>
          <span style="color:#3A3832;">·</span>
          <span style="color:#FF9500;">${Number(p.maxFrp)||0} MW</span>
        </div>
        ${p.latest ? (() => {
          const [d, t] = (p.latest as string).split(' ');
          const iso = t && t.length >= 4 ? `${d}T${t.slice(0,2)}:${t.slice(2,4)}:00Z` : '';
          const ms = iso ? Date.now() - new Date(iso).getTime() : NaN;
          const hh = Math.floor(ms / 3600000), mm = Math.floor((ms % 3600000) / 60000);
          const age = isNaN(ms) || ms < 0 ? esc(p.latest)
            : hh >= 24 ? `${Math.floor(hh/24)}d ${hh%24}h ago`
            : hh >= 1  ? `${hh}h ${mm}m ago`
            : `${mm}m ago`;
          return `<div style="font-size:9px;color:#5C5A54;margin-bottom:4px;">DETECTION <span style="color:#FF9500;">${age}</span></div>`;
        })() : ''}
        ${(p.lastHitTs && !p.hit) ? (() => {
          const ms2 = Date.now() - Number(p.lastHitTs);
          const hh2 = Math.floor(ms2 / 3600000), mm2 = Math.floor((ms2 % 3600000) / 60000);
          const age2 = hh2 >= 24 ? `${Math.floor(hh2/24)}d ${hh2%24}h ago` : hh2 >= 1 ? `${hh2}h ${mm2}m ago` : `${mm2}m ago`;
          return `<div style="font-size:9px;color:#FF6B00;margin-bottom:4px;">LAST HIT <span style="color:#FFB74D;">${age2}</span> · <span style="color:#888;">${esc(String(p.lastHitConf||'')).toUpperCase()} / ${p.lastHitFrp||0}MW${p.lastHitWeapon ? ' · '+esc(p.lastHitWeapon) : ''}</span></div>`;
        })() : ''}
        ${sourcesHtml}
        <div style="font-size:8px;color:#3A3832;margin-top:8px;">heuristic — verify before acting</div>
      </div>`);
    });

    // ── Territorial Captures ──
    map.on('click', 'capture-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const isConflicted = p.conflicted === true || p.conflicted === 'true';
      const sideFlag = p.side === 'ru' ? '🇷🇺' : p.side === 'ua' ? '🇺🇦' : '⚔️';
      const sideColor = isConflicted ? '#FFB300' : (p.side === 'ru' ? '#FF3D3D' : p.side === 'ua' ? '#2979FF' : '#888');
      const headerLabel = isConflicted ? '⚔️ CONFLICTED CLAIMS' : (p.side === 'ru' ? 'RU ADVANCE' : p.side === 'ua' ? 'UA ADVANCE' : 'CONTESTED');
      const otherFlag = p.other_side === 'ru' ? '🇷🇺' : p.other_side === 'ua' ? '🇺🇦' : '⚔️';
      popup(coords, `<div style="${pStyle}border:1px solid ${sideColor}40;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          <span style="font-size:14px;">${isConflicted ? '⚔️' : sideFlag}</span>
          <span style="color:${sideColor};font-size:9px;letter-spacing:0.08em;">${headerLabel}</span>
          ${p.count > 1 ? `<span style="color:#888;font-size:9px;">${Number(p.count)||0} reports</span>` : ''}
        </div>
        ${isConflicted ? `<div style="font-size:9px;color:#FFB300;background:rgba(255,179,0,0.08);border:1px solid rgba(255,179,0,0.3);border-radius:3px;padding:3px 6px;margin-bottom:6px;">⚠️ Both RU and UA claim this location</div>` : ''}
        <div style="font-size:9px;color:#888;margin-bottom:2px;">${isConflicted ? `${sideFlag} ${p.side === 'ru' ? 'RU' : p.side === 'ua' ? 'UA' : ''} CLAIM` : ''}</div>
        <div style="font-size:11px;color:#E8E6E0;margin-bottom:6px;">${esc(p.name)||'Unknown location'}</div>
        ${p.description ? `<div style="font-size:9px;color:#8A8880;line-height:1.4;margin-bottom:6px;font-style:italic;">${esc(p.description)}</div>` : ''}
        ${p.link ? `<a href="${safeUrl(p.link)}" target="_blank" style="${linkStyle}color:${sideColor};border:1px solid ${sideColor}40;background:${sideColor}11;">📡 SOURCE</a>` : ''}
        ${isConflicted && p.other_name ? `
        <div style="border-top:1px solid rgba(255,179,0,0.2);margin:8px 0 6px;"></div>
        <div style="font-size:9px;color:#888;margin-bottom:2px;">${otherFlag} ${p.other_side === 'ru' ? 'RU' : p.other_side === 'ua' ? 'UA' : ''} CLAIM</div>
        <div style="font-size:11px;color:#C8C6C0;margin-bottom:6px;">${esc(p.other_name)}</div>
        ${p.other_source ? `<div style="font-size:9px;color:#5C5A54;margin-bottom:4px;">${esc(p.other_source)}</div>` : ''}
        ${p.other_link ? `<a href="${safeUrl(p.other_link)}" target="_blank" style="${linkStyle}color:#FFB300;border:1px solid rgba(255,179,0,0.4);background:rgba(255,179,0,0.08);">📡 SOURCE</a>` : ''}
        ` : ''}
        <div style="font-size:8px;color:#444;margin-top:6px;">milblogger claim — verify before acting</div>
      </div>`);
    });

    // ── Air Raid Alerts ──
    map.on('click', 'raid-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const isDistrict = p.level === 'district';
      // p.oblast is the English parent-oblast name for both oblast and district
      // alerts (e.g. "Kyiv oblast"). WeaponThreat.oblast uses the same format.
      const oblastName = (p.oblast || p.regionName || '') as string;
      const threats = weaponThreatsRef.current.filter((t: any) =>
        typeof t.oblast === 'string' &&
        t.oblast.toLowerCase() === oblastName.toLowerCase()
      );
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,23,68,0.4);">
        <div style="color:#FF1744;font-size:13px;font-weight:700;margin-bottom:6px;">🚨 AIR RAID ALERT</div>
        <div style="font-size:11px;color:#E8E6E0;margin-bottom:2px;">${esc(p.regionName)||'Unknown region'}</div>
        <div style="font-size:9px;color:#5C5A54;margin-bottom:8px;">${isDistrict ? `${esc(p.oblast)||''} · raion-level` : 'whole oblast'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;">
          <div><span style="color:#5C5A54;">SCOPE</span><br/><span style="color:#FF1744;">${isDistrict ? 'DISTRICT' : 'OBLAST'}</span></div>
          <div><span style="color:#5C5A54;">SINCE</span><br/><span style="color:#E8E6E0;">${p.startedAt ? new Date(p.startedAt).toUTCString().slice(5,17)+' UTC' : '—'}</span></div>
        </div>
        ${threats.length > 0 ? `
        <div style="margin-top:8px;border-top:1px solid rgba(255,23,68,0.2);padding-top:6px;">
          <div style="font-size:8px;color:#5C5A54;margin-bottom:4px;letter-spacing:0.08em;">WEAPON THREATS · last 1.5h</div>
          ${threats.map((t: any) => `
            <div style="display:flex;align-items:baseline;gap:4px;margin-bottom:2px;">
              <span style="font-size:9px;color:#FF9500;font-weight:700;">${esc(t.weaponType?.toUpperCase()||'?')}</span>
              <span style="font-size:9px;color:#E8E6E0;">${esc(t.text?.slice(0,80)||'')}</span>
            </div>
          `).join('')}
        </div>` : ''}
        <a href="https://map.ukrainealarm.com" target="_blank" style="${linkStyle}color:#FF1744;border:1px solid rgba(255,23,68,0.4);background:rgba(255,23,68,0.1);">🔗 LIVE ALERT MAP</a>
      </div>`);
    });

    // ── Unified Threats — fpv / cruise / ballistic / kab / aviation / recon / uav ──
    // Selection state: clicking a feature filters the 'unified-threat-icons-selected'
    // overlay layer down to that one feature's `tid` (see layer setup above for why
    // this uses setFilter rather than feature-state — feature-state isn't valid in
    // icon-image, a layout property, and silently no-ops there). `tid` is used
    // instead of `fid` because `fid` is a fresh per-response array index —
    // a moving drone keeps a stable `tid` across polls but its `fid` shifts,
    // so fid-based selection would silently drop the highlight every poll for
    // exactly the markers most likely to be actively watched (moving ones).
    let selectedThreatTid: string | null = null;
    const clearThreatSelection = () => {
      if (selectedThreatTid != null) {
        map.setFilter('unified-threat-icons-selected', ['==', ['get', 'tid'], '']);
        selectedThreatTid = null;
      }
    };
    const showThreatDetail = (feat: maplibregl.MapGeoJSONFeature | any, coords: [number, number]) => {
      const p = feat.properties as any;
      const tid = String(p.tid ?? '');
      map.setFilter('unified-threat-icons-selected', ['==', ['get', 'tid'], tid]);
      selectedThreatTid = tid;
      const meta = THREAT_TYPE_META[p.ttype as string] ?? THREAT_TYPE_META.uav;
      const color = p.color || meta.color;
      const title = p.title || meta.label;
      const confidenceNum = Number(p.confidence) || 0;
      const band: string = p.band || (confidenceNum >= 5 ? 'high' : confidenceNum >= 3 ? 'medium' : 'low');
      const bandBadge = band === 'high'
        ? '<span style="display:inline-block;margin-top:6px;padding:3px 8px;border-radius:10px;background:rgba(255,23,68,0.85);color:#fff;font-size:9px;font-weight:700;letter-spacing:0.04em;">Достовірність: Висока</span>'
        : band === 'medium'
          ? '<span style="display:inline-block;margin-top:6px;padding:3px 8px;border-radius:10px;background:rgba(255,152,0,0.85);color:#fff;font-size:9px;font-weight:700;letter-spacing:0.04em;">Достовірність: Середня</span>'
          : '';
      const minutesAgo = p.ts ? Math.max(0, Math.round((Date.now() - new Date(p.ts).getTime()) / 60000)) : null;
      const sourcesCount = Number(p.sources) || 0;
      popup(coords, `<div style="${pStyle}border:1px solid ${color}55;max-width:300px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;background:${color}30;border:1px solid ${color}88;color:${color};font-size:11px;font-weight:700;">●</span>
            <span style="color:${color};font-size:13px;font-weight:700;">${esc(title)}</span>
          </div>
        </div>
        <div style="font-size:9px;color:#5C5A54;margin-bottom:6px;">${esc(p.place)||'—'} · ${esc(p.oblast)||'—'}</div>
        <div style="font-size:10px;color:#E8E6E0;line-height:1.4;margin-bottom:6px;border-left:2px solid ${color}66;padding-left:6px;">${esc(title)} — ${esc(p.place)||'Невідомо'}, ${esc(p.oblast)||'—'}. Підтверджень: ${confidenceNum || 1}.</div>
        ${p.approximate ? '<div style="font-size:9px;color:#FF9800;margin-bottom:4px;">⚠ Розташування приблизне</div>' : ''}
        ${bandBadge}
        <div style="font-size:8px;color:#5C5A54;margin-top:8px;">${sourcesCount || 1} дж. · ${minutesAgo != null ? `${minutesAgo} хвилин тому` : '—'}</div>
      </div>`);
    };
    const onThreatClick = (e: maplibregl.MapLayerMouseEvent) => {
      if (!e.features?.length) return;
      const coords = (e.features[0].geometry as any).coordinates as [number, number];

      // Deduplicate by tid — both icon layers may return the same feature.
      const all = map.queryRenderedFeatures(e.point, { layers: ['unified-threat-icons', 'unified-threat-icons-selected'] });
      const seen = new Set<string>();
      const unique = all.filter(f => {
        const tid = String((f.properties as any).tid ?? f.properties?.fid ?? Math.random());
        if (seen.has(tid)) return false;
        seen.add(tid);
        return true;
      });

      if (unique.length <= 1) {
        showThreatDetail(unique[0] ?? e.features[0], coords);
        return;
      }

      // Multiple threats at same location — show disambiguation list.
      const rows = unique.map((f, i) => {
        const p = f.properties as any;
        const meta = THREAT_TYPE_META[p.ttype as string] ?? THREAT_TYPE_META.uav;
        const color = p.color || meta.color;
        const title = p.title || meta.label;
        const place = p.place || p.oblast || '—';
        const mins = p.ts ? Math.max(0, Math.round((Date.now() - new Date(p.ts).getTime()) / 60000)) : null;
        return `<div data-threat-idx="${i}" style="cursor:pointer;padding:6px 8px;border-radius:6px;border:1px solid ${color}44;margin-bottom:4px;display:flex;align-items:center;gap:8px;">
          <span style="color:${color};font-size:16px;line-height:1;">●</span>
          <div style="flex:1;min-width:0;">
            <div style="color:${color};font-size:11px;font-weight:700;">${esc(title)}</div>
            <div style="color:#8A8880;font-size:9px;">${esc(place)}${mins != null ? ` · ${mins} хв тому` : ''}</div>
          </div>
        </div>`;
      }).join('');

      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,255,255,0.15);min-width:220px;max-width:300px;">
        <div style="font-size:9px;color:#5C5A54;margin-bottom:8px;letter-spacing:0.1em;">${unique.length} ЗАГРОЗ · ОБЕРІТЬ</div>
        ${rows}
      </div>`);

      // Wire list-item clicks after popup lands in DOM.
      setTimeout(() => {
        popupRef.current?.getElement()?.querySelectorAll('[data-threat-idx]').forEach(el => {
          (el as HTMLElement).style.transition = 'background 0.1s';
          el.addEventListener('mouseenter', () => { (el as HTMLElement).style.background = 'rgba(255,255,255,0.06)'; });
          el.addEventListener('mouseleave', () => { (el as HTMLElement).style.background = 'transparent'; });
          el.addEventListener('click', () => {
            const idx = Number((el as HTMLElement).dataset.threatIdx ?? 0);
            showThreatDetail(unique[idx], coords);
          });
        });
      }, 0);
    };
    // Bound on both layers — the selected overlay sits on top of the base icon
    // once a feature is selected, so re-clicking the (now larger) selected icon
    // must still hit a delegated handler and reopen its popup.
    map.on('click', 'unified-threat-icons', onThreatClick);
    map.on('click', 'unified-threat-icons-selected', onThreatClick);
    // Clear selection when clicking elsewhere (not on either threat layer).
    map.on('click', e => {
      const hit = map.queryRenderedFeatures(e.point, { layers: ['unified-threat-icons', 'unified-threat-icons-selected'] });
      if (hit.length === 0) clearThreatSelection();
    });

    // ── Alarm-Vector Arrows — inferred wave-propagation vectors ──
    map.on('click', 'alarm-vector-arrow', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,152,0,0.4);max-width:260px;">
        <div style="color:#FF9800;font-size:12px;font-weight:700;margin-bottom:4px;">⚡ INFERRED WAVE VECTOR</div>
        <div style="font-size:9px;color:#5C5A54;margin-bottom:6px;">Derived from air-raid alarm activation sequence — NOT a GPS track</div>
        <div style="font-size:9px;color:#E8E6E0;">Confidence: <span style="color:#FF9800;">${esc(p.confidence?.toUpperCase()||'—')}</span></div>
      </div>`);
    });
    map.on('mouseenter', 'alarm-vector-arrow', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'alarm-vector-arrow', () => { map.getCanvas().style.cursor = ''; });

    // ── RU Oblast Alerts (Russian border oblast drone/strike incursions) ──
    map.on('click', 'ru-raid-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const statusColor = p.status === 'all-clear' ? '#607D8B' : p.status === 'unknown' ? '#FF9800' : '#EF5350';
      const statusLabel = p.status === 'all-clear' ? '✓ ALL-CLEAR' : p.status === 'unknown' ? '? UNKNOWN' : '⚠ ACTIVE';
      const confidenceLabel = p.confidence === 'high' ? 'HIGH' : p.confidence === 'medium' ? 'MED' : 'LOW';
      popup(coords, `<div style="${pStyle}border:1px solid ${statusColor}40;max-width:300px;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          <span style="color:${statusColor};font-size:13px;font-weight:700;">🇷🇺 RU OBLAST ALERT</span>
          <span style="background:${statusColor}22;color:${statusColor};font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;">${statusLabel}</span>
        </div>
        <div style="font-size:11px;color:#E8E6E0;margin-bottom:2px;">${esc(p.oblast)||'Unknown oblast'}</div>
        <div style="font-size:9px;color:#5C5A54;margin-bottom:8px;">Border oblast drone/strike incursion · 24h window</div>
        <div style="font-size:10px;color:#C8C6C0;line-height:1.35;margin-bottom:8px;border-left:2px solid ${statusColor}66;padding-left:6px;">${esc(p.snippet)}</div>
        <div style="display:grid;grid-template-columns:${p.status === 'all-clear' && p.cleared_at ? '1fr 1fr 1fr' : '1fr 1fr'};gap:4px;font-size:9px;">
          <div><span style="color:#5C5A54;">ALERTED</span><br/><span style="color:#E8E6E0;">${p.started_at ? new Date(p.started_at).toUTCString().slice(5,17)+' UTC' : '—'}</span></div>
          ${p.status === 'all-clear' && p.cleared_at ? `<div><span style="color:#5C5A54;">CLEARED</span><br/><span style="color:#607D8B;">${new Date(p.cleared_at).toUTCString().slice(5,17)+' UTC'}</span></div>` : ''}
          <div><span style="color:#5C5A54;">CONFIDENCE</span><br/><span style="color:#E8E6E0;">${confidenceLabel} (${Number(p.channel_count)||1} ch)</span></div>
        </div>
        <div><span style="color:#5C5A54;font-size:9px;">SOURCE</span><br/><span style="color:#E8E6E0;font-size:8px;">${esc(p.source)||'—'}</span></div>
        <div style="font-size:8px;color:#5C5A54;margin-top:8px;font-style:italic;">Heuristic text signal — verify before acting.</div>
      </div>`);
    });

    // ── Power Outages ──
    map.on('click', 'outage-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const typeColor = p.type === 'emergency' ? '#FF6B00' : '#FFD500';
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,213,0,0.3);">
        <div style="color:${typeColor};font-size:13px;font-weight:700;margin-bottom:6px;">⚡ POWER OUTAGE</div>
        <div style="font-size:10px;color:#E8E6E0;margin-bottom:8px;">${esc(p.regionName)||'Unknown region'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;">
          <div><span style="color:#5C5A54;">TYPE</span><br/><span style="color:${typeColor};">${esc((p.type||'unknown').toUpperCase())}</span></div>
          <div><span style="color:#5C5A54;">SEVERITY</span><br/><span style="color:#E8E6E0;">${esc((p.severity||'—').toUpperCase())}</span></div>
          <div><span style="color:#5C5A54;">SCHEDULE</span><br/><span style="color:#E8E6E0;">${esc(p.schedule)||'—'}</span></div>
          <div><span style="color:#5C5A54;">SOURCE</span><br/><span style="color:#E8E6E0;">${esc(p.source)||'—'}</span></div>
        </div>
        <a href="https://ua.energy" target="_blank" style="${linkStyle}color:#FFD500;border:1px solid rgba(255,213,0,0.4);background:rgba(255,213,0,0.1);">🔗 UKRENERGO</a>
      </div>`);
    });

    // ── Malware Threats (Abuse.ch) ──
    map.on('click', 'malware-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,23,68,0.3);">
        <div style="color:#FF1744;font-size:14px;font-weight:700;margin-bottom:4px;">MALWARE / BOTNET</div>
        <div style="font-size:9px;color:#E8E6E0;margin-bottom:8px;">${esc(p.malware || p.threat_type)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;">
          <div><span style="color:#5C5A54;">TARGET IP</span><br/><span style="color:#E8E6E0;">${esc(p.ip)}</span></div>
          <div><span style="color:#5C5A54;">STATUS</span><br/><span style="color:#E8E6E0;">${esc(p.status)}</span></div>
        </div>
        <a href="https://feodotracker.abuse.ch/browse/" target="_blank" style="${linkStyle}color:#FF1744;border:1px solid rgba(255,23,68,0.4);background:rgba(255,23,68,0.1);">[?] ABUSE.CH INTELLIGENCE</a>
        <button onclick="window.openOsirisIntel({ type: 'ip', ip: '${jsAttr(p.ip)}', threat_type: '${jsAttr(p.malware || p.threat_type || '')}', status: '${jsAttr(p.status || '')}' })" style="width:100%;margin-top:6px;padding:6px 12px;background:rgba(255,109,0,0.15);border:1px solid rgba(255,109,0,0.5);color:#FF6D00;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:bold;letter-spacing:0.1em;border-radius:4px;cursor:pointer;">[ IP INTEL DEEP DIVE ]</button>
      </div>`);
    });

    // ── Internet Outages (IODA) ──
    map.on('click', 'ioda-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid rgba(0,229,255,0.3);">
        <div style="color:#00E5FF;font-size:14px;font-weight:700;margin-bottom:4px;">INTERNET OUTAGE <span style="font-size:9px;color:#76FF03;background:rgba(118,255,3,0.15);padding:1px 4px;border-radius:2px;">LIVE</span></div>
        <div style="font-size:9px;color:#E8E6E0;margin-bottom:8px;">${esc(p.countryName || p.country)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;">
          <div><span style="color:#5C5A54;">SEVERITY</span><br/><span style="color:#E8E6E0;">${esc(p.level)}</span></div>
          <div><span style="color:#5C5A54;">SCORE</span><br/><span style="color:#E8E6E0;">${Number(p.score).toLocaleString()}</span></div>
          <div style="grid-column:1/-1"><span style="color:#5C5A54;">SIGNALS</span><br/><span style="color:#E8E6E0;">${esc(p.datasource || '?')}</span></div>
        </div>
        <a href="https://ioda.inetintel.cc.gatech.edu/" target="_blank" style="${linkStyle}color:#00E5FF;border:1px solid rgba(0,229,255,0.4);background:rgba(0,229,255,0.1);">[?] IODA GEORGIA TECH</a>
        <button onclick="window.openOsirisIntel({ type: 'country', country: '${jsAttr(p.country)}' })" style="width:100%;margin-top:6px;padding:6px 12px;background:rgba(118,255,3,0.15);border:1px solid rgba(118,255,3,0.5);color:#76FF03;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:bold;letter-spacing:0.1em;border-radius:4px;cursor:pointer;">[ COUNTRY INTEL ]</button>
      </div>`);
    });

    // ── GDELT / Conflict Events (with confidence tier + sources) ──
    map.on('click', 'gdelt-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const evtTime = p.published ? new Date(p.published) : null;
      const evtAgo = evtTime ? Math.max(0, Math.round((Date.now() - evtTime.getTime()) / 60000)) : null;
      const evtLabel = evtAgo == null ? '' : evtAgo < 60 ? `${evtAgo}m ago` : `${Math.round(evtAgo/60)}h ago`;

      const confidence: string = p.confidence ?? 'reported';
      const confidenceColor = confidence === 'confirmed' ? '#FF3D3D' : confidence === 'reported' ? '#FF9500' : '#FFD54F';
      const confidenceSymbol = confidence === 'confirmed' ? '●' : confidence === 'reported' ? '◎' : '○';
      const confidenceLabel = `${confidenceSymbol} ${confidence.toUpperCase()}`;

      const sourcesRaw: string = p.sources ?? '';
      const sourcesDisplay = sourcesRaw
        ? sourcesRaw.split(',').map((s: string) => s.trim().toUpperCase()).join(' · ')
        : 'GDELT';

      popup(coords, `<div style="${pStyle}border:1px solid ${confidenceColor}40;">
        <div style="color:${confidenceColor};font-size:12px;font-weight:700;margin-bottom:4px;">CONFLICT EVENT</div>
        <div style="font-size:9px;color:${confidenceColor};font-weight:700;margin-bottom:6px;letter-spacing:0.08em;">${esc(confidenceLabel)}</div>
        <div style="font-size:9px;color:#E8E6E0;margin-bottom:6px;line-height:1.4;">${esc(p.name)||'Unclassified incident'}</div>
        ${evtTime ? `<div style="font-size:9px;color:#5C5A54;margin-bottom:4px;">${evtTime.toUTCString().slice(5,22)} UTC · ${evtLabel}</div>` : ''}
        <div style="font-size:9px;color:#5C5A54;margin-bottom:8px;">Sources: ${esc(sourcesDisplay)}</div>
        <div style="display:flex;gap:6px;">
          ${p.url ? `<a href="${safeUrl(p.url)}" target="_blank" style="${linkStyle}color:${confidenceColor};border:1px solid ${confidenceColor}60;background:${confidenceColor}18;">SOURCE</a>` : ''}
          <a href="https://www.google.com/maps/@${coords[1]},${coords[0]},12z" target="_blank" style="${linkStyle}color:#448AFF;border:1px solid rgba(68,138,255,0.4);background:rgba(68,138,255,0.1);">MAP</a>
        </div>
      </div>`);
    });

    // ── SIGINT RSS news dots ──
    map.on('click', 'sigint-news-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const pubTime = p.published ? new Date(p.published) : null;
      const agoMs = pubTime ? Date.now() - pubTime.getTime() : null;
      const agoLabel = agoMs == null ? '' : agoMs < 3_600_000 ? `${Math.round(agoMs / 60000)}m ago` : `${Math.round(agoMs / 3_600_000)}h ago`;
      const riskScore: number = Number(p.risk_score) || 0;
      const riskColor = riskScore >= 70 ? '#FF3D3D' : riskScore >= 40 ? '#FF9500' : '#D4AF37';
      popup(coords, `<div style="${pStyle}border:1px solid ${riskColor}40;max-width:380px;">
        <div style="color:${riskColor};font-size:11px;font-weight:700;letter-spacing:0.08em;margin-bottom:6px;">SIGINT · ${esc(p.source||'INTEL')}</div>
        <div style="font-size:10px;color:#E8E6E0;line-height:1.5;margin-bottom:6px;">${esc(p.title||'Intelligence item')}</div>
        ${pubTime ? `<div style="font-size:9px;color:#5C5A54;margin-bottom:8px;">${pubTime.toUTCString().slice(5,22)} UTC · ${agoLabel}</div>` : ''}
        ${riskScore > 0 ? `<div style="font-size:9px;color:${riskColor};margin-bottom:8px;">RISK: ${riskScore}/100</div>` : ''}
        ${p.link ? `<a href="${safeUrl(p.link)}" target="_blank" style="${linkStyle}color:${riskColor};border:1px solid ${riskColor}60;background:${riskColor}18;">READ SOURCE</a>` : ''}
      </div>`);
    });

    // ── Global Event / Conflict Markers ──
    map.on('click', 'conflict-icons', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const color = p.severity === 'war' ? '#FF1744' : p.severity === 'high' ? '#FF9500' : '#FFD500';
      popup(coords, `<div style="${pStyle}border:1px solid ${color}40;">
        <div style="color:${color};font-size:12px;font-weight:700;margin-bottom:6px;">⚠️ ${esc(p.label) || 'WARNING EVENT'}</div>
        <div style="font-size:10px;color:#E8E6E0;margin-bottom:8px;line-height:1.4;">${esc(p.description) || 'Global event detected at this location.'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">SEVERITY</span><br/><span style="color:${color};">${(p.severity||'unknown').toUpperCase()}</span></div>
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(3)}°, ${coords[0].toFixed(3)}°</span></div>
        </div>
      </div>`);
    });


    // ── OSIRIS SDK link click ──
    const SDK_SOURCE_URLS: Record<string, string> = {
      'AIS Maritime': 'https://www.marinetraffic.com',
      'AIS Stream': 'https://aisstream.io',
      'AIS → Lattice': 'https://aisstream.io',
      'ADS-B / OpenSky': 'https://opensky-network.org',
      'ADS-B → Lattice': 'https://opensky-network.org',
      'Naval Intelligence': 'https://www.odni.gov',
    };
    ['sdk-sea','sdk-sea-glow','sdk-air','sdk-air-glow','sdk-intel','sdk-intel-glow'].forEach(layer => {
      map.on('click', layer, e => {
        if (!e.features?.length) return;
        const p = e.features[0].properties as any;
        const coords = e.lngLat;
        const srcUrl = safeUrl(p.url || SDK_SOURCE_URLS[p.source] || 'https://osirisai.live');
        const domainLabel = p.domain === 'SEA' ? '⚓ MARITIME' : p.domain === 'AIR' ? '✈ AIR CORRIDOR' : '🛡 NAVAL INTEL';
        const domainColor = p.domain === 'SEA' ? '#4FC3F7' : p.domain === 'AIR' ? '#B3E5FC' : '#81D4FA';
        const linkStyle = 'text-decoration:none;padding:3px 8px;border-radius:4px;font-size:9px;font-weight:700;letter-spacing:0.05em;';
        popup([coords.lng, coords.lat], `<div style="${pStyle}border:1px solid ${domainColor}40;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
            <div style="width:8px;height:8px;border-radius:50%;background:${domainColor};box-shadow:0 0 8px ${domainColor};"></div>
            <span style="color:${domainColor};font-size:11px;font-weight:700;letter-spacing:0.1em;">${domainLabel}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:9px;margin-bottom:8px;">
            <div><span style="color:#5C5A54;">FROM</span><br/><span style="color:#E8E6E0;">${esc(p.fromName) || 'Origin'}</span></div>
            <div><span style="color:#5C5A54;">TO</span><br/><span style="color:#E8E6E0;">${esc(p.toName) || 'Destination'}</span></div>
            <div><span style="color:#5C5A54;">DOMAIN</span><br/><span style="color:${domainColor};">${esc(p.domain)}</span></div>
            <div><span style="color:#5C5A54;">SOURCE</span><br/><a href="${srcUrl}" target="_blank" style="color:${domainColor};text-decoration:underline;cursor:pointer;">${esc(p.source) || 'OSIRIS'}</a></div>
          </div>
          <a href="${srcUrl}" target="_blank" style="${linkStyle}color:${domainColor};border:1px solid ${domainColor}40;background:${domainColor}18;display:inline-block;margin-top:4px;">OPEN SOURCE ↗</a>
        </div>`);
      });
    });

    // ── Railway Strike Incidents popup ──
    map.on('click', 'rail-strike-dots', e => {
      if (!e.features?.length) return;
      const p      = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const date   = p.pubDate ? new Date(p.pubDate).toUTCString().replace('GMT', 'Z') : '—';
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,87,34,0.4);">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,87,34,0.3);padding-bottom:6px;margin-bottom:8px;">
          <div style="color:#FF5722;font-size:12px;font-weight:700;letter-spacing:0.08em;">🚆 RAIL INFRASTRUCTURE REPORT</div>
          <div style="color:#FF5722;font-size:8px;border:1px solid rgba(255,87,34,0.4);border-radius:3px;padding:1px 5px;">UNVERIFIED</div>
        </div>
        <div style="font-size:10px;color:#E8E6E0;line-height:1.5;margin-bottom:8px;">${esc((p.text || '').slice(0, 150))}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">REGION</span><br/><span style="color:#FF5722;">${esc(p.oblast || '—')}</span></div>
          <div><span style="color:#5C5A54;">SOURCE</span><br/><span style="color:#E8E6E0;">t.me/${esc(p.source || '—')}</span></div>
          <div style="grid-column:1/-1;"><span style="color:#5C5A54;">REPORTED</span><br/><span style="color:#E8E6E0;">${esc(date)}</span></div>
        </div>
        <div style="font-size:8px;color:#FF5722;border:1px solid rgba(255,87,34,0.25);border-radius:4px;padding:5px 8px;line-height:1.4;">
          ⚠ telegram-only / unverified &nbsp;·&nbsp; oblast-level precision — not an exact station location.
        </div>
      </div>`);
    });

    // ── Generic hover for clickables ──
    ['conflict-icons','cctv-dots','eq-circles','sat-dots','fires-heat','gdelt-dots','weather-dots','infra-dots','maritime-dots','choke-dots','news-dots','sigint-news-dots','balloon-dots','rad-dots','ship-dots','ship-shadow-dots','sweep-device-dots','scan-targets-dots','sdk-sea','sdk-sea-glow','sdk-sea-atmo','sdk-air','sdk-air-glow','sdk-air-atmo','sdk-intel','sdk-intel-glow','sdk-intel-atmo','raid-dots','outage-dots','unified-threat-icons','unified-threat-icons-selected','ru-raid-dots','malware-dots','ioda-dots','rail-strike-dots'].forEach(layer => {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    });

    // ── Scan Targets click ──
    map.on('click', 'scan-targets-dots', (e: any) => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const coords = e.features[0].geometry.coordinates.slice();
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,61,61,0.5);">
        <div style="color:#FF3D3D;font-size:12px;font-weight:700;margin-bottom:6px;">🎯 TARGET: ${esc(p.id)}</div>
        <div style="font-size:9px;color:#E8E6E0;margin-bottom:8px;">${esc(p.city) || 'Unknown'}, ${esc(p.country) || 'Unknown'} — ${esc(p.isp) || 'Unknown ISP'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;">
          <div><span style="color:#5C5A54;">TYPE</span><br/><span style="color:#00E5FF;">${esc((p.type || 'UNKNOWN').toUpperCase())}</span></div>
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(3)}°, ${coords[0].toFixed(3)}°</span></div>
        </div>
        <button onclick="window.openOsirisIntel({ type: 'ip', ip: '${jsAttr(p.id)}' })" style="width:100%;margin-top:8px;padding:6px 12px;background:rgba(255,109,0,0.15);border:1px solid rgba(255,109,0,0.5);color:#FF6D00;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:bold;letter-spacing:0.1em;border-radius:4px;cursor:pointer;">[ IP INTEL DEEP DIVE ]</button>
      </div>`);
    });

    // ── SCM Suppliers ──
    map.on('click', 'scm-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const color = p.risk_level === 'CRITICAL' ? '#FF1744' : p.risk_level === 'HIGH' ? '#FF9500' : '#00BCD4';
      const activeThreats = p.active_threats ? JSON.parse(p.active_threats) : [];
      
      let threatsHtml = '';
      if (activeThreats.length > 0) {
        threatsHtml = `<div style="margin-top:8px;padding-top:6px;border-top:1px solid ${color}40;color:${color};font-size:9px;font-weight:bold;">
          ACTIVE THREATS:<br/>${activeThreats.map((t: string) => `⚠ ${esc(t)}`).join('<br/>')}
        </div>`;
      }

      popup(coords, `<div style="${pStyle}border:1px solid ${color}40;">
        <div style="color:${color};font-size:12px;font-weight:700;margin-bottom:4px;">🏢 ${esc(p.name)}</div>
        <div style="font-size:9px;color:#aaa;margin-bottom:8px;">${esc(p.category)} | ${esc(p.city)}, ${esc(p.country)}</div>
        <div style="display:grid;grid-template-columns:1fr;gap:4px;font-size:11px;">
          <div><span style="color:#5C5A54;font-size:9px;">SCM RISK LEVEL</span><br/><span style="color:${color};font-weight:bold;">${esc(p.risk_level)}</span></div>
        </div>
        ${threatsHtml}
      </div>`);
    });

    // ── IP Sweep device click ──
    map.on('click', 'sweep-device-dots', (e: any) => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const coords = e.features[0].geometry.coordinates.slice();
      const ports = JSON.parse(p.ports || '[]');
      const vulns = JSON.parse(p.vulns || '[]');
      const hostnames = JSON.parse(p.hostnames || '[]');
      const riskColors: Record<string, string> = { CRITICAL: '#FF3D3D', HIGH: '#FF6B00', MEDIUM: '#FFD700', LOW: '#76FF03', INFO: '#5C5A54' };
      popup(coords, `<div style="font-family:monospace;font-size:11px;color:#E8E6E0;">
        <div style="font-size:13px;font-weight:bold;margin-bottom:6px;color:${esc(p.color)};">${esc(p.device_type)}</div>
        <div style="font-size:12px;margin-bottom:8px;color:#fff;">${esc(p.ip)}</div>
        ${hostnames.length > 0 ? `<div style="font-size:9px;color:#8A8880;margin-bottom:6px;">${hostnames.map(esc).join(', ')}</div>` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">PORTS</span><br/><span style="color:#E8E6E0;">${ports.length}</span></div>
          <div><span style="color:#5C5A54;">RISK</span><br/><span style="color:${riskColors[p.risk_level] || '#666'};">${esc(p.risk_level)}</span></div>
        </div>
        <div style="font-size:9px;color:#8A8880;margin-bottom:6px;">Open: ${ports.slice(0, 12).map(esc).join(', ')}${ports.length > 12 ? ' ...' : ''}</div>
        ${vulns.length > 0 ? `<div style="font-size:9px;color:#FF3D3D;margin-bottom:6px;">⚠ CVEs: ${vulns.slice(0, 5).map(esc).join(', ')}${vulns.length > 5 ? ` +${vulns.length - 5} more` : ''}</div>` : ''}
        <button onclick="window.openOsirisIntel({ type: 'ip', ip: '${jsAttr(p.ip)}' })" style="width:100%;margin-top:6px;padding:6px 12px;background:rgba(255,109,0,0.15);border:1px solid rgba(255,109,0,0.5);color:#FF6D00;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:bold;letter-spacing:0.1em;border-radius:4px;cursor:pointer;">[ IP INTEL DEEP DIVE ]</button>
      </div>`);
    });

    // ── Balloons / Sondes ──
    map.on('click', 'balloon-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid ${esc(p.color)}40;">
        <div style="color:${esc(p.color)};font-size:12px;font-weight:700;letter-spacing:0.1em;margin-bottom:4px;">🎈 ${esc(p.callsign)}</div>
        <div style="font-size:9px;color:#aaa;margin-bottom:8px;">${esc(String(p.type||'').toUpperCase())} / STATUS: ${esc(String(p.status||'').toUpperCase())}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;">
          <div><span style="color:#5C5A54;">ALTITUDE</span><br/><span style="color:#E8E6E0;">${esc(p.altitude)} m</span></div>
          <div><span style="color:#5C5A54;">SPEED</span><br/><span style="color:#E8E6E0;">${Math.round(p.speed)} km/h</span></div>
          <div><span style="color:#5C5A54;">VERT RATE</span><br/><span style="color:${p.verticalRate > 0 ? '#00E676' : '#FF3D3D'};">${Number(p.verticalRate).toFixed(1)} m/s</span></div>
          <div><span style="color:#5C5A54;">TEMP</span><br/><span style="color:#E8E6E0;">${esc(p.temperature)}°C</span></div>
        </div>
      </div>`);
    });

    // ── Radiation ──
    map.on('click', 'rad-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const color = p.status === 'DANGER' ? '#FF1744' : p.status === 'WARNING' ? '#FF9500' : '#AB47BC';
      popup(coords, `<div style="${pStyle}border:1px solid ${color}40;">
        <div style="color:${color};font-size:12px;font-weight:700;margin-bottom:4px;">☢️ ${esc(p.name)}</div>
        <div style="font-size:9px;color:#aaa;margin-bottom:8px;">${esc(p.city)}, ${esc(p.country)}</div>
        <div style="display:grid;grid-template-columns:1fr;gap:4px;font-size:11px;">
          <div><span style="color:#5C5A54;font-size:9px;">READING</span><br/><span style="color:${color};font-weight:bold;">${esc(p.reading)} nSv/h</span></div>
          <div><span style="color:#5C5A54;font-size:9px;">STATUS</span><br/><span style="color:${color};">${esc(p.status)}</span></div>
          <div><span style="color:#5C5A54;font-size:9px;">NETWORK</span><br/><span style="color:#E8E6E0;">${esc(p.network)}</span></div>
        </div>
      </div>`);
    });

    // ── Maritime Ships ──
    ['ship-dots','ship-shadow-dots'].forEach(shipLayer => map.on('click', shipLayer, e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const isShadow = p.shadow_fleet === true || p.shadow_fleet === 'true';
      const isStale = p.stale === true || p.stale === 'true';
      const shipType = (p.type || 'cargo').toString();
      const color = isShadow ? '#E040FB' : shipType === 'military' ? '#FF1744' : shipType === 'tanker' ? '#FF9500' : '#00BCD4';
      const flagStr = p.flag_emoji ? `${esc(p.flag_emoji)} ${esc(p.flag || '')}`.trim() : esc(p.flag || '—');

      // Dead-reckoning block for stale shadow vessels
      let drHtml = '';
      if (isShadow && isStale) {
        const elapsedHours = (Number(p.minutes_since_update) || 0) / 60;
        const blackoutTotalMin = Number(p.minutes_since_update) || 0;
        const blackoutH = Math.floor(blackoutTotalMin / 60);
        const blackoutM = Math.round(blackoutTotalMin % 60);
        const blackoutStr = blackoutH > 0 ? `${blackoutH}h ${blackoutM}m` : `${blackoutM}m`;

        const rawHeading = Number(p.heading);
        const headingValid = Number.isFinite(rawHeading) && rawHeading !== 511 && rawHeading >= 0 && rawHeading < 360;
        const rawSpeed = Number(p.speed);
        const speed = rawSpeed > 0.1 ? rawSpeed : 8;

        // Feature coords are [lng, lat]
        const shipLat = coords[1];
        const shipLng = coords[0];

        if (elapsedHours > 0.17 && elapsedHours <= 6 && headingValid) {
          const drPos = deadReckon(shipLat, shipLng, rawHeading, speed, elapsedHours);
          if (drPos) {
            const [drLat, drLng] = drPos;
            drHtml = `<div style="background:rgba(224,64,251,0.08);border:1px solid rgba(224,64,251,0.3);border-radius:3px;padding:5px 6px;margin-top:5px;font-size:9px;color:#E040FB;">
              DR EST · projected ~${drLat.toFixed(3)}°, ${drLng.toFixed(3)}° · blackout ${blackoutStr} · estimate only
            </div>`;
          }
        } else if (elapsedHours > 0.17 && elapsedHours <= 6) {
          // Heading unknown — show uncertainty ring exists but no position
          drHtml = `<div style="background:rgba(224,64,251,0.08);border:1px solid rgba(224,64,251,0.3);border-radius:3px;padding:5px 6px;margin-top:5px;font-size:9px;color:#E040FB;">
            DR EST · heading unknown — uncertainty ring only · blackout ${blackoutStr} · estimate only
          </div>`;
        }
      }

      popup(coords, `<div style="${pStyle}border:1px solid ${color}40;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px;">
          <span style="color:${color};font-size:12px;font-weight:700;letter-spacing:0.1em;">🚢 ${esc(p.name)}</span>
          <span style="color:#aaa;font-size:11px;white-space:nowrap;">${flagStr}</span>
        </div>
        ${isShadow ? `<div style="color:#E040FB;font-size:9px;font-weight:700;margin-bottom:4px;">⚠ SHADOW FLEET — sanctioned / dark vessel</div>${isStale ? `<div style="color:#FF9500;font-size:9px;margin-bottom:6px;">📡 AIS-DARK · Last seen: <span style="color:#E8E6E0;">${p.last_position_at ? new Date(p.last_position_at).toUTCString().slice(5,22)+' UTC' : p.minutes_since_update+'m ago'}</span></div>` : ''}` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;">
          <div><span style="color:#5C5A54;">FLAG</span><br/><span style="color:#E8E6E0;">${flagStr}</span></div>
          <div><span style="color:#5C5A54;">TYPE</span><br/><span style="color:${color};">${esc(shipType.toUpperCase())}</span></div>
          <div><span style="color:#5C5A54;">SPEED</span><br/><span style="color:#E8E6E0;">${esc(p.speed)} knots</span></div>
          <div><span style="color:#5C5A54;">HEADING</span><br/><span style="color:#E8E6E0;">${esc(p.heading)}°</span></div>
          <div><span style="color:#5C5A54;">DEST</span><br/><span style="color:#E8E6E0;">${esc(p.destination) || 'UNKNOWN'}</span></div>
        </div>
        ${drHtml}
        <button onclick="window.openOsirisIntel({ type: 'vessel', name: '${jsAttr(p.name)}', imo: '${jsAttr(p.imo||'')}', mmsi: '${jsAttr(p.mmsi||'')}', flag: '${jsAttr(p.flag||'')}', speed: ${Number(p.speed)||0}, destination: '${jsAttr(p.destination||'')}' })" style="width:100%;margin-top:8px;padding:6px 12px;background:${color}30;border:1px solid ${color}80;color:${color};font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:bold;letter-spacing:0.1em;border-radius:4px;cursor:pointer;">[ VESSEL INTEL ]</button>
      </div>`);
    }));

    // ── Oblast Pressure Index — choropleth click ──
    map.on('click', 'pressure-oblast-fill', (e) => {
      const feat = e.features?.[0];
      if (!feat) return;
      const nameEn = feat.properties?.name_en as string;
      const scores: any[] = (dataRef.current?.oblast_pressure as any[]) ?? [];
      const score = scores.find((o: any) => o.name_en === nameEn);
      if (!score) return;
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      const levelColors: Record<string, string> = {
        critical: 'rgba(255,23,68,0.8)', high: 'rgba(255,107,0,0.8)',
        med: 'rgba(255,193,7,0.8)', low: 'rgba(100,181,246,0.6)',
      };
      const contribs: Array<{ signal: string; label: string; url?: string; ts: string }> =
        Array.isArray(score.contributors) ? score.contributors : [];
      const sourcesHtml = contribs.length > 0
        ? `<details style="margin-top:8px;"><summary style="cursor:pointer;color:#64B5F6;font-size:10px;list-style:none;-webkit-appearance:none;user-select:none;">Sources (${contribs.length}) &#9658;</summary><div style="margin-top:5px;">${contribs.map((c) => {
            const sigLabel = c.signal === 'air_raid' ? 'Air Raid' : 'KAB';
            const ts = new Date(c.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            const lbl = c.url
              ? `<a href="${safeUrl(c.url)}" target="_blank" style="color:#64B5F6;text-decoration:none;">${esc(c.label)}</a>`
              : `<span style="color:#aaa">${esc(c.label)}</span>`;
            return `<div style="font-size:9px;color:#888;margin-bottom:3px;line-height:1.4;">${esc(sigLabel)} &middot; ${lbl} &middot; ${ts}</div>`;
          }).join('')}</div></details>`
        : '';
      popup(e.lngLat, `<div style="${pStyle}border:1px solid ${levelColors[score.level] ?? 'rgba(255,255,255,0.3)'};max-width:280px;">
        <div style="font-weight:700;margin-bottom:4px">${esc(nameEn)}</div>
        <div>Pressure: <b>${Math.round(score.score)}</b> <span style="color:#aaa">(${esc(score.level.toUpperCase())})</span></div>
        <div style="margin-top:6px;color:#aaa;font-size:10px">
          Ballistic ${pct(score.components.ballistic)} &middot;
          KAB ${pct(score.components.kab)} &middot;
          Frontline ${pct(score.components.frontline)} &middot;
          Outage ${pct(score.components.outage)}
        </div>
        ${sourcesHtml}
      </div>`);
    });
    map.on('mouseenter', 'pressure-oblast-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'pressure-oblast-fill', () => { map.getCanvas().style.cursor = ''; });

    // ── Shadow Fleet Track Lines — click for vessel info ──
    map.on('click', 'shadow-track-line', (e) => {
      const feat = e.features?.[0];
      if (!feat) return;
      const props = feat.properties as { mmsi: number; name: string; ageHours: number };
      const allTracks: any[] = (dataRef.current?.shadow_fleet_tracks as any[]) ?? [];
      const vessel = allTracks.find((v: any) => v.mmsi === props.mmsi);
      const posCount = vessel?.positions?.length ?? '?';
      new maplibregl.Popup({ className: 'osiris-popup', maxWidth: '260px' })
        .setLngLat(e.lngLat)
        .setHTML(`<div style="font-size:11px;line-height:1.6;border-left:3px solid #E040FB;padding-left:8px">
          <div style="font-weight:700;color:#E040FB">${esc(props.name ?? 'Unknown')}</div>
          <div>MMSI: <b>${esc(String(props.mmsi))}</b></div>
          <div>Track: <b>${posCount} positions</b> &middot; last 24h</div>
          <div style="color:#aaa;margin-top:2px;font-size:10px">Shadow fleet vessel</div>
        </div>`)
        .addTo(map);
    });
    map.on('mouseenter', 'shadow-track-line', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'shadow-track-line', () => { map.getCanvas().style.cursor = ''; });

    // ── Weather Events (NASA EONET) ──
    map.on('click', 'weather-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const iconEmoji = p.icon === 'cyclone' ? '🌀' : p.icon === 'volcano' ? '🌋' : '⚡';
      popup(coords, `<div style="${pStyle}border:1px solid rgba(224,64,251,0.3);">
        <div style="color:#E040FB;font-size:14px;font-weight:700;margin-bottom:6px;">${iconEmoji} ${esc(p.type) || 'Weather Event'}</div>
        <div style="font-size:10px;color:#E8E6E0;margin-bottom:8px;line-height:1.4;">${esc(p.title) || 'Unknown event'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">SEVERITY</span><br/><span style="color:${p.severity === 'high' ? '#FF1744' : '#FFD700'};">${esc((p.severity||'low').toUpperCase())}</span></div>
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(3)}°, ${coords[0].toFixed(3)}°</span></div>
        </div>
        <div style="display:flex;gap:6px;">
          ${p.source ? `<a href="${safeUrl(p.source)}" target="_blank" style="${linkStyle}color:#E040FB;border:1px solid rgba(224,64,251,0.4);background:rgba(224,64,251,0.1);">📡 SOURCE</a>` : ''}
          <a href="https://eonet.gsfc.nasa.gov/api/v3/events/${encodeURIComponent(p.id || '')}" target="_blank" style="${linkStyle}color:#D4AF37;border:1px solid rgba(212,175,55,0.4);background:rgba(212,175,55,0.1);">🛰️ NASA EONET</a>
        </div>
      </div>`);
    });

    // ── Nuclear Infrastructure ──
    map.on('click', 'infra-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const statusColor = p.status.includes('SEISMIC RISK') ? '#FF9500' : p.status === 'Active Conflict Zone' ? '#FF1744' : p.status === 'Operational' ? '#76FF03' : '#757575';
      popup(coords, `<div style="${pStyle}border:1px solid rgba(118,255,3,0.3);">
        <div style="color:#76FF03;font-size:14px;font-weight:700;margin-bottom:4px;">☢️ ${esc(p.name) || 'Nuclear Facility'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:9px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">STATUS</span><br/><span style="color:${statusColor};">${esc(p.status) || '—'}</span></div>
          <div><span style="color:#5C5A54;">CITY</span><br/><span style="color:#E8E6E0;">${esc(p.city) || '—'}, ${esc(p.country) || ''}</span></div>
          <div><span style="color:#5C5A54;">REACTORS</span><br/><span style="color:#76FF03;">${esc(p.reactors) || '—'}</span></div>
          <div><span style="color:#5C5A54;">CAPACITY</span><br/><span style="color:#E8E6E0;">${p.capacityMW ? Number(p.capacityMW).toLocaleString() + ' MW' : '—'}</span></div>
          <div><span style="color:#5C5A54;">OWNER</span><br/><span style="color:#E8E6E0;">${esc(p.owner) || '—'}</span></div>
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(3)}°, ${coords[0].toFixed(3)}°</span></div>
        </div>
        <a href="https://www.google.com/maps/@${coords[1]},${coords[0]},14z/data=!3m1!1e3" target="_blank" style="${linkStyle}color:#76FF03;border:1px solid rgba(118,255,3,0.4);background:rgba(118,255,3,0.1);">SATELLITE VIEW</a>
      </div>`);
    });

    // ── Maritime Ports & Naval Bases ──
    map.on('click', 'maritime-dots', e => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const coords = (e.features![0].geometry as any).coordinates;
      const typeColor = p.type === 'naval' ? '#FF3D3D' : p.type === 'energy' ? '#FF9500' : '#00BCD4';
      const typeLabel = p.type === 'naval' ? 'NAVAL BASE' : p.type === 'energy' ? 'ENERGY PORT' : 'CONTAINER PORT';
      
      const congestionHtml = p.congestion ? `
        <div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.1);">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
            <div><span style="color:#5C5A54;font-size:9px;">CONGESTION</span><br/><span style="color:${p.congestion === 'SEVERE' ? '#FF1744' : p.congestion === 'CONGESTED' ? '#FF9500' : '#00E676'};font-weight:bold;font-size:10px;">${esc(p.congestion)}</span></div>
            <div><span style="color:#5C5A54;font-size:9px;">EST. DWELL TIME</span><br/><span style="color:#E8E6E0;font-weight:bold;font-size:10px;">${esc(p.dwell_time) || 'Unknown'}</span></div>
          </div>
        </div>` : '';

      popup(coords, `<div style="${pStyle}border:1px solid ${typeColor}40;">
        <div style="color:${typeColor};font-weight:bold;font-size:11px;margin-bottom:4px;">${esc(p.name)}</div>
        <div style="color:#999;font-size:9px;margin-bottom:6px;">${typeLabel} — ${esc(p.country)}</div>
        ${p.volume ? `<div style="font-size:9px;color:#aaa;">Volume: <span style="color:${typeColor};font-weight:bold;">${esc(p.volume)}</span></div>` : ''}
        ${p.fleet ? `<div style="font-size:9px;color:#aaa;">Fleet: <span style="color:${typeColor};font-weight:bold;">${esc(p.fleet)}</span></div>` : ''}
        ${p.rank ? `<div style="font-size:9px;color:#aaa;">Global Rank: <span style="color:${typeColor};font-weight:bold;">#${esc(p.rank)}</span></div>` : ''}
        ${congestionHtml}
      </div>`);
    });

    // ── Maritime Chokepoints ──
    map.on('click', 'choke-dots', e => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const coords = (e.features![0].geometry as any).coordinates;
      const riskCol = p.risk === 'CRITICAL' ? '#FF1744' : p.risk === 'HIGH' ? '#FF9500' : p.risk === 'ELEVATED' ? '#FFD700' : '#00E676';
      popup(coords, `<div style="${pStyle}border:1px solid ${riskCol}40;">
        <div style="color:#FF9500;font-weight:bold;font-size:11px;margin-bottom:4px;">${esc(p.name)}</div>
        <div style="font-size:9px;color:#aaa;">Traffic: <span style="color:#fff;">${esc(p.traffic)}</span></div>
        <div style="font-size:9px;color:#aaa;">Risk: <span style="color:${riskCol};font-weight:bold;">${esc(p.risk)}</span></div>
      </div>`);
    });

    // ── Live News (opens feed viewer) ──
    map.on('click', 'news-dots', e => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      onEntityClick?.({
        type: 'live_news',
        name: p.name,
        city: p.city,
        country: p.country,
        url: p.url,
        category: p.category,
        embed_allowed: p.embed_allowed !== false && p.embed_allowed !== 'false',
      });
    });

    // ── Frontline Areas (DeepState) — click for territory status + duration ──
    map.on('click', 'frontline-fill', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const { lngLat } = e;
      const sk: string = p.statusKey || '';
      if (!sk || sk === 'other' || sk === 'attack_direction') return;

      const isOccupied  = sk === 'occupied';
      const isLiberated = sk === 'dismissed' || sk === 'dismissed_at';
      const color = isOccupied ? '#EF5350' : isLiberated ? '#66BB6A' : '#78909C';
      const label = (p.statusLabel || sk).toUpperCase();

      let durationHtml = '';
      if (isOccupied) {
        const days = Math.floor((Date.now() - new Date('2022-02-24').getTime()) / 86400000);
        const months = Math.floor(days / 30.44);
        durationHtml = `<div style="margin-top:6px;font-size:10px;color:#aaa;">Under occupation ~${months} months (since 24 Feb 2022)</div>`;
      } else if (isLiberated && p.eventDate) {
        const d = new Date(p.eventDate);
        const days = Math.floor((Date.now() - d.getTime()) / 86400000);
        const months = Math.floor(days / 30.44);
        const dateLabel = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        durationHtml = `<div style="margin-top:6px;font-size:10px;color:#aaa;">Liberated ~${months} months ago (${dateLabel})</div>`;
      } else if (isLiberated) {
        durationHtml = `<div style="margin-top:6px;font-size:10px;color:#aaa;">Liberated from Russian occupation</div>`;
      }

      const desc = (p.descriptionEn || '').replace(/Source:.*$/i, '').trim();
      popup([lngLat.lng, lngLat.lat], `<div style="${pStyle}border:1px solid ${color}40;min-width:220px;">
        <div style="color:${color};font-size:13px;font-weight:700;letter-spacing:0.08em;">${isOccupied ? '⬛' : isLiberated ? '✅' : '❓'} ${esc(label)}</div>
        ${durationHtml}
        ${desc ? `<div style="margin-top:10px;padding-top:8px;border-top:1px solid ${color}20;font-size:10px;color:#ccc;line-height:1.55;">${esc(desc)}</div>` : ''}
        <div style="margin-top:8px;font-size:9px;color:#5C5A54;">${lngLat.lat.toFixed(3)}°N ${lngLat.lng.toFixed(3)}°E</div>
      </div>`);
    });
    map.on('mouseenter', 'frontline-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'frontline-fill', () => { map.getCanvas().style.cursor = ''; });

    // ── Frontline delta gain patches — click for direction + area + compare date ──
    const onDeltaClick = (direction: 'ru_gain' | 'ua_gain') => (e: any) => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const { lngLat } = e;
      const isRu = direction === 'ru_gain';
      const color = isRu ? '#FF3D00' : '#1565C0';
      const label = isRu ? 'RU ADVANCE' : 'UA RECOVERY';
      const icon = isRu ? '🔴' : '🔵';
      const areaKm2 = p.area_km2 ? `${Number(p.area_km2).toLocaleString()} km²` : '—';
      const compareDate = p.compare_date || '—';

      popup([lngLat.lng, lngLat.lat], `<div style="${pStyle}border:1px solid ${color}40;min-width:220px;">
        <div style="color:${color};font-size:13px;font-weight:700;letter-spacing:0.08em;">${icon} ${label}</div>
        <div style="margin-top:6px;font-size:11px;color:#ccc;">Patch area: <strong style="color:${color};">${areaKm2}</strong></div>
        <div style="margin-top:4px;font-size:10px;color:#aaa;">7-day delta · DeepState assessment</div>
        <div style="margin-top:8px;font-size:9px;color:#5C5A54;">${lngLat.lat.toFixed(3)}°N ${lngLat.lng.toFixed(3)}°E</div>
      </div>`);
    };
    map.on('click', 'frontline-ru-gain-fill', onDeltaClick('ru_gain'));
    map.on('click', 'frontline-ua-gain-fill', onDeltaClick('ua_gain'));
    map.on('mouseenter', 'frontline-ru-gain-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'frontline-ru-gain-fill', () => { map.getCanvas().style.cursor = ''; });
    map.on('mouseenter', 'frontline-ua-gain-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'frontline-ua-gain-fill', () => { map.getCanvas().style.cursor = ''; });

    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Day/Night
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    const update = () => {
      const src = map.getSource('day-night') as any;
      if (!src) return;
      if (!activeLayers.day_night) { src.setData(EMPTY_FC); return; }
      src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [computeSolarTerminator()] }, properties: {} }] });
    };
    update();
    const iv = setInterval(update, 300000); // 5 min (was 1 min — shadow barely moves)
    return () => clearInterval(iv);
  }, [mapReady, activeLayers.day_night]);

  // Helper to set GeoJSON
  const setGeo = useCallback((source: string, features: any[]) => {
    const map = mapRef.current;
    const src = map?.getSource(source) as any;
    if (src) { src.setData({ type: 'FeatureCollection', features }); map?.triggerRepaint(); }
  }, []);

  const setVis = useCallback((ids: string[], visible: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    ids.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'); });
    map.triggerRepaint();
  }, []);

  // Flight data → GeoJSON (GPU rendered)
  useEffect(() => {
    if (!mapReady) return;
    const toFeatures = (arr: any[], decimate: number = 1) => {
      let filtered = arr || [];
      if (decimate > 1) {
        filtered = filtered.filter((_, i) => i % decimate === 0);
      }
      return filtered.map((f: any) => ({
        type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [f.lng, f.lat] },
        properties: { callsign: f.callsign, heading: f.heading || 0, alt: f.alt, model: f.model, speed_knots: f.speed_knots, registration: f.registration, icao24: f.icao24, aircraft_category: f.aircraft_category || 'plane' },
      }));
    };
    setGeo('flights', activeLayers.flights ? toFeatures(data.commercial_flights, 10) : []);
    setGeo('private-fl', activeLayers.private ? toFeatures(data.private_flights, 2) : []);
    setGeo('jets', activeLayers.jets ? toFeatures(data.private_jets, 2) : []);
    setGeo('military', activeLayers.military ? toFeatures(data.military_flights) : []);
  }, [mapReady, data.commercial_flights, data.private_flights, data.private_jets, data.military_flights, activeLayers.flights, activeLayers.private, activeLayers.jets, activeLayers.military]);

  // ── DECOUPLED LAYER RENDERERS (Performance Optimized) ──

  useEffect(() => {
    if (!mapReady) return;
    setGeo('earthquakes', activeLayers.earthquakes && data.earthquakes ? data.earthquakes.map((eq: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [eq.lng, eq.lat] }, properties: { magnitude: eq.magnitude, place: eq.place } })) : []);
  }, [mapReady, data.earthquakes, activeLayers.earthquakes, setGeo]);

  // Frontline overlay — features already carry geometry + DeepState style props.
  useEffect(() => {
    if (!mapReady) return;
    setGeo('frontlines', activeLayers.frontlines && data.frontlines ? data.frontlines : []);
  }, [mapReady, data.frontlines, activeLayers.frontlines, setGeo]);

  // Directional frontline delta — RU gain (orange-red) / UA gain (blue) patches.
  useEffect(() => {
    if (!mapReady) return;
    const active = activeLayers.frontlines;
    setGeo('frontline-ru-gain', active && data.frontline_ru_gain ? data.frontline_ru_gain : []);
    setGeo('frontline-ua-gain', active && data.frontline_ua_gain ? data.frontline_ua_gain : []);
  }, [mapReady, data.frontline_ru_gain, data.frontline_ua_gain, activeLayers.frontlines, setGeo]);

  // Axis briefing: draw bbox rectangle or clear when focus changes
  useEffect(() => {
    if (!mapReady) return;
    if (!focusedAxisBbox) {
      setGeo('axis-focus', []);
      return;
    }
    const [minLng, minLat, maxLng, maxLat] = focusedAxisBbox;
    const ring: [number, number][] = [
      [minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]
    ];
    setGeo('axis-focus', [{
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [ring] },
      properties: {}
    }]);
  }, [mapReady, focusedAxisBbox, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    const cutoff = replayTime ?? new Date();
    const cutoffMs = cutoff.getTime();
    const all: any[] = activeLayers.thermal_aoi && data.thermal_aoi ? data.thermal_aoi : [];
    const firesOnly = activeLayers.thermal_aoi_fires_only;
    const visible = all.filter((a: any) => {
      if (firesOnly && !a.hit) return false; // hide cold sites when fires-only is on
      if (!a.latest) {
        // News-category AOIs have no per-item timestamp; always show as reference context
        // so the histogram density spikes (from data.news) correspond to visible map markers.
        return true;
      }
      const ts = parseThermalLatest(a.latest);
      if (ts === null) return true; // unparseable timestamp → always show
      if (ts > cutoffMs) return false;
      // 24h rolling window: only applied in live mode. In replay the operator may
      // be studying events >24h old; the hard window would hide them at the cursor.
      if (!replayTime && (cutoffMs - ts) >= 86400000) return false;
      return true;
    });
    setGeo('thermal-aoi', visible.map((a: any) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [a.lng, a.lat] },
      properties: {
        id: a.id, name: a.name, category: a.category,
        hit: a.hit, fireCount: a.fireCount, maxFrp: a.maxFrp,
        confidence: a.confidence, latest: a.latest,
        bilateral: a.bilateral ?? false,
        videoConfirmed: a.videoConfirmed ?? false,
        confirmed: !!(a.hit || a.videoConfirmed || a.bilateral),
        weapon: a.weapon ?? '',
        sources: a.sources ? JSON.stringify(a.sources) : '[]',
      },
    })));
  }, [mapReady, data.thermal_aoi, activeLayers.thermal_aoi, activeLayers.thermal_aoi_fires_only, setGeo, replayTime]);

  useEffect(() => {
    if (!mapReady) return;
    const cutoff = replayTime ?? new Date();
    const cutoffMs = cutoff.getTime();
    const all: any[] = activeLayers.captures && data.captures ? data.captures : [];
    const visible = all.filter((c: any) => {
      if (!c.date) return true;
      const t = new Date(c.date).getTime();
      if (t > cutoffMs) return false;
      // Skip the 24h lower-bound during replay so scrubbing shows the captures
      // that were live at the scrubbed time (matches thermal/gdelt/news).
      if (!replayTime && (cutoffMs - t) >= 86400000) return false;
      return true;
    });
    setGeo('captures', visible.map((c: any) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: { id: c.id, name: c.name, side: c.side, source: c.source, link: c.link, date: c.date, count: c.count, description: c.description, conflicted: c.conflicted, other_name: c.other_name, other_link: c.other_link, other_source: c.other_source, other_side: c.other_side, confidence: (c as any).confidence ?? null },
    })));
  }, [mapReady, data.captures, activeLayers.captures, setGeo, replayTime]);

  // Air quality (Open-Meteo) — colored PM2.5 station dots.
  useEffect(() => {
    if (!mapReady) return;
    setGeo('air-quality', activeLayers.air_quality && data.air_quality ? data.air_quality.map((s: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { city: s.city, country: s.country, pm25: s.pm25, level: s.level, color: s.color, us_aqi: s.us_aqi } })) : []);
  }, [mapReady, data.air_quality, activeLayers.air_quality, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    const sats = data.satellites || [];
    const al = activeLayers as any;
    const toFeature = (s: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { name: s.name, color: s.color, mission: s.mission, alt: s.alt, noradId: s.noradId, category: s.category } });

    // 'All Satellites' on → show everything, ignore sub-layer toggles.
    if (al.satellites) {
      setGeo('satellites', sats.map(toFeature));
      return;
    }

    const enabledCategories: string[] = [];
    if (al.sat_comms) enabledCategories.push('comms');
    if (al.sat_military) enabledCategories.push('military');
    if (al.sat_navigation) enabledCategories.push('navigation');
    if (al.sat_earth) enabledCategories.push('earth_obs');
    if (al.sat_science) enabledCategories.push('science');

    if (enabledCategories.length === 0) {
      setGeo('satellites', []);
      return;
    }

    setGeo('satellites', sats.filter((s: any) => enabledCategories.includes(s.category)).map(toFeature));
  }, [mapReady, data.satellites, activeLayers.satellites, (activeLayers as any).sat_comms, (activeLayers as any).sat_military, (activeLayers as any).sat_navigation, (activeLayers as any).sat_earth, (activeLayers as any).sat_science, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    const cutoff = replayTime ?? new Date();
    setGeo('gdelt', activeLayers.global_incidents && data.gdelt ? data.gdelt.filter((e: any) => {
      if (!e.published) return true;
      const t = new Date(e.published).getTime();
      if (t > cutoff.getTime()) return false;
      if (!replayTime && (cutoff.getTime() - t) >= 86400000) return false;
      return true;
    }).map((e: any) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [e.lng, e.lat] },
      properties: {
        name: e.name,
        url: e.url,
        published: e.published,
        confidence: e.confidence ?? 'reported',
        sources: (e.sources ?? []).join(', '),
        eventType: e.eventType ?? 'conflict',
      },
    })) : []);
  }, [mapReady, data.gdelt, activeLayers.global_incidents, setGeo, replayTime]);

  // IODA Internet Outages
  useEffect(() => {
    if (!mapReady) return;
    setGeo('ioda-outages', activeLayers.internet_outages && data.ioda_outages ? data.ioda_outages.map((o: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [o.lng, o.lat] }, properties: { country: o.country, score: o.score, level: o.level, datasource: o.datasource } })) : []);
  }, [mapReady, data.ioda_outages, activeLayers.internet_outages, setGeo]);

  // Malware Threats
  useEffect(() => {
    if (!mapReady) return;
    setGeo('malware-nodes', activeLayers.malware && data.malware_threats ? data.malware_threats.map((t: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [t.lng, t.lat] }, properties: { ip: t.ip, malware: t.malware, status: t.status, threat_type: t.threat_type, country: t.country } })) : []);
  }, [mapReady, data.malware_threats, activeLayers.malware, setGeo]);

  // Network Mesh Generation (Nearest Neighbor Lattice)
  useEffect(() => {
    if (!mapReady) return;
    const meshLinks: any[] = [];

    // Generate IODA Mesh
    if (activeLayers.internet_outages && data.ioda_outages && data.ioda_outages.length > 1) {
      const nodes = data.ioda_outages;
      for (let i = 0; i < nodes.length; i++) {
        // Connect each to next 2 for a global web
        for (let j = 1; j <= 2; j++) {
          const target = nodes[(i + j) % nodes.length];
          meshLinks.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[nodes[i].lng, nodes[i].lat], [target.lng, target.lat]] },
            properties: { threat_type: 'ioda' }
          });
        }
      }
    }

    // Generate Malware Botnet Mesh
    if (activeLayers.malware && data.malware_threats && data.malware_threats.length > 1) {
      const nodes = data.malware_threats;
      for (let i = 0; i < nodes.length; i++) {
        // Connect each to next 2 for a global web
        for (let j = 1; j <= 2; j++) {
          const target = nodes[(i + j) % nodes.length];
          meshLinks.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[nodes[i].lng, nodes[i].lat], [target.lng, target.lat]] },
            properties: { threat_type: 'malware' }
          });
        }
      }
    }
    setGeo('network-mesh', meshLinks);
  }, [mapReady, activeLayers.internet_outages, activeLayers.malware, data.ioda_outages, data.malware_threats, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    setGeo('gps-jamming', activeLayers.gps_jamming && data.gps_jamming ? data.gps_jamming.map((z: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [z.lng, z.lat] }, properties: { severity: z.severity } })) : []);
  }, [mapReady, data.gps_jamming, activeLayers.gps_jamming, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    setGeo('cctv', activeLayers.cctv && data.cameras ? data.cameras.map((c: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { id: c.id, name: c.name, city: c.city, country: c.country, source: c.source, feed_url: c.feed_url, stream_url: c.stream_url, stream_type: c.stream_type, external_url: c.external_url } })) : []);
  }, [mapReady, data.cameras, activeLayers.cctv, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    setGeo('fires', activeLayers.fires && data.fires ? data.fires.map((f: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [f.lng, f.lat] }, properties: { brightness: f.brightness } })) : []);
  }, [mapReady, data.fires, activeLayers.fires, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    setGeo('weather', activeLayers.weather && data.weather_events ? data.weather_events.map((w: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [w.lng, w.lat] }, properties: { title: w.title, type: w.type, icon: w.icon, severity: w.severity, source: w.source, id: w.id } })) : []);
  }, [mapReady, data.weather_events, activeLayers.weather, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    setGeo('infrastructure', activeLayers.infrastructure && data.infrastructure ? data.infrastructure.map((i: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [i.lng, i.lat] }, properties: { name: i.name, city: i.city, country: i.country, status: i.status, reactors: i.reactors, capacityMW: i.capacityMW, owner: i.owner } })) : []);
  }, [mapReady, data.infrastructure, activeLayers.infrastructure, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    setGeo('maritime', activeLayers.maritime && data.maritime_ports ? data.maritime_ports.map((p: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { name: p.name, country: p.country, type: p.type, volume: p.volume, fleet: p.fleet, rank: p.rank } })) : []);
    setGeo('maritime-choke', activeLayers.maritime && data.maritime_chokepoints ? data.maritime_chokepoints.map((c: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { name: c.name, traffic: c.traffic, risk: c.risk } })) : []);
    setGeo('maritime-ships', (activeLayers.ships || activeLayers.shadow_fleet) && data.maritime_ships ? data.maritime_ships.filter((s: any) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180 && !(s.lat === 0 && s.lng === 0)).map((s: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { name: s.name || s.mmsi?.toString(), type: s.type || 'cargo', speed: s.speed, heading: s.heading, destination: s.destination, flag: s.flag, flag_emoji: s.flag_emoji, shadow_fleet: s.shadow_fleet === true, stale: s.stale === true, minutes_since_update: s.minutes_since_update, last_position_at: s.last_position_at } })) : []);
  }, [mapReady, data.maritime_ports, data.maritime_chokepoints, data.maritime_ships, activeLayers.maritime, activeLayers.ships, activeLayers.shadow_fleet, setGeo]);

  // Shadow Fleet Track Lines — builds per-segment LineString features from the
  // 24h ring-buffer positions returned by /api/maritime?tracks=1.
  // Each segment carries an ageHours property (age of the *start* position) that
  // the layer uses for opacity fade — segments > 24h will be near-invisible.
  useEffect(() => {
    if (!mapReady) return;
    if (!activeLayers.shadow_fleet_tracks || !Array.isArray(data.shadow_fleet_tracks) || data.shadow_fleet_tracks.length === 0) {
      setGeo('shadow-fleet-tracks', []);
      return;
    }
    const now = Date.now();
    const MAX_SEG_KPH = 92.6; // 50 knots — any segment implying faster speed is a ghost GPS fix
    const segDistKm = (a: {lat:number;lng:number}, b: {lat:number;lng:number}) => {
      const R = 6371, toR = Math.PI / 180;
      const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
      const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*toR)*Math.cos(b.lat*toR)*Math.sin(dLng/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
    };
    const segments: any[] = [];
    for (const vessel of data.shadow_fleet_tracks as any[]) {
      const positions: { lat: number; lng: number; ts: number }[] = vessel.positions;
      if (!positions || positions.length < 2) continue;
      for (let i = 0; i < positions.length - 1; i++) {
        const a = positions[i];
        const b = positions[i + 1];
        const dtH = (b.ts - a.ts) / 3_600_000;
        if (dtH > 0 && segDistKm(a, b) / dtH > MAX_SEG_KPH) continue;
        segments.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] },
          properties: { mmsi: vessel.mmsi, name: vessel.name ?? 'Unknown', ageHours: (now - a.ts) / 3_600_000 },
        });
      }
    }
    setGeo('shadow-fleet-tracks', segments);
  }, [mapReady, data.shadow_fleet_tracks, activeLayers.shadow_fleet_tracks, setGeo]);

  // ── AIS Dark Vessel Dead-Reckoning ──
  // Runs client-side whenever ship data or DR toggle changes — no new API route needed.
  useEffect(() => {
    if (!mapReady) return;
    const ships: any[] = data.maritime_ships || [];
    const drPointFeatures: GeoJSON.Feature[] = [];
    const drRingFeatures: GeoJSON.Feature[] = [];

    if (activeLayers.dark_vessel_dr) {
      for (const s of ships) {
        if (!(s.shadow_fleet === true) || !(s.stale === true)) continue;
        if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
        if (Math.abs(s.lat) > 90 || Math.abs(s.lng) > 180) continue;

        const elapsedHours = (Number(s.minutes_since_update) || 0) / 60;
        if (elapsedHours > 6 || elapsedHours < 0.17) continue;

        // Heading: prefer heading, fall back to nothing (511 = NMEA sentinel)
        const rawHeading = Number(s.heading);
        const headingValid = Number.isFinite(rawHeading) && rawHeading !== 511 && rawHeading >= 0 && rawHeading < 360;

        // Speed: use reported speed; if 0 or absent default to typical shadow tanker
        const rawSpeed = Number(s.speed);
        const speed = rawSpeed > 0.1 ? rawSpeed : 8;

        const radius = uncertaintyRadiusKm(speed, elapsedHours);
        const name = s.name || s.mmsi?.toString() || 'UNKNOWN';

        // Uncertainty ring always shown (even without a valid heading)
        drRingFeatures.push(uncertaintyRing(s.lat, s.lng, radius, { elapsedHours, mmsi: s.mmsi, name }));

        // DR point only when heading is valid
        if (headingValid) {
          const drPos = deadReckon(s.lat, s.lng, rawHeading, speed, elapsedHours);
          if (drPos) {
            const [drLat, drLng] = drPos;
            drPointFeatures.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [drLng, drLat] },
              properties: { mmsi: s.mmsi, name, elapsedHours, isDR: true },
            });
          }
        }
      }
    }

    setGeo('dark-vessel-uncertainty', drRingFeatures);
    setGeo('dark-vessel-dr', drPointFeatures);
  }, [mapReady, data.maritime_ships, activeLayers.dark_vessel_dr, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    setGeo('balloons', activeLayers.balloons && data.balloons ? data.balloons.map((b: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [b.lng, b.lat] }, properties: { callsign: b.callsign, type: b.type, status: b.status, altitude: b.altitude, speed: b.speed, verticalRate: b.verticalRate, temperature: b.temperature, color: b.color } })) : []);
  }, [mapReady, data.balloons, activeLayers.balloons, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    setGeo('radiation', activeLayers.radiation && data.radiation ? data.radiation.map((r: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lng, r.lat] }, properties: { name: r.name, city: r.city, country: r.country, reading: r.reading, status: r.status, network: r.network } })) : []);
  }, [mapReady, data.radiation, activeLayers.radiation, setGeo]);

  // ══ OSIRIS SDK — Lattice Sensor Mesh ══
  // Uses real submarine cable data for SEA domain, curated routes for AIR/INTEL
  useEffect(() => {
    if (!mapReady) return;
    setGeo('sdk-entities', []);

    const anySDK = activeLayers.sdk_sea || activeLayers.sdk_air || activeLayers.sdk_naval;
    if (!anySDK) {
      setGeo('sdk-links', []);
      return;
    }

    const links: any[] = [];

    // ── SEA DOMAIN: Real submarine cable data (1-for-1 Match) ──
    if (activeLayers.sdk_sea && data.submarine_cables) {
      const ignoredColors = new Set(['#9BB5CC', '#A0B8CD', '#8EABC2', '#9bb5cc', '#a0b8cd', '#8eabc2']);
      for (const cable of data.submarine_cables) {
        if (!cable.geometry) continue;
        
        // Remove the light blue background arcs
        if (cable.properties?.color && ignoredColors.has(cable.properties.color)) continue;
        
        links.push({
          type: 'Feature',
          geometry: cable.geometry, // Raw topographic paths exactly from Submarine Map
          properties: {
            domain: 'SEA',
            fromName: cable.properties?.name || 'Submarine Cable',
            toName: cable.properties?.landing_points || '',
            source: 'Global Subsea Cable Network',
            url: 'https://www.submarinecablemap.com/',
            ...cable.properties,
            color: '#1976D2', // Darker blue as requested, more transparent in layer paint
          },
        });
      }
    }

    setGeo('sdk-links', links);
  }, [mapReady, activeLayers.sdk_sea, activeLayers.sdk_air, activeLayers.sdk_naval, data.submarine_cables, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    const alerts = activeLayers.air_raids && data.air_raids ? data.air_raids : [];
    const dotFeatures = alerts.filter((a: any) => a.lat && a.lng).map((a: any) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] },
      properties: { regionName: a.regionName, alertType: a.alertType, startedAt: a.startedAt, regionId: a.regionId, level: a.level, oblast: a.oblast },
    }));
    setGeo('air-raid-alerts', dotFeatures);

    // Update polygon fills: oblast alerts fill the oblast polygon;
    // district alerts fill only the specific rayon — NOT the parent oblast.
    // normalizeApos is module-level (hoisted from here to fix stale-closure
    // risk if it were needed in click handlers too).
    const map = mapRef.current;
    if (map?.getLayer('raid-oblast-fill')) {
      const oblastNames = activeLayers.air_raids
        ? alerts.filter((a: any) => a.level === 'oblast').map((a: any) => normalizeApos(a.regionName as string)).filter(Boolean)
        : [];
      const districtNames = activeLayers.air_raids
        ? alerts.filter((a: any) => a.level === 'district').map((a: any) => normalizeApos(a.regionName as string)).filter(Boolean)
        : [];
      map.setFilter('raid-oblast-fill',    ['in', ['get', 'name_en'], ['literal', oblastNames]]);
      map.setFilter('raid-oblast-outline', ['in', ['get', 'name_en'], ['literal', oblastNames]]);
      map.setFilter('raid-district-fill',    ['in', ['get', 'name_ua'], ['literal', districtNames]]);
      map.setFilter('raid-district-outline', ['in', ['get', 'name_ua'], ['literal', districtNames]]);
    }
  }, [mapReady, data.air_raids, activeLayers.air_raids, setGeo]);

  // Oblast Pressure Index — data-driven choropleth fill over ukraine-oblast-fill source.
  // Deps: mapReady, data.oblast_pressure, activeLayers.oblast_pressure, setGeo.
  // setGeo is included because it is a useCallback dep; not actually called here
  // (we use setFilter/setPaintProperty directly), but needed for exhaustive-deps.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map?.getLayer('pressure-oblast-fill')) return;
    if (!activeLayers.oblast_pressure || !Array.isArray(data.oblast_pressure) || data.oblast_pressure.length === 0) {
      map.setFilter('pressure-oblast-fill',   ['in', ['get', 'name_en'], ['literal', []]]);
      map.setFilter('pressure-oblast-outline', ['in', ['get', 'name_en'], ['literal', []]]);
      return;
    }
    const LEVEL_COLOR: Record<string, string> = { low: '#FFEB3B', med: '#FF9800', high: '#FF5722', critical: '#D50000' };
    const colorExpr: any[] = ['match', ['get', 'name_en']];
    const opacityExpr: any[] = ['match', ['get', 'name_en']];
    const names: string[] = [];
    for (const o of data.oblast_pressure as any[]) {
      const n = normalizeApos(o.name_en);
      names.push(n);
      colorExpr.push(n, LEVEL_COLOR[o.level] ?? '#FF7043');
      opacityExpr.push(n, o.level === 'critical' ? 0.55 : o.level === 'high' ? 0.45 : o.level === 'med' ? 0.35 : 0.20);
    }
    colorExpr.push('rgba(0,0,0,0)');
    opacityExpr.push(0);
    map.setFilter('pressure-oblast-fill',   ['in', ['get', 'name_en'], ['literal', names]]);
    map.setFilter('pressure-oblast-outline', ['in', ['get', 'name_en'], ['literal', names]]);
    map.setPaintProperty('pressure-oblast-fill', 'fill-color', colorExpr);
    map.setPaintProperty('pressure-oblast-fill', 'fill-opacity', opacityExpr);
  }, [mapReady, data.oblast_pressure, activeLayers.oblast_pressure, setGeo]);

  // Unified Threats — single point-icon layer for all 6 categories (fpv, cruise,
  // ballistic, kab, aviation, recon) plus the 'uav' fallback bucket. Replaces the
  // old separate kab-threats/mig31k-alerts point layers and the drone-route /
  // missile-routes connected-line meshes. Standalone icons only, no lines.
  // Each feature gets a stable numeric `id` (top-level, not in properties) so
  // MapLibre feature-state (used for click-to-select) persists across re-renders.
  useEffect(() => {
    if (!mapReady) return;
    const threats: any[] = activeLayers.unified_threats && Array.isArray(data.threats) ? data.threats : [];
    setGeo('unified-threats', threats
      .filter((t: any) => {
        const coords = t?.geometry?.coordinates;
        return Array.isArray(coords) && Number.isFinite(coords[0]) && Number.isFinite(coords[1]);
      })
      .map((t: any, i: number) => {
        const p = t.properties || {};
        const meta = THREAT_TYPE_META[p.ttype as string] ?? THREAT_TYPE_META.uav;
        return {
          type: 'Feature',
          id: i,
          geometry: t.geometry,
          properties: {
            fid: p.fid, tid: p.tid ?? '',
            ttype: p.ttype, title: p.title, place: p.place, oblast: p.oblast,
            confidence: p.confidence, band: p.band, bearing: p.bearing ?? null,
            approximate: !!p.approximate, sources: p.sources, ts: p.ts,
            color: meta.color, trail: p.trail ?? null,
          },
        };
      }));
    // Trail lines — one LineString per chain with >=2 trail points, rendered
    // behind the icon layer. Static threats (kab/ballistic/etc.) never have
    // trail arrays so they're naturally excluded by the length check.
    const trailFeatures: any[] = [];
    for (const t of threats) {
      const p = t?.properties || {};
      if (!Array.isArray(p.trail) || p.trail.length < 2) continue;
      const meta = THREAT_TYPE_META[p.ttype as string] ?? THREAT_TYPE_META.uav;
      trailFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: (p.trail as Array<{ lat: number; lng: number }>).map(pt => [pt.lng, pt.lat]),
        },
        properties: { color: meta.color },
      });
    }
    setGeo('threat-trails', trailFeatures);
  }, [mapReady, data.threats, activeLayers.unified_threats, setGeo]);

  // Alarm-Vector inference layer — LineString from→to + Point arrow at destination.
  // Fed from the unified /api/threats response's alarm_vectors[] field. Gated on
  // either the unified-threats toggle or the standalone alarm_vectors toggle, so
  // it doesn't silently stop working now that the old drone/missile toggles are gone.
  // TODO: tighten AlarmVector[] type after backend merge (currently any[]).
  useEffect(() => {
    if (!mapReady) return;
    const vectors: any[] = (activeLayers.unified_threats || activeLayers.alarm_vectors) && data.alarm_vectors ? data.alarm_vectors : [];
    const features: any[] = [];
    for (const v of vectors) {
      // LineString from→to
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[v.fromLng, v.fromLat], [v.toLng, v.toLat]] },
        properties: { id: v.id, confidence: v.confidence, label: 'Inferred from alarm timing' },
      });
      // Point at destination for arrow
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [v.toLng, v.toLat] },
        properties: { id: `${v.id}-arrow`, bearing: v.bearing, confidence: v.confidence },
      });
    }
    setGeo('alarm-vectors', features);
  }, [mapReady, data.alarm_vectors, activeLayers.unified_threats, activeLayers.alarm_vectors, setGeo]);

  // Correlated Events — multi-signal oblast correlation layer.
  useEffect(() => {
    if (!mapReady) return;
    const events: any[] = activeLayers.correlated_events && (data as any).correlated_events
      ? (data as any).correlated_events
      : [];
    setGeo('correlated-events', events.filter((e: any) => e.lat != null && e.lng != null).map((e: any) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [e.lng, e.lat] },
      properties: {
        alarm_confirmed: e.alarm_confirmed === true,
        oblast: e.oblast ?? '',
        match_tightness_min: e.match_tightness_min ?? 0,
        signal_types: Array.isArray(e.signals) ? e.signals.map((s: any) => s.type).join(',') : '',
      },
    })));
  }, [mapReady, data, activeLayers.correlated_events, setGeo]);

  // RU Oblast Alerts (Russian border oblast drone/strike incursions).
  useEffect(() => {
    if (!mapReady) return;
    const events = activeLayers.ru_air_raids && data.ru_air_raids ? data.ru_air_raids : [];
    setGeo('ru-air-raids', events.map((e: any) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [e.lng, e.lat] },
      properties: {
        oblast:        e.oblast,
        started_at:    e.started_at,
        status:        e.status ?? 'unknown',
        cleared_at:    e.cleared_at ?? null,
        confidence:    e.confidence ?? 'low',
        channel_count: e.channel_count ?? 1,
        source:        e.source,
        snippet:       e.snippet,
      },
    })));
  }, [mapReady, data.ru_air_raids, activeLayers.ru_air_raids, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    const outages = activeLayers.power_outages && data.power_outages ? data.power_outages : [];
    setGeo('power-outages', outages.filter((o: any) => o.lat && o.lng).map((o: any) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [o.lng, o.lat] },
      properties: { regionName: o.regionName, type: o.type, severity: o.severity, schedule: o.schedule, source: o.source },
    })));
    const map = mapRef.current;
    if (map?.getLayer('outage-oblast-fill')) {
      const names = outages
        .map((o: any) => OUTAGE_REGION_TO_GEOJSON[o.regionName as string] || '')
        .filter(Boolean);
      map.setFilter('outage-oblast-fill',   ['in', ['get', 'name_en'], ['literal', names]]);
      map.setFilter('outage-oblast-outline', ['in', ['get', 'name_en'], ['literal', names]]);
    }
  }, [mapReady, data.power_outages, activeLayers.power_outages, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    setGeo('live-news', activeLayers.live_news && data.live_feeds ? data.live_feeds.map((f: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [f.lng, f.lat] }, properties: { name: f.name, city: f.city, country: f.country, url: f.url, category: f.category, embed_allowed: f.embed_allowed !== false } })) : []);
  }, [mapReady, data.live_feeds, activeLayers.live_news, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    const items = data.news || [];
    const cutoff = replayTime ?? new Date();
    setGeo('sigint-news', activeLayers.news_intel && items.length > 0
      ? items.filter((n: any) => {
          if (n.coords?.length !== 2) return false;
          if (!n.published) return true;
          const t = new Date(n.published).getTime();
          if (t > cutoff.getTime()) return false;
          if (!replayTime && (cutoff.getTime() - t) >= 86400000) return false;
          return true;
        }).map((n: any) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [n.coords[1], n.coords[0]] },
          properties: { title: n.title, source: n.source, risk_score: n.risk_score, link: n.link, published: n.published }
        }))
      : []);
  }, [mapReady, data.news, activeLayers.news_intel, setGeo, replayTime]);

  useEffect(() => {
    if (!mapReady) return;
    // ── CONFLICT ZONES — center-point warning markers ──
    const CONFLICT_ZONES = [
      { label: 'UKRAINE WAR', severity: 'war', lat: 48.5, lng: 31.2 },
      { label: 'GAZA CONFLICT', severity: 'war', lat: 31.35, lng: 34.35 },
      { label: 'LEBANON BORDER', severity: 'high', lat: 33.4, lng: 35.8 },
      { label: 'SUDAN CIVIL WAR', severity: 'war', lat: 15.0, lng: 30.0 },
      { label: 'MYANMAR CONFLICT', severity: 'war', lat: 19.5, lng: 96.5 },
      { label: 'DRC EASTERN CONFLICT', severity: 'war', lat: -1.0, lng: 28.5 },
      { label: 'YEMEN WAR', severity: 'war', lat: 15.5, lng: 48.0 },
      { label: 'SYRIA', severity: 'high', lat: 35.0, lng: 38.5 },
      { label: 'TAIWAN STRAIT', severity: 'elevated', lat: 24.0, lng: 119.5 },
      { label: 'KOREAN DMZ', severity: 'elevated', lat: 38.3, lng: 127.0 },
      { label: 'SAHEL INSTABILITY', severity: 'high', lat: 14.0, lng: 5.0 },
      { label: 'SOMALIA', severity: 'high', lat: 5.0, lng: 46.0 },
      { label: 'RED SEA THREAT', severity: 'high', lat: 16.0, lng: 40.0 },
    ];
    const conflictFeatures = CONFLICT_ZONES.map(z => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [z.lng, z.lat] },
      properties: { label: z.label, severity: z.severity },
    }));
    setGeo('conflict-zones', conflictFeatures);
  }, [mapReady, setGeo]);

  // Railway Incidents — GeoJSON FeatureCollection from /api/railway-incidents
  useEffect(() => {
    if (!mapReady) return;
    if (!activeLayers.railway_incidents) {
      setGeo('railway-incidents', []);
      return;
    }
    const d = (data as any).railway_incidents_geo;
    if (!d || !Array.isArray(d)) { setGeo('railway-incidents', []); return; }
    setGeo('railway-incidents', d);
  }, [mapReady, (activeLayers as any).railway_incidents, (data as any).railway_incidents_geo, setGeo]);

  // Visibility
  useEffect(() => {
    if (!mapReady) return;
    setVis(['eq-circles','eq-label'], activeLayers.earthquakes);
    const anySat = activeLayers.satellites || (activeLayers as any).sat_comms || (activeLayers as any).sat_military || (activeLayers as any).sat_navigation || (activeLayers as any).sat_earth || (activeLayers as any).sat_science;
    setVis(['sat-glow','sat-dots'], anySat);
    setVis(['gdelt-dots'], activeLayers.global_incidents);
    setVis(['ioda-glow','ioda-dots','ioda-label'], activeLayers.internet_outages);
    setVis(['malware-glow','malware-dots','malware-label'], activeLayers.malware);
    setVis(['network-mesh-atmo', 'network-mesh-glow', 'network-mesh-core'], activeLayers.internet_outages || activeLayers.malware);
    setVis(['jam-fill','jam-label'], activeLayers.gps_jamming);
    setVis(['day-night-fill'], activeLayers.day_night);
    setVis(['fl-commercial'], activeLayers.flights);
    setVis(['fl-private'], activeLayers.private);
    setVis(['fl-jets'], activeLayers.jets);
    setVis(['fl-military'], activeLayers.military);
    setVis(['cctv-glow','cctv-dots','cctv-label'], activeLayers.cctv);
    setVis(['fires-heat'], activeLayers.fires);
    setVis(['weather-glow','weather-dots','weather-label'], activeLayers.weather);
    setVis(['infra-glow','infra-dots','infra-label'], activeLayers.infrastructure);
    setVis(['maritime-glow','maritime-dots','maritime-label'], activeLayers.maritime);
    setVis(['choke-glow','choke-dots','choke-label'], activeLayers.maritime);
    setVis(['ship-dots','ship-label'], activeLayers.ships);
    setVis(['ship-shadow-dots','ship-shadow-label'], activeLayers.shadow_fleet);
    setVis(['dark-vessel-uncertainty-fill','dark-vessel-dr-point','dark-vessel-dr-label'], activeLayers.dark_vessel_dr);
    setVis(['news-glow','news-dots','news-label'], activeLayers.live_news);
    setVis(['sigint-news-glow','sigint-news-dots','sigint-news-label'], activeLayers.news_intel);
    setVis(['conflict-icons'], true); // conflict-icons are always-on — no user toggle

    setVis(['balloon-dots','balloon-label'], activeLayers.balloons);
    setVis(['rad-glow','rad-dots','rad-label'], activeLayers.radiation);
    setVis(['sdk-sea','sdk-sea-glow','sdk-sea-atmo'], activeLayers.sdk_sea !== false);
    setVis(['sdk-air','sdk-air-glow','sdk-air-atmo'], activeLayers.sdk_air !== false);
    setVis(['sdk-intel','sdk-intel-glow','sdk-intel-atmo'], activeLayers.sdk_naval !== false);
    // Sweep layers always visible when data is present (controlled by useEffect)
    setVis(['sweep-connections','sweep-pulse-ring','sweep-device-glow','sweep-device-dots','sweep-device-labels'], true);
    setVis(['raid-oblast-fill','raid-oblast-outline','raid-district-fill','raid-district-outline','raid-glow','raid-dots','raid-label'], activeLayers.air_raids);
    setVis(['outage-oblast-fill','outage-oblast-outline','outage-glow','outage-dots','outage-label'], activeLayers.power_outages);
    setVis(['threat-trail-line','unified-threat-glow','unified-threat-icons','unified-threat-icons-selected','unified-threat-label'], activeLayers.unified_threats);
    setVis(['alarm-vector-line','alarm-vector-arrow','alarm-vector-label'], activeLayers.unified_threats || activeLayers.alarm_vectors);
    setVis(['ru-raid-glow','ru-raid-dots','ru-raid-label'], activeLayers.ru_air_raids);
    setVis(['thermal-aoi-glow','thermal-aoi-dots','thermal-aoi-label','thermal-aoi-unconfirmed-label'], activeLayers.thermal_aoi);
    setVis(['capture-glow','capture-dots'], activeLayers.captures);
    setVis(['frontline-fill','frontline-line'], activeLayers.frontlines);
    setVis(['frontline-ru-gain-fill','frontline-ru-gain-line','frontline-ua-gain-fill','frontline-ua-gain-line'], activeLayers.frontlines);
    setVis(['pressure-oblast-fill','pressure-oblast-outline'], activeLayers.oblast_pressure);
    setVis(['shadow-track-line'], activeLayers.shadow_fleet_tracks);
    setVis(['aq-glow','aq-dots','aq-label'], activeLayers.air_quality);
    setVis(['rail-network-line'], activeLayers.railway_network);
    setVis(['rail-strike-dots','rail-strike-label'], activeLayers.railway_incidents);
    setVis(['correlated-ring', 'correlated-label'], activeLayers.correlated_events);
  }, [mapReady, activeLayers, setVis]);

  // IP Sweep visualization
  useEffect(() => {
    if (!mapReady) return;
    if (!sweepData?.devices?.length) {
      setGeo('ip-sweep-devices', []);
      setGeo('ip-sweep-pulse', []);
      setGeo('ip-sweep-connections', []);
      return;
    }

    const map = mapRef.current;
    if (!map) return;

    const { center, devices } = sweepData;
    const centerCoord: [number, number] = [center.lng, center.lat];

    // Switch to globe and fly to the sweep location
    try {
      (map as any).setProjection({ type: 'globe' });
      map.setSky({ 'sky-color': '#0A0A0F', 'sky-horizon-blend': 0.02, 'horizon-color': '#0A0A0F', 'horizon-fog-blend': 0.02 });
    } catch { /* projection may not be supported */ }

    map.flyTo({ center: centerCoord, zoom: 14, pitch: 50, bearing: -20, duration: 3000, essential: true });

    // Set center pulse
    setGeo('ip-sweep-pulse', [{
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: centerCoord },
      properties: { ip: sweepData.target_ip },
    }]);

    // Build device features spread in a circle around center
    const allDeviceFeatures = devices.map((d: any, i: number) => {
      const angle = (i / devices.length) * Math.PI * 2;
      const radius = 0.001 + ((i % 7 + 1) * 0.0004);
      const dLng = centerCoord[0] + Math.cos(angle) * radius * (1 / Math.cos(center.lat * Math.PI / 180));
      const dLat = centerCoord[1] + Math.sin(angle) * radius;
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [dLng, dLat] },
        properties: {
          ip: d.ip, device_type: d.device_type, device_icon: d.device_icon,
          color: d.device_color, risk_level: d.risk_level,
          ports: JSON.stringify(d.ports), hostnames: JSON.stringify(d.hostnames),
          vulns: JSON.stringify(d.vulns), cpes: JSON.stringify(d.cpes), tags: JSON.stringify(d.tags),
        },
      };
    });

    // Connection lines from center to each device
    const connectionFeatures = allDeviceFeatures.map((f: any) => ({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: [centerCoord, f.geometry.coordinates] },
      properties: { color: f.properties.color },
    }));

    // Stagger the appearance after 3s flyTo completes
    const timer = setTimeout(() => {
      setGeo('ip-sweep-connections', connectionFeatures);
      const batchSize = 5;
      const batches = Math.ceil(allDeviceFeatures.length / batchSize);
      for (let b = 0; b < batches; b++) {
        setTimeout(() => {
          setGeo('ip-sweep-devices', allDeviceFeatures.slice(0, (b + 1) * batchSize));
        }, b * 100);
      }
    }, 3000);

    return () => clearTimeout(timer);
  }, [mapReady, sweepData, setGeo]);

  // Scan Targets visualization
  useEffect(() => {
    if (!mapReady || !mapRef.current || !scanTargets) return;
    const map = mapRef.current;
    
    const features = scanTargets.map(t => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [t.lng, t.lat] },
      properties: { ...t }
    }));
    
    const src = map.getSource('scan-targets') as maplibregl.GeoJSONSource;
    if (src) src.setData({ type: 'FeatureCollection', features });
  }, [scanTargets, mapReady]);

  // Fly-to
  useEffect(() => {
    if (!mapReady || !mapRef.current || !flyToLocation) return;
    mapRef.current.flyTo({ center: [flyToLocation.lng, flyToLocation.lat], zoom: 8, duration: 2000 });
  }, [mapReady, flyToLocation]);

  // Transient highlight ring on a search-selected entity (expanding pulse ~4s).
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightRaf = useRef<number | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !highlight) return;

    // Lazily create the source + layers on first use; added last so they render
    // on top of every other layer.
    if (!map.getSource('search-highlight')) {
      map.addSource('search-highlight', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({ id: 'search-highlight-glow', type: 'circle', source: 'search-highlight',
        paint: { 'circle-radius': 34, 'circle-color': '#FFD54F', 'circle-opacity': 0.12, 'circle-blur': 1 } });
      map.addLayer({ id: 'search-highlight-ring', type: 'circle', source: 'search-highlight',
        paint: { 'circle-radius': 16, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#FFD54F', 'circle-stroke-width': 2.5, 'circle-stroke-opacity': 0.9 } });
    }
    (map.getSource('search-highlight') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [highlight.lng, highlight.lat] }, properties: {} }],
    });

    if (highlightRaf.current) cancelAnimationFrame(highlightRaf.current);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    const start = performance.now();
    const tick = (now: number) => {
      const t = ((now - start) / 1400) % 1; // 1.4s expanding-ring loop
      if (map.getLayer('search-highlight-ring')) {
        map.setPaintProperty('search-highlight-ring', 'circle-radius', 16 + t * 40);
        map.setPaintProperty('search-highlight-ring', 'circle-stroke-opacity', 0.9 * (1 - t));
      }
      highlightRaf.current = requestAnimationFrame(tick);
    };
    highlightRaf.current = requestAnimationFrame(tick);
    highlightTimer.current = setTimeout(() => {
      if (highlightRaf.current) cancelAnimationFrame(highlightRaf.current);
      if (map.getSource('search-highlight')) (map.getSource('search-highlight') as maplibregl.GeoJSONSource).setData(EMPTY_FC);
    }, 4200);

    return () => {
      if (highlightRaf.current) cancelAnimationFrame(highlightRaf.current);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    };
  }, [mapReady, highlight]);

  // Dynamic projection switching (lightweight — no terrain DEM)
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    try {
      (map as any).setProjection({ type: projection });
      if (projection === 'globe') {
        map.easeTo({ pitch: 20, duration: 1200 });
        try {
          (map as any).setSky({
            'sky-color': '#04040A',
            'sky-horizon-blend': 0.5,
            'horizon-color': '#0a0a1a',
            'horizon-fog-blend': 0.3,
            'fog-color': '#04040A',
            'fog-ground-blend': 0.9,
          });
        } catch (e) { console.warn('[OSIRIS] Suppressed error:', e instanceof Error ? e.message : e); }
      } else {
        map.easeTo({ pitch: 0, duration: 800 });
      }
    } catch (e) {
      console.warn('Projection switch failed:', e);
    }
  }, [mapReady, projection]);

  // Satellite / Dark style switching
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    if (mapStyle === prevStyleRef.current) return;
    prevStyleRef.current = mapStyle;
    const map = mapRef.current;

    try {
      if (mapStyle !== 'dark') {
        // Add satellite raster tiles
        if (!map.getSource('satellite-tiles')) {
          map.addSource('satellite-tiles', {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            maxzoom: 18,
          });
          map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite-tiles', paint: { 'raster-opacity': 0.85 } }, 'day-night-fill');
        } else {
          map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
        }
      } else {
        if (map.getLayer('satellite-layer')) {
          map.setLayoutProperty('satellite-layer', 'visibility', 'none');
        }
      }
    } catch (e) {
      console.warn('Style switch failed:', e);
    }
  }, [mapReady, mapStyle]);

  return (
    <div className="absolute inset-0 w-full h-full">
      <div ref={containerRef} className="absolute inset-0 w-full h-full" />
      {/* OSM attribution required by ODbL for ukraine-railways.geojson */}
      <div className="absolute bottom-1 right-1 z-10 pointer-events-none"
        style={{ fontSize: '9px', fontFamily: 'monospace', color: 'rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.45)', padding: '1px 5px', borderRadius: '3px' }}>
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer"
          style={{ color: 'rgba(255,255,255,0.45)', pointerEvents: 'auto' }}>OpenStreetMap contributors</a> (ODbL)
      </div>
    </div>
  );
}

export default memo(OsirisMap);
