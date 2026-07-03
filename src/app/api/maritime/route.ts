import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { flagFromMmsi } from '@/lib/mmsi-flags';
import { getShadowFleetImos, getShadowFleetMmsis } from '@/lib/shadowFleet';

export const dynamic = 'force-dynamic';

// Learned sanctioned-MMSI set is persisted here so a server restart doesn't
// blind the shadow-fleet layer. IMO↔MMSI links are learned from the infrequent
// type-5 ShipStaticData message; without persistence they'd take hours to
// re-accumulate after every restart.
const SHADOW_STATE_DIR = path.join(os.homedir(), '.osiris-data');
const SHADOW_STATE_FILE = path.join(SHADOW_STATE_DIR, 'shadow-mmsi.json');
const SHIPS_CACHE_FILE = path.join(SHADOW_STATE_DIR, 'ships-cache.json');

// Shadow-fleet track ring-buffer constants.
// 288 samples at 5-min intervals = 24h of positions per vessel.
const TRACK_MAX = 288;
const TRACK_SAMPLE_MS = 5 * 60 * 1000;
const TRACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SHADOW_TRACKS_FILE = path.join(SHADOW_STATE_DIR, 'shadow-fleet-tracks.json');
// 50 knots ≈ 92.6 km/h — far above any surface vessel; used to reject ghost positions.
const MAX_SHIP_KPH = 92.6;

function trackDistKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Walk a position array and drop any point that would require superhuman speed
// from the previous accepted point. Handles both stale disk data and AIS glitches.
function stripGhostPositions(positions: { ts: number; lat: number; lng: number }[]): { ts: number; lat: number; lng: number }[] {
  if (positions.length < 2) return positions;
  const sorted = [...positions].sort((a, b) => a.ts - b.ts);
  const clean = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = clean[clean.length - 1];
    const curr = sorted[i];
    const dtH = (curr.ts - prev.ts) / 3_600_000;
    if (dtH <= 0) continue;
    const distKm = trackDistKm(prev.lat, prev.lng, curr.lat, curr.lng);
    if (distKm / dtH <= MAX_SHIP_KPH) clean.push(curr);
  }
  return clean;
}

/**
 * OSIRIS — Maritime Intelligence
 * Real-time AIS vessel tracking via aisstream.io + Static global ports.
 */

const PORTS = [
  // ── Top Container Ports ──
  { name: 'Shanghai', country: 'CN', lat: 31.23, lng: 121.47, type: 'container', volume: '47.3M TEU', rank: 1 },
  { name: 'Singapore', country: 'SG', lat: 1.26, lng: 103.84, type: 'container', volume: '37.2M TEU', rank: 2 },
  { name: 'Ningbo-Zhoushan', country: 'CN', lat: 29.87, lng: 121.55, type: 'container', volume: '33.3M TEU', rank: 3 },
  { name: 'Shenzhen', country: 'CN', lat: 22.54, lng: 114.05, type: 'container', volume: '30.0M TEU', rank: 4 },
  { name: 'Guangzhou', country: 'CN', lat: 23.08, lng: 113.32, type: 'container', volume: '24.2M TEU', rank: 5 },
  { name: 'Busan', country: 'KR', lat: 35.10, lng: 129.04, type: 'container', volume: '22.7M TEU', rank: 6 },
  { name: 'Qingdao', country: 'CN', lat: 36.07, lng: 120.38, type: 'container', volume: '22.0M TEU', rank: 7 },
  { name: 'Rotterdam', country: 'NL', lat: 51.90, lng: 4.50, type: 'container', volume: '14.5M TEU', rank: 8 },
  { name: 'Tokyo', country: 'JP', lat: 35.61, lng: 139.79, type: 'container', volume: '4.5M TEU' },
  { name: 'Yokohama', country: 'JP', lat: 35.45, lng: 139.66, type: 'container', volume: '2.9M TEU' },
  { name: 'Kobe', country: 'JP', lat: 34.67, lng: 135.21, type: 'container', volume: '2.8M TEU' },
  { name: 'Nagoya', country: 'JP', lat: 35.08, lng: 136.87, type: 'container', volume: '2.6M TEU' },
  { name: 'Osaka', country: 'JP', lat: 34.63, lng: 135.41, type: 'container', volume: '2.1M TEU' },
  { name: 'Hakata (Fukuoka)', country: 'JP', lat: 33.60, lng: 130.40, type: 'container', volume: '0.9M TEU' },
  { name: 'Kitakyushu', country: 'JP', lat: 33.91, lng: 130.93, type: 'container', volume: '0.5M TEU' },
  { name: 'Shimizu', country: 'JP', lat: 35.00, lng: 138.50, type: 'container', volume: '0.5M TEU' },
  { name: 'Tomakomai', country: 'JP', lat: 42.63, lng: 141.63, type: 'container', volume: '0.4M TEU' },
  { name: 'Niigata', country: 'JP', lat: 37.95, lng: 139.06, type: 'container', volume: '0.2M TEU' },
  { name: 'Sendai', country: 'JP', lat: 38.27, lng: 141.02, type: 'container', volume: '0.2M TEU' },
  { name: 'Mizushima', country: 'JP', lat: 34.50, lng: 133.72, type: 'energy', volume: 'Industrial' },
  { name: 'Yokkaichi', country: 'JP', lat: 34.95, lng: 136.65, type: 'energy', volume: 'Industrial' },
  { name: 'Dubai (Jebel Ali)', country: 'AE', lat: 25.01, lng: 55.06, type: 'container', volume: '14.0M TEU', rank: 9 },
  { name: 'Port Klang', country: 'MY', lat: 2.99, lng: 101.39, type: 'container', volume: '13.2M TEU', rank: 10 },
  { name: 'Antwerp', country: 'BE', lat: 51.30, lng: 4.40, type: 'container', volume: '12.0M TEU', rank: 11 },
  { name: 'Xiamen', country: 'CN', lat: 24.48, lng: 118.09, type: 'container', volume: '11.4M TEU', rank: 12 },
  { name: 'Hamburg', country: 'DE', lat: 53.55, lng: 9.97, type: 'container', volume: '8.7M TEU', rank: 14 },
  { name: 'Los Angeles', country: 'US', lat: 33.74, lng: -118.27, type: 'container', volume: '9.9M TEU', rank: 13 },
  { name: 'Long Beach', country: 'US', lat: 33.75, lng: -118.19, type: 'container', volume: '8.0M TEU', rank: 15 },
  { name: 'Tanjung Pelepas', country: 'MY', lat: 1.36, lng: 103.55, type: 'container', volume: '9.8M TEU', rank: 16 },
  { name: 'Savannah', country: 'US', lat: 32.08, lng: -81.09, type: 'container', volume: '5.6M TEU', rank: 20 },
  { name: 'Felixstowe', country: 'GB', lat: 51.96, lng: 1.35, type: 'container', volume: '3.8M TEU', rank: 25 },
  { name: 'Santos', country: 'BR', lat: -23.95, lng: -46.31, type: 'container', volume: '4.2M TEU', rank: 22 },
  { name: 'Colombo', country: 'LK', lat: 6.94, lng: 79.84, type: 'container', volume: '7.2M TEU', rank: 17 },

  // ── Energy/Oil Ports ──
  { name: 'Ras Tanura', country: 'SA', lat: 26.64, lng: 50.16, type: 'energy', volume: '6.5M bpd' },
  { name: 'Fujairah', country: 'AE', lat: 25.14, lng: 56.35, type: 'energy', volume: '3.5M bpd' },
  { name: 'Novorossiysk', country: 'RU', lat: 44.72, lng: 37.77, type: 'energy', volume: '2.8M bpd' },
  { name: 'Houston Ship Channel', country: 'US', lat: 29.73, lng: -95.27, type: 'energy', volume: '2.5M bpd' },
  { name: 'Kharg Island', country: 'IR', lat: 29.24, lng: 50.33, type: 'energy', volume: '2.0M bpd' },
  { name: 'Primorsk', country: 'RU', lat: 60.35, lng: 28.70, type: 'energy', volume: '1.6M bpd' },

  // ── Ukraine / Black Sea (grain corridor + conflict zone) ──
  { name: 'Reni', country: 'UA', lat: 45.450, lng: 28.270, type: 'port', volume: 'Grain corridor' },
  { name: 'Izmail', country: 'UA', lat: 45.349, lng: 28.838, type: 'port', volume: 'Grain corridor' },
  { name: 'Kiliya', country: 'UA', lat: 45.448, lng: 29.268, type: 'port', volume: 'Grain corridor' },
  { name: 'Odesa', country: 'UA', lat: 46.482, lng: 30.723, type: 'port', volume: 'Strategic Black Sea' },
  { name: 'Chornomorsk', country: 'UA', lat: 46.302, lng: 30.657, type: 'port', volume: 'Grain export' },

  // ── Major Naval Bases ──
  { name: 'Norfolk Naval Station', country: 'US', lat: 36.95, lng: -76.33, type: 'naval', fleet: 'US Atlantic Fleet' },
  { name: 'San Diego Naval Base', country: 'US', lat: 32.69, lng: -117.15, type: 'naval', fleet: 'US Pacific Fleet' },
  { name: 'Pearl Harbor', country: 'US', lat: 21.35, lng: -157.97, type: 'naval', fleet: 'US Pacific Fleet' },
  { name: 'Yokosuka', country: 'JP', lat: 35.28, lng: 139.67, type: 'naval', fleet: 'US 7th Fleet' },
  { name: 'Severomorsk', country: 'RU', lat: 69.07, lng: 33.42, type: 'naval', fleet: 'Russian Northern Fleet' },
  { name: 'Tartus', country: 'SY', lat: 34.89, lng: 35.89, type: 'naval', fleet: 'Russian Mediterranean' },
  { name: 'Zhanjiang', country: 'CN', lat: 21.20, lng: 110.39, type: 'naval', fleet: 'PLA Navy South Sea Fleet' },
  { name: 'Qingdao Naval', country: 'CN', lat: 36.09, lng: 120.43, type: 'naval', fleet: 'PLA Navy North Sea Fleet' },
  { name: 'Portsmouth', country: 'GB', lat: 50.80, lng: -1.11, type: 'naval', fleet: 'Royal Navy' },
  { name: 'Toulon', country: 'FR', lat: 43.12, lng: 5.93, type: 'naval', fleet: 'French Navy Mediterranean' },
  { name: 'Changi Naval Base', country: 'SG', lat: 1.33, lng: 104.01, type: 'naval', fleet: 'Republic of Singapore Navy' },
  { name: 'Visakhapatnam', country: 'IN', lat: 17.69, lng: 83.30, type: 'naval', fleet: 'Indian Navy Eastern Command' },
  { name: 'Mumbai Naval', country: 'IN', lat: 18.93, lng: 72.84, type: 'naval', fleet: 'Indian Navy Western Command' },
  { name: 'Novorossiysk (Black Sea Fleet)', country: 'RU', lat: 44.724, lng: 37.769, type: 'naval', fleet: 'Russian Black Sea Fleet (relocated from Sevastopol)' },
];

interface Chokepoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_km: number;
  traffic: string;
  baseline_risk: string;
}

const CHOKEPOINTS: Chokepoint[] = [
  { id: 'hormuz',            name: 'Strait of Hormuz',       lat: 26.5,   lng: 56.5,   radius_km: 80,  traffic: '21M bpd oil',          baseline_risk: 'HIGH' },
  { id: 'bab_el_mandeb',     name: 'Bab el-Mandeb',          lat: 12.6,   lng: 43.4,   radius_km: 60,  traffic: '6.2M bpd oil',          baseline_risk: 'HIGH' },
  { id: 'suez_north',        name: 'Suez Canal (North)',      lat: 30.7,   lng: 32.3,   radius_km: 30,  traffic: '12% world trade (N)',    baseline_risk: 'MODERATE' },
  { id: 'suez_south',        name: 'Suez Canal (South)',      lat: 29.9,   lng: 32.6,   radius_km: 30,  traffic: '12% world trade (S)',    baseline_risk: 'MODERATE' },
  { id: 'malacca',           name: 'Strait of Malacca',       lat: 2.5,    lng: 102.0,  radius_km: 100, traffic: '16M bpd oil',           baseline_risk: 'MODERATE' },
  { id: 'gibraltar',         name: 'Strait of Gibraltar',     lat: 35.9,   lng: -5.4,   radius_km: 40,  traffic: 'Med–Atlantic gateway',  baseline_risk: 'LOW' },
  { id: 'dover',             name: 'Dover Strait',            lat: 51.0,   lng: 1.5,    radius_km: 40,  traffic: 'Busiest shipping lane',  baseline_risk: 'LOW' },
  { id: 'oresund',           name: 'Øresund (Danish Str.)',   lat: 55.6,   lng: 12.7,   radius_km: 30,  traffic: '3.2M bpd oil',          baseline_risk: 'LOW' },
  { id: 'kerch',             name: 'Kerch Strait',            lat: 45.3,   lng: 36.5,   radius_km: 30,  traffic: 'Black Sea–Azov transit', baseline_risk: 'HIGH' },
  { id: 'bosphorus',         name: 'Bosphorus',               lat: 41.1,   lng: 29.0,   radius_km: 20,  traffic: '3M bpd oil',            baseline_risk: 'MODERATE' },
  { id: 'dardanelles',       name: 'Dardanelles',             lat: 40.2,   lng: 26.4,   radius_km: 20,  traffic: 'Black Sea gateway',      baseline_risk: 'MODERATE' },
  { id: 'panama',            name: 'Panama Canal',            lat: 9.1,    lng: -79.7,  radius_km: 30,  traffic: '5% world trade',         baseline_risk: 'LOW' },
  { id: 'lombok',            name: 'Lombok Strait',           lat: -8.5,   lng: 115.7,  radius_km: 40,  traffic: 'Alt Malacca',            baseline_risk: 'LOW' },
  { id: 'sunda',             name: 'Sunda Strait',            lat: -6.0,   lng: 105.8,  radius_km: 40,  traffic: 'Alt Malacca (minor)',    baseline_risk: 'LOW' },
  { id: 'taiwan',            name: 'Taiwan Strait',           lat: 24.5,   lng: 119.5,  radius_km: 80,  traffic: '88% large ships',        baseline_risk: 'MODERATE' },
  { id: 'korea',             name: 'Korea Strait',            lat: 34.6,   lng: 129.3,  radius_km: 60,  traffic: 'Japan Sea gateway',      baseline_risk: 'LOW' },
  { id: 'luzon',             name: 'Luzon Strait',            lat: 20.0,   lng: 121.5,  radius_km: 80,  traffic: 'Pacific–S.China Sea',    baseline_risk: 'LOW' },
  { id: 'cape_good_hope',    name: 'Cape of Good Hope',       lat: -34.2,  lng: 18.5,   radius_km: 60,  traffic: 'Alt route Suez',         baseline_risk: 'LOW' },
  { id: 'mozambique',        name: 'Mozambique Channel',      lat: -17.0,  lng: 41.0,   radius_km: 120, traffic: 'E.Africa tanker route',  baseline_risk: 'LOW' },
];

// Shadow-fleet IMO watchlist is sourced dynamically — see src/lib/shadowFleet.ts.
// getShadowFleetImos() returns the current set synchronously and refreshes in the
// background on a TTL, so the hot AIS message handler below never blocks.

// --- Global AIS Stream Client (In-Memory Cache) ---
// Note: In a true serverless environment, this state would reset per invocation.
// For Next.js dev server or Node.js Docker container, this will persist.

interface Ship {
  id: number;
  mmsi: number;
  timestamp: number;
  lat: number;
  lng: number;
  speed: number;
  heading?: number;
  name?: string;
  destination?: string;
  type?: string;
  flag?: string | null;
  flag_emoji?: string | null;
  shadow_fleet?: boolean;
}

const globalForAis = globalThis as unknown as {
  shipsCache: Map<number, Ship>;
  isAisConnecting: boolean;
  // MMSI→shadow-fleet sticky set. AIS broadcasts IMO only in the infrequent
  // ShipStaticData (type-5) message, while position is in the frequent type-1/2/3
  // reports. Recording the MMSI here the moment we see a sanctioned IMO means the
  // flag survives even if that static message arrives before any position fix
  // (and is therefore dropped by the lat/lng store guard), and stays attached
  // across the ship's subsequent position-only updates.
  shadowMmsi: Set<number>;
  // Throttle handle for the debounced disk-write of shadowMmsi.
  shadowSaveTimer: ReturnType<typeof setTimeout> | null;
  // 24h position ring-buffer per shadow-fleet vessel (sampled at TRACK_SAMPLE_MS).
  shadowTracks: Map<number, { ts: number; lat: number; lng: number }[]>;
  // Throttle handle for the debounced disk-write of shadowTracks.
  tracksSaveTimer: ReturnType<typeof setTimeout> | null;
  // Diagnostic: total messages received from the AIS WebSocket since last init.
  aisMessageCount: number;
  // Timestamp of the last received aisstream.io message (null = never since restart).
  lastAisMessageAt: number | null;
  // VesselAPI fallback — REST AIS sweep when aisstream is silent.
  vesselApiLastFetch: number;
  vesselApiCallsToday: number;
  vesselApiCallsResetAt: number;
  vesselApiTimer: ReturnType<typeof setTimeout> | null;
  // GFW identity enrichment cache: MMSI → {flag ISO-3, imo, name, fetchedAt}.
  gfwEnrichment: Map<number, { flag?: string; imo?: string; name?: string; fetchedAt: number }>;
  gfwEnrichTimer: ReturnType<typeof setTimeout> | null;
};

function nextMidnightUtc(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

if (!globalForAis.shipsCache) {
  globalForAis.shipsCache = new Map();
  globalForAis.isAisConnecting = false;
  globalForAis.shadowMmsi = new Set();
  globalForAis.shadowSaveTimer = null;
  globalForAis.shadowTracks = new Map();
  globalForAis.tracksSaveTimer = null;
  globalForAis.aisMessageCount = 0;
  globalForAis.lastAisMessageAt = null;
  globalForAis.vesselApiLastFetch = 0;
  globalForAis.vesselApiCallsToday = 0;
  globalForAis.vesselApiCallsResetAt = nextMidnightUtc();
  globalForAis.vesselApiTimer = null;
  globalForAis.gfwEnrichment = new Map();
  globalForAis.gfwEnrichTimer = null;
  // Best-effort restore of the learned sanctioned-MMSI set. Mutates the same
  // Set the `shadowMmsi` const below references, so additions land in it.
  fs.readFile(SHADOW_STATE_FILE, 'utf8')
    .then((txt) => {
      const arr: unknown = JSON.parse(txt);
      if (Array.isArray(arr)) {
        for (const m of arr) if (typeof m === 'number') globalForAis.shadowMmsi.add(m);
        console.log(`[OSIRIS] shadow-fleet: restored ${globalForAis.shadowMmsi.size} learned MMSIs from disk`);
      }
    })
    .catch(() => {/* no prior state — start empty */});
  // Restore last-known ship positions from disk so the layer is immediately
  // populated on startup — shadow fleet vessels show right away, and regular
  // ships appear as stale until the AIS stream refreshes them.
  fs.readFile(SHIPS_CACHE_FILE, 'utf8')
    .then((txt) => {
      const arr: unknown = JSON.parse(txt);
      if (Array.isArray(arr)) {
        let count = 0;
        for (const ship of arr) {
          if (ship && typeof (ship as Ship).mmsi === 'number') {
            globalForAis.shipsCache.set((ship as Ship).mmsi, ship as Ship);
            count++;
          }
        }
        console.log(`[OSIRIS] ships-cache: restored ${count} vessels from disk`);
      }
    })
    .catch(() => {/* no prior snapshot — starts empty, fills from AIS stream */});

  // Persist the full ship cache every 5 minutes so restarts can recover quickly.
  setInterval(async () => {
    const ships = Array.from(globalForAis.shipsCache.values());
    if (ships.length === 0) return;
    try {
      await fs.mkdir(SHADOW_STATE_DIR, { recursive: true });
      await fs.writeFile(SHIPS_CACHE_FILE, JSON.stringify(ships), 'utf8');
    } catch {/* best-effort */}
  }, 5 * 60 * 1000);


  // Best-effort restore of the 24h position ring-buffers. Drops entries older
  // than TRACK_MAX_AGE_MS so a stale snapshot doesn't show ancient tracks.
  fs.readFile(SHADOW_TRACKS_FILE, 'utf8')
    .then((txt) => {
      const arr: unknown = JSON.parse(txt);
      if (!Array.isArray(arr)) return;
      const cutoff = Date.now() - TRACK_MAX_AGE_MS;
      let restored = 0;
      for (const entry of arr) {
        if (typeof entry?.mmsi !== 'number' || !Array.isArray(entry?.positions)) continue;
        const fresh = stripGhostPositions(
          (entry.positions as { ts: number; lat: number; lng: number }[]).filter(p => p.ts >= cutoff)
        );
        if (fresh.length > 0) {
          globalForAis.shadowTracks.set(entry.mmsi, fresh);
          restored++;
        }
      }
      if (restored > 0) console.log(`[OSIRIS] shadow-fleet-tracks: restored ${restored} vessel tracks from disk`);
    })
    .catch(() => {/* no prior state — start empty */});
}

const shipsCache = globalForAis.shipsCache;
const shadowMmsi = globalForAis.shadowMmsi;
const shadowTracks = globalForAis.shadowTracks;

// Persist the learned MMSI set, coalescing bursts into at most one write / 10s.
function persistShadowMmsi() {
  if (globalForAis.shadowSaveTimer) return;
  globalForAis.shadowSaveTimer = setTimeout(async () => {
    globalForAis.shadowSaveTimer = null;
    try {
      await fs.mkdir(SHADOW_STATE_DIR, { recursive: true });
      await fs.writeFile(SHADOW_STATE_FILE, JSON.stringify([...shadowMmsi]), 'utf8');
    } catch {/* best-effort — losing the cache only costs re-accumulation */}
  }, 10000);
}

// Persist the 24h position ring-buffers, coalescing bursts into at most one write / 10s.
function persistShadowTracks() {
  if (globalForAis.tracksSaveTimer) return;
  globalForAis.tracksSaveTimer = setTimeout(async () => {
    globalForAis.tracksSaveTimer = null;
    try {
      await fs.mkdir(SHADOW_STATE_DIR, { recursive: true });
      const payload = [...shadowTracks].map(([mmsi, positions]) => ({ mmsi, positions }));
      await fs.writeFile(SHADOW_TRACKS_FILE, JSON.stringify(payload), 'utf8');
    } catch {/* best-effort — losing the cache only costs a gap in the track trail */}
  }, 10000);
}

function connectAisStream() {
  if (globalForAis.isAisConnecting) return;
  const apiKey = process.env.AIS_API_KEY;
  if (!apiKey) return;

  globalForAis.isAisConnecting = true;
  let ws: WebSocket;

  try {
    ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
  } catch {
    globalForAis.isAisConnecting = false;
    return;
  }

  ws.on("open", () => {
    globalForAis.isAisConnecting = false;
    const subscriptionMessage = {
      APIKey: apiKey,
      // Target specific high-value SCM areas to ensure data delivery on free tier
      BoundingBoxes: [
        // Tokyo Bay
        [[34.8, 139.5], [35.7, 140.2]],
        // Hormuz
        [[25.0, 54.0], [27.5, 57.5]],
        // Suez Canal
        [[27.0, 32.0], [32.0, 33.5]],
        // Bab el-Mandeb
        [[12.0, 42.5], [14.0, 44.0]],
        // Panama Canal
        [[8.0, -80.5], [10.0, -79.0]],
        // Malacca / Singapore
        [[1.0, 103.0], [3.0, 104.5]],
        // Taiwan Strait
        [[22.0, 118.0], [26.0, 121.0]],
        // Black Sea + Sea of Azov + Bosphorus mouth (Ukraine theatre: Odesa,
        // Crimea, Kerch Strait, grain corridor, shadow-fleet tankers)
        [[41.0, 27.0], [47.5, 42.0]],
        // Rotterdam / English Channel
        [[50.0, 0.0], [53.0, 5.0]],
        // US West Coast (LA/LB)
        [[33.0, -119.0], [34.5, -117.0]],
        // Global fallback (often heavily sampled by aisstream)
        [[-90, -180], [90, 180]]
      ],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"]
    };
    ws.send(JSON.stringify(subscriptionMessage));
  });

  // Map AIS ship types to OSIRIS categories
  const getOsirisShipType = (typeCode: number) => {
    if (!typeCode) return 'cargo';
    if (typeCode >= 80 && typeCode <= 89) return 'tanker';
    if (typeCode >= 70 && typeCode <= 79) return 'cargo';
    if (typeCode === 35) return 'military';
    return 'cargo';
  };

  ws.on("message", (data) => {
    globalForAis.aisMessageCount++;
    globalForAis.lastAisMessageAt = Date.now();
    try {
      const parsed = JSON.parse(data.toString());
      const mmsi = parsed.MetaData?.MMSI;
      if (!mmsi) return;

      const existing: Ship = shipsCache.get(mmsi) ?? {
        id: mmsi, mmsi, timestamp: Date.now(), lat: 0, lng: 0, speed: 0,
      };

      // Primary shadow-fleet match: MMSI rides on EVERY message (incl. position
      // reports), so a sanctioned MMSI flags the vessel immediately — no need to
      // wait for the infrequent ShipStaticData/IMO message below.
      if (getShadowFleetMmsis().has(mmsi) && !shadowMmsi.has(mmsi)) {
        shadowMmsi.add(mmsi);
        persistShadowMmsi();
      }

      // Extract Name from MetaData if available (present in most messages)
      if (parsed.MetaData?.ShipName) {
        existing.name = parsed.MetaData.ShipName.trim();
      }

      if (parsed.MessageType === "PositionReport" && parsed.Message?.PositionReport) {
        const report = parsed.Message.PositionReport;
        existing.lat = report.Latitude;
        existing.lng = report.Longitude;
        existing.speed = report.Sog;
        existing.heading = report.TrueHeading || report.Cog;
        existing.timestamp = Date.now();

        // Append to the 24h ring-buffer for shadow-fleet vessels only.
        // Sample at most once per TRACK_SAMPLE_MS to avoid storing thousands
        // of near-duplicate positions from vessels that broadcast every 2–10s.
        if (shadowMmsi.has(mmsi)) {
          const track = shadowTracks.get(mmsi) ?? [];
          const now = Date.now();
          if (track.length === 0 || now - track[track.length - 1].ts >= TRACK_SAMPLE_MS) {
            const newLat = report.Latitude;
            const newLng = report.Longitude;
            if (typeof newLat !== 'number' || isNaN(newLat) || newLat < -90 || newLat > 90 ||
                typeof newLng !== 'number' || isNaN(newLng) || newLng < -180 || newLng > 180) {
              // skip — invalid GPS fix
            // Reject ghost positions: if the implied speed from the last recorded
            // point exceeds MAX_SHIP_KPH the new fix is a GPS artifact, not movement.
            } else if (track.length > 0) {
              const prev = track[track.length - 1];
              const dtH = (now - prev.ts) / 3_600_000;
              const distKm = trackDistKm(prev.lat, prev.lng, newLat, newLng);
              if (dtH > 0 && distKm / dtH > MAX_SHIP_KPH) {
                // skip — bad GPS fix
              } else {
                track.push({ ts: now, lat: newLat, lng: newLng });
              }
            } else {
              track.push({ ts: now, lat: newLat, lng: newLng });
            }
            if (track.length > TRACK_MAX) track.splice(0, track.length - TRACK_MAX);
            // Trim entries older than 24h.
            const cutoff = now - TRACK_MAX_AGE_MS;
            let i = 0; while (i < track.length && track[i].ts < cutoff) i++;
            if (i > 0) track.splice(0, i);
            shadowTracks.set(mmsi, track);
            persistShadowTracks();
          }
        }
      }
      else if (parsed.MessageType === "ShipStaticData" && parsed.Message?.ShipStaticData) {
        const staticData = parsed.Message.ShipStaticData;
        existing.name = staticData.Name ? staticData.Name.trim() : existing.name;
        existing.destination = staticData.Destination ? staticData.Destination.trim() : existing.destination;
        existing.type = getOsirisShipType(staticData.Type);
        // Cross-reference against the dynamic shadow-fleet watchlist (IMO is only
        // available in ShipStaticData). Record the MMSI in the sticky set so the
        // flag is not lost if this message precedes the first position fix.
        if (staticData.ImoNumber && getShadowFleetImos().has(staticData.ImoNumber) && !shadowMmsi.has(mmsi)) {
          shadowMmsi.add(mmsi);
          persistShadowMmsi();
        }
      }

      // Re-attach the sticky shadow-fleet flag on every update (covers the case
      // where the static/IMO message was received in an earlier update).
      existing.shadow_fleet = shadowMmsi.has(mmsi);

      // Only store if we have coordinates
      if (existing.lat && existing.lng) {
        shipsCache.set(mmsi, existing);
      }

      // Limit cache size to prevent memory leak (allow up to 20,000 ships)
      if (shipsCache.size > 20000) {
        const firstKey = shipsCache.keys().next().value;
        if (firstKey) shipsCache.delete(firstKey);
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on("close", () => {
    globalForAis.isAisConnecting = false;
    setTimeout(connectAisStream, 5000); // Reconnect
  });

  ws.on("error", () => {
    ws.close();
  });
}

// Start connection process asynchronously
connectAisStream();

// ── VesselAPI Fallback ────────────────────────────────────────────────────────
// REST AIS sweep when aisstream.io has been silent for >30 min.
// Budget: 150 calls/month free → 6 zones × 1 call each → ~25 sweeps/month → every ~29h.
// |dLat|+|dLon| ≤ 4° hard limit per box (API rejects larger spans).

const VESSEL_API_ZONES = [
  // Ukraine/Russia war corridor (top priority)
  { name: 'Odessa Corridor', latBottom: 46, latTop: 48, lonLeft: 30, lonRight: 32 },
  { name: 'Black Sea NW',    latBottom: 43, latTop: 45, lonLeft: 30, lonRight: 32 },
  { name: 'Kerch / Azov',    latBottom: 45, latTop: 47, lonLeft: 35, lonRight: 37 },
  { name: 'Bosphorus',       latBottom: 40, latTop: 42, lonLeft: 28, lonRight: 30 },
  // Shadow fleet export routes
  { name: 'Hormuz',          latBottom: 25, latTop: 27, lonLeft: 56, lonRight: 58 },
  { name: 'Malacca',         latBottom:  1, latTop:  3, lonLeft: 103, lonRight: 105 },
];
const VESSEL_API_DAILY_CAP = 6;
const VESSEL_API_REFRESH_MS = 29 * 60 * 60 * 1000;

interface VesselApiRaw {
  mmsi?: number; MMSI?: number;
  name?: string; vesselName?: string; shipName?: string;
  lat?: number; latitude?: number;
  lon?: number; lng?: number; longitude?: number;
  sog?: number; speed?: number;
  cog?: number; heading?: number; trueHeading?: number;
}

async function vesselApiFetchPage(
  latBottom: number, latTop: number, lonLeft: number, lonRight: number,
  nextToken?: string
): Promise<{ ships: VesselApiRaw[]; nextToken?: string; split?: boolean }> {
  const key = process.env.VESSEL_API_KEY;
  if (!key) return { ships: [] };
  const p = new URLSearchParams({
    'filter.latBottom': String(latBottom), 'filter.latTop': String(latTop),
    'filter.lonLeft': String(lonLeft),     'filter.lonRight': String(lonRight),
    'pagination.limit': '50',
  });
  if (nextToken) p.set('pagination.nextToken', nextToken);
  const res = await fetch(`https://api.vesselapi.com/v1/location/vessels/bounding-box?${p}`,
    { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  if (res.status === 400) {
    const body = await res.json().catch(() => ({}));
    const code: string = body?.error?.code ?? body?.code ?? '';
    if (code === 'bounding_box_too_dense' || code === 'invalid_parameter') return { ships: [], split: true };
    return { ships: [] };
  }
  if (!res.ok) return { ships: [] };
  const json = await res.json();
  const ships: VesselApiRaw[] = json?.data ?? json?.vessels ?? [];
  const next: string | undefined = json?.pagination?.nextToken ?? json?.nextToken;
  return { ships, nextToken: next };
}

async function vesselApiFetchBox(
  latBottom: number, latTop: number, lonLeft: number, lonRight: number,
  budget: { remaining: number }
): Promise<VesselApiRaw[]> {
  if (budget.remaining <= 0) return [];
  budget.remaining--;
  const first = await vesselApiFetchPage(latBottom, latTop, lonLeft, lonRight);
  if (first.split) {
    const dLat = latTop - latBottom, dLon = lonRight - lonLeft;
    if (dLat >= dLon) {
      const mid = (latBottom + latTop) / 2;
      return [...await vesselApiFetchBox(latBottom, mid, lonLeft, lonRight, budget),
              ...await vesselApiFetchBox(mid, latTop, lonLeft, lonRight, budget)];
    } else {
      const mid = (lonLeft + lonRight) / 2;
      return [...await vesselApiFetchBox(latBottom, latTop, lonLeft, mid, budget),
              ...await vesselApiFetchBox(latBottom, latTop, mid, lonRight, budget)];
    }
  }
  const ships = [...first.ships];
  let cursor = first.nextToken;
  while (cursor && budget.remaining > 0) {
    budget.remaining--;
    const page = await vesselApiFetchPage(latBottom, latTop, lonLeft, lonRight, cursor);
    ships.push(...page.ships);
    cursor = page.nextToken;
  }
  return ships;
}

const VESSEL_API_SILENCE_MS = 30 * 60 * 1000; // 30 min AIS silence before activating fallback

async function runVesselApiSweep() {
  if (!process.env.VESSEL_API_KEY) return;
  // Only run when the live AIS stream has been silent for >30 min. If AIS is
  // healthy there is no reason to spend the REST budget.
  const now = Date.now();
  const lastMsg = globalForAis.lastAisMessageAt;
  if (lastMsg !== null && now - lastMsg < VESSEL_API_SILENCE_MS) return;
  if (now >= globalForAis.vesselApiCallsResetAt) {
    globalForAis.vesselApiCallsToday = 0;
    globalForAis.vesselApiCallsResetAt = nextMidnightUtc();
  }
  const callsLeft = VESSEL_API_DAILY_CAP - globalForAis.vesselApiCallsToday;
  if (callsLeft <= 0) return;
  const budget = { remaining: callsLeft };
  let added = 0;
  for (const zone of VESSEL_API_ZONES) {
    if (budget.remaining <= 0) break;
    const vessels = await vesselApiFetchBox(zone.latBottom, zone.latTop, zone.lonLeft, zone.lonRight, budget);
    for (const v of vessels) {
      const mmsi = v.mmsi ?? v.MMSI;
      const lat = v.lat ?? v.latitude;
      const lng = v.lon ?? v.lng ?? v.longitude;
      if (!mmsi || !lat || !lng) continue;
      const existing = globalForAis.shipsCache.get(mmsi);
      // During an AIS outage, update any ship regardless of source so stale
      // AIS-sourced positions are refreshed. Without this guard removal the
      // fallback can't refresh the very ships it exists to keep current.
      if (!existing || now - existing.timestamp > STALE_MS) {
        globalForAis.shipsCache.set(mmsi, {
          id: mmsi, mmsi, lat, lng,
          speed: v.sog ?? v.speed ?? 0,
          heading: v.cog ?? v.heading ?? v.trueHeading,
          name: (v.name ?? v.vesselName ?? v.shipName ?? '').trim() || undefined,
          timestamp: Date.now(),
          source: 'vesselapi',
        } as Ship & { source: string });
        added++;
      }
    }
  }
  globalForAis.vesselApiCallsToday += callsLeft - budget.remaining;
  globalForAis.vesselApiLastFetch = Date.now();
  console.log(`[OSIRIS] VesselAPI sweep: ${callsLeft - budget.remaining} calls, ${added} ships added`);
}

if (!globalForAis.vesselApiTimer) {
  runVesselApiSweep().catch(() => {});
  globalForAis.vesselApiTimer = setTimeout(function tick() {
    runVesselApiSweep().catch(() => {});
    globalForAis.vesselApiTimer = setTimeout(tick, VESSEL_API_REFRESH_MS);
  }, VESSEL_API_REFRESH_MS);
}

// ── GFW Identity Enrichment ───────────────────────────────────────────────────
// Enriches shadow-fleet ships with registry data from Global Fishing Watch:
// confirmed flag state, IMO number, vessel name (authoritative over AIS self-report).
// Rate: 1 request every 5s — full 370-MMSI shadow fleet enriches in ~30 min.
// Cache TTL: 7 days per entry.

const GFW_ENRICH_FILE = path.join(SHADOW_STATE_DIR, 'gfw-enrichment.json');
const GFW_ENRICH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GFW_ENRICH_INTERVAL_MS = 5000;

// Best-effort restore of GFW enrichment cache from disk.
if (globalForAis.gfwEnrichment.size === 0) {
  fs.readFile(GFW_ENRICH_FILE, 'utf8')
    .then(txt => {
      const arr = JSON.parse(txt) as { mmsi: number; flag?: string; imo?: string; name?: string; fetchedAt: number }[];
      if (!Array.isArray(arr)) return;
      const cutoff = Date.now() - GFW_ENRICH_TTL_MS;
      for (const e of arr) {
        if (typeof e.mmsi === 'number' && e.fetchedAt > cutoff) {
          globalForAis.gfwEnrichment.set(e.mmsi, { flag: e.flag, imo: e.imo, name: e.name, fetchedAt: e.fetchedAt });
        }
      }
    })
    .catch(() => {});
}

async function gfwEnrichNext() {
  const key = process.env.GFW_API_KEY;
  if (!key) return scheduleGfwEnrich();
  // Find next shadow-fleet MMSI that needs enrichment (not yet enriched or stale).
  const cutoff = Date.now() - GFW_ENRICH_TTL_MS;
  let target: number | null = null;
  for (const mmsi of shadowMmsi) {
    const entry = globalForAis.gfwEnrichment.get(mmsi);
    if (!entry || entry.fetchedAt < cutoff) { target = mmsi; break; }
  }
  if (target === null) return scheduleGfwEnrich(); // all current MMSIs enriched
  try {
    const params = new URLSearchParams({
      query: `ssvid:${target}`,
      'datasets[0]': 'public-global-vessel-identity:latest',
      limit: '1',
    });
    const res = await fetch(`https://gateway.api.globalfishingwatch.org/v3/vessels/search?${params}`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const json = await res.json();
      const info = json?.entries?.[0]?.selfReportedInfo?.[0];
      // Always write an entry — even when GFW has no record for this MMSI.
      // Without a sentinel the selection loop re-picks the same MMSI on every
      // 5s tick and enrichment never advances past the first unenrichable vessel.
      const record = info
        ? { flag: info.flag, imo: info.imo ?? undefined, name: info.shipname ?? undefined, fetchedAt: Date.now() }
        : { fetchedAt: Date.now() };
      globalForAis.gfwEnrichment.set(target, record);
      // Persist asynchronously (only when we have substantive identity data)
      if (info) {
        const payload = [...globalForAis.gfwEnrichment.entries()].map(([mmsi, v]) => ({ mmsi, ...v }));
        fs.mkdir(SHADOW_STATE_DIR, { recursive: true })
          .then(() => fs.writeFile(GFW_ENRICH_FILE, JSON.stringify(payload), 'utf8'))
          .catch(() => {});
      }
    }
  } catch { /* best-effort */ }
  scheduleGfwEnrich();
}

function scheduleGfwEnrich() {
  globalForAis.gfwEnrichTimer = setTimeout(gfwEnrichNext, GFW_ENRICH_INTERVAL_MS);
}

if (!globalForAis.gfwEnrichTimer) scheduleGfwEnrich();

// Helper: ISO-3166-1 alpha-3 → flag emoji (covers common shadow-fleet registries).
function iso3ToEmoji(iso3: string): string {
  const map: Record<string, string> = {
    RUS:'🇷🇺', IRN:'🇮🇷', ARE:'🇦🇪', PAN:'🇵🇦', LBR:'🇱🇷', MLT:'🇲🇹', MHL:'🇲🇭',
    VCT:'🇻🇨', TZA:'🇹🇿', GAB:'🇬🇦', CMR:'🇨🇲', COM:'🇰🇲', SLE:'🇸🇱', PLW:'🇵🇼',
    TON:'🇹🇴', BLZ:'🇧🇿', MDV:'🇲🇻', KNA:'🇰🇳', ATG:'🇦🇬', CYP:'🇨🇾',
    CHN:'🇨🇳', KOR:'🇰🇷', GRC:'🇬🇷', NOR:'🇳🇴', JPN:'🇯🇵', SGP:'🇸🇬',
  };
  return map[iso3] ?? '';
}

// Regular vessels expire 10 min after their last AIS report. Shadow-fleet vessels
// are kept indefinitely — going AIS-dark is their signature evasion; last-known
// position is itself intelligence and should not expire until they transmit again.
const STALE_MS = 10 * 60 * 1000;

export async function GET(req: Request) {
  // ?tracks=1 — return the 24h position ring-buffers for shadow-fleet vessels.
  // No stale-cache needed here: the data lives in-process (globalForAis.shadowTracks)
  // and is reconstructed from disk on restart, so it's always as fresh as the WS feed.
  const { searchParams } = new URL(req.url);
  if (searchParams.get('tracks') === '1') {
    const tracks = [...shadowTracks.entries()]
      .filter(([, positions]) => positions.length >= 2)
      .map(([mmsi, positions]) => ({
        mmsi,
        name: shipsCache.get(mmsi)?.name,
        positions,
      }));
    return NextResponse.json(
      { tracks, total: tracks.length, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // ?debug=1 — internal diagnostic: AIS connection + cache state.
  if (searchParams.get('debug') === '1') {
    return NextResponse.json({
      aisMessageCount: globalForAis.aisMessageCount,
      isAisConnecting: globalForAis.isAisConnecting,
      shipsCacheSize: shipsCache.size,
      shadowMmsiSize: shadowMmsi.size,
      shadowTracksSize: shadowTracks.size,
      timestamp: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const now = Date.now();
  for (const [mmsi, ship] of shipsCache.entries()) {
    const isShadow = ship.shadow_fleet || shadowMmsi.has(mmsi);
    const isVesselApi = (ship as any).source === 'vesselapi';
    const ttl = isShadow ? Infinity : isVesselApi ? 25 * 60 * 60 * 1000 : STALE_MS;
    if (ttl !== Infinity && now - ship.timestamp > ttl) shipsCache.delete(mmsi);
  }

  const ships = Array.from(shipsCache.values());

  // Dynamically calculate live traffic (Fast approximation of Haversine)
  const getDistanceKm = (lat1: number, lng1: number, lat2: number, lng2: number) => {
    const dx = (lng1 - lng2) * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    const dy = lat1 - lat2;
    return Math.sqrt(dx * dx + dy * dy) * 111.32;
  };

  const dynamicPorts = PORTS.map(port => {
    let nearbyCount = 0;
    let waitingCount = 0;

    for (let i = 0; i < ships.length; i++) {
      if (getDistanceKm(port.lat, port.lng, ships[i].lat, ships[i].lng) < 50) {
        nearbyCount++;
        // If speed is less than 0.5 knots, consider it anchored/waiting
        if (ships[i].speed < 0.5 && ships[i].type !== 'military') {
          waitingCount++;
        }
      }
    }

    // Heuristic: More than 40% waiting indicates congestion
    const congestionRatio = nearbyCount > 0 ? waitingCount / nearbyCount : 0;
    let congestionStatus = 'NORMAL';
    let estDwellTime = '1-2 Days';
    
    if (congestionRatio > 0.6 || waitingCount > 30) {
      congestionStatus = 'SEVERE';
      estDwellTime = '7+ Days';
    } else if (congestionRatio > 0.4 || waitingCount > 15) {
      congestionStatus = 'CONGESTED';
      estDwellTime = '3-5 Days';
    }

    return {
      ...port,
      volume: `${port.volume} | LIVE: ${nearbyCount} (WAITING: ${waitingCount})`,
      congestion: congestionStatus,
      dwell_time: estDwellTime
    };
  });

  const dynamicChokepoints = CHOKEPOINTS.map(choke => {
    let nearbyCount = 0;
    for (let i = 0; i < ships.length; i++) {
      if (getDistanceKm(choke.lat, choke.lng, ships[i].lat, ships[i].lng) < choke.radius_km) nearbyCount++;
    }

    const RISK_RANK: Record<string, number> = { LOW: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 };
    let risk: string;
    if (nearbyCount === 0)      risk = 'LOW';
    else if (nearbyCount <= 2)  risk = 'MODERATE';
    else if (nearbyCount <= 5)  risk = 'HIGH';
    else                        risk = 'CRITICAL';
    // Floor at baseline: sparse free-AIS coverage must not drag a HIGH strait down to LOW.
    if ((RISK_RANK[risk] ?? 0) < (RISK_RANK[choke.baseline_risk] ?? 0)) risk = choke.baseline_risk;

    return {
      id: choke.id,
      name: choke.name,
      lat: choke.lat,
      lng: choke.lng,
      radius_km: choke.radius_km,
      baseline_risk: choke.baseline_risk,
      traffic: `${choke.traffic} | LIVE SHIPS: ${nearbyCount}`,
      live_ships: nearbyCount,
      risk,
    };
  });

  const lastMsg = globalForAis.lastAisMessageAt;
  const aisLive = lastMsg !== null && (now - lastMsg) < 30 * 60 * 1000;
  const aisStatus = {
    live: aisLive,
    last_message_at: lastMsg ? new Date(lastMsg).toISOString() : null,
    source: aisLive ? 'aisstream' : (globalForAis.vesselApiLastFetch > 0 ? 'vesselapi' : 'cache'),
    vessel_api_last_fetch: globalForAis.vesselApiLastFetch > 0
      ? new Date(globalForAis.vesselApiLastFetch).toISOString() : null,
    vessel_api_calls_today: globalForAis.vesselApiCallsToday,
    gfw_enriched: globalForAis.gfwEnrichment.size,
  };

  // Return the full vessel set — no response cap. Every tracked ship reaches the
  // client/map (cache is still bounded at 20k upstream + the 10-min staleness
  // prune above). Enrich with flag state: GFW authoritative data for shadow fleet,
  // MMSI-derived flag for all others.
  const responseShips = ships.map((s) => {
    const gfw = s.shadow_fleet ? globalForAis.gfwEnrichment.get(s.mmsi) : undefined;
    const f = flagFromMmsi(s.mmsi);
    const gfwEmoji = gfw?.flag ? iso3ToEmoji(gfw.flag) : undefined;
    const minutesSinceUpdate = Math.round((now - s.timestamp) / 60000);
    return {
      ...s,
      flag: gfw?.flag ?? (f ? f.iso : null),
      flag_emoji: gfwEmoji || (f ? f.emoji : null),
      imo: gfw?.imo ?? undefined,
      minutes_since_update: minutesSinceUpdate,
      last_position_at: new Date(s.timestamp).toISOString(),
      stale: minutesSinceUpdate > 10,
    };
  });

  return NextResponse.json({
    ports: dynamicPorts,
    chokepoints: dynamicChokepoints,
    ships: responseShips,
    total_ports: dynamicPorts.length,
    total_chokepoints: dynamicChokepoints.length,
    total_ships: responseShips.length,
    timestamp: new Date().toISOString(),
    ais_status: aisStatus,
  }, {
    headers: { 
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    },
  });
}
