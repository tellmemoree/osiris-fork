import { NextResponse } from 'next/server';
import WebSocket from 'ws';

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
  { name: 'Tianjin', country: 'CN', lat: 39.00, lng: 117.72, type: 'container', volume: '20.3M TEU', rank: 8 },
  { name: 'Hong Kong', country: 'HK', lat: 22.30, lng: 114.13, type: 'container', volume: '14.3M TEU', rank: 10 },
  { name: 'Kaohsiung', country: 'TW', lat: 22.55, lng: 120.30, type: 'container', volume: '9.8M TEU', rank: 18 },
  { name: 'New York / NJ', country: 'US', lat: 40.66, lng: -74.09, type: 'container', volume: '9.5M TEU', rank: 19 },
  { name: 'Tanger Med', country: 'MA', lat: 35.88, lng: -5.50, type: 'container', volume: '7.6M TEU', rank: 21 },
  { name: 'Laem Chabang', country: 'TH', lat: 13.08, lng: 100.88, type: 'container', volume: '8.7M TEU', rank: 23 },
  { name: 'Ho Chi Minh (Cat Lai)', country: 'VN', lat: 10.75, lng: 106.79, type: 'container', volume: '7.9M TEU', rank: 24 },
  { name: 'Mundra', country: 'IN', lat: 22.74, lng: 69.70, type: 'container', volume: '6.6M TEU', rank: 26 },
  { name: 'Jakarta (Tanjung Priok)', country: 'ID', lat: -6.10, lng: 106.88, type: 'container', volume: '6.5M TEU', rank: 27 },
  { name: 'Jawaharlal Nehru', country: 'IN', lat: 18.95, lng: 72.95, type: 'container', volume: '6.4M TEU', rank: 28 },
  { name: 'Valencia', country: 'ES', lat: 39.44, lng: -0.32, type: 'container', volume: '5.6M TEU', rank: 29 },
  { name: 'Piraeus', country: 'GR', lat: 37.94, lng: 23.63, type: 'container', volume: '5.4M TEU', rank: 30 },
  { name: 'Manila', country: 'PH', lat: 14.60, lng: 120.96, type: 'container', volume: '5.3M TEU' },
  { name: 'Algeciras', country: 'ES', lat: 36.13, lng: -5.44, type: 'container', volume: '5.1M TEU' },
  { name: 'Salalah', country: 'OM', lat: 16.95, lng: 54.01, type: 'container', volume: '4.5M TEU' },
  { name: 'Colon', country: 'PA', lat: 9.36, lng: -79.90, type: 'container', volume: '4.3M TEU' },
  { name: 'Port Said', country: 'EG', lat: 31.25, lng: 32.30, type: 'container', volume: '4.0M TEU' },
  { name: 'Bremerhaven', country: 'DE', lat: 53.55, lng: 8.57, type: 'container', volume: '4.6M TEU' },
  { name: 'Vancouver', country: 'CA', lat: 49.29, lng: -123.11, type: 'container', volume: '3.5M TEU' },
  { name: 'Seattle-Tacoma', country: 'US', lat: 47.27, lng: -122.41, type: 'container', volume: '3.4M TEU' },
  { name: 'Manzanillo', country: 'MX', lat: 19.05, lng: -104.31, type: 'container', volume: '3.4M TEU' },
  { name: 'Le Havre', country: 'FR', lat: 49.48, lng: 0.12, type: 'container', volume: '3.0M TEU' },
  { name: 'Barcelona', country: 'ES', lat: 41.35, lng: 2.16, type: 'container', volume: '3.5M TEU' },
  { name: 'Gioia Tauro', country: 'IT', lat: 38.43, lng: 15.90, type: 'container', volume: '3.5M TEU' },
  { name: 'Melbourne', country: 'AU', lat: -37.83, lng: 144.92, type: 'container', volume: '3.3M TEU' },
  { name: 'Durban', country: 'ZA', lat: -29.87, lng: 31.03, type: 'container', volume: '2.9M TEU' },
  { name: 'Gdansk', country: 'PL', lat: 54.40, lng: 18.68, type: 'container', volume: '2.1M TEU' },
  { name: 'Cartagena', country: 'CO', lat: 10.40, lng: -75.52, type: 'container', volume: '3.0M TEU' },
  { name: 'Sydney (Botany)', country: 'AU', lat: -33.97, lng: 151.23, type: 'container', volume: '2.6M TEU' },

  // ── Energy/Oil Ports ──
  { name: 'Ras Tanura', country: 'SA', lat: 26.64, lng: 50.16, type: 'energy', volume: '6.5M bpd' },
  { name: 'Fujairah', country: 'AE', lat: 25.14, lng: 56.35, type: 'energy', volume: '3.5M bpd' },
  { name: 'Novorossiysk', country: 'RU', lat: 44.72, lng: 37.77, type: 'energy', volume: '2.8M bpd' },
  { name: 'Houston Ship Channel', country: 'US', lat: 29.73, lng: -95.27, type: 'energy', volume: '2.5M bpd' },
  { name: 'Kharg Island', country: 'IR', lat: 29.24, lng: 50.33, type: 'energy', volume: '2.0M bpd' },
  { name: 'Primorsk', country: 'RU', lat: 60.35, lng: 28.70, type: 'energy', volume: '1.6M bpd' },

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
];

const CHOKEPOINTS = [
  { name: 'Strait of Hormuz', lat: 26.57, lng: 56.25, traffic: '21M bpd oil', risk: 'HIGH' },
  { name: 'Strait of Malacca', lat: 2.50, lng: 101.50, traffic: '16M bpd oil', risk: 'MODERATE' },
  { name: 'Suez Canal', lat: 30.43, lng: 32.34, traffic: '12% world trade', risk: 'ELEVATED' },
  { name: 'Bab el-Mandeb', lat: 12.58, lng: 43.33, traffic: '6.2M bpd oil', risk: 'CRITICAL' },
  { name: 'Panama Canal', lat: 9.08, lng: -79.68, traffic: '5% world trade', risk: 'LOW' },
  { name: 'Turkish Straits', lat: 41.12, lng: 29.07, traffic: '3M bpd oil', risk: 'MODERATE' },
  { name: 'Danish Straits', lat: 55.70, lng: 12.60, traffic: '3.2M bpd oil', risk: 'LOW' },
  { name: 'Cape of Good Hope', lat: -34.36, lng: 18.47, traffic: 'Alt route Suez', risk: 'LOW' },
  { name: 'Taiwan Strait', lat: 24.00, lng: 119.00, traffic: '88% large ships', risk: 'ELEVATED' },
  { name: 'Lombok Strait', lat: -8.47, lng: 115.72, traffic: 'Alt Malacca', risk: 'LOW' },
];

// --- Global AIS Stream Client (In-Memory Cache) ---
// Note: In a true serverless environment, this state would reset per invocation.
// For Next.js dev server or Node.js Docker container, this will persist.

const globalForAis = globalThis as unknown as {
  shipsCache: Map<number, any>;
  isAisConnecting: boolean;
};

if (!globalForAis.shipsCache) {
  globalForAis.shipsCache = new Map();
  globalForAis.isAisConnecting = false;
}

const shipsCache = globalForAis.shipsCache;

// ── KEYLESS real-time ship source: Digitraffic marine AIS (Finnish Transport
//    Agency). ~18K live vessels across the Baltic/North-Sea approaches, no API
//    key — so the maritime layer is populated even without AIS_API_KEY. The
//    keyed aisstream feed (when configured) adds global chokepoint coverage on
//    top. Both merge by MMSI. ──
function aisTypeToCategory(t: number): string {
  if (t === 35) return 'military';
  if (t >= 80 && t <= 89) return 'tanker';
  if (t >= 70 && t <= 79) return 'cargo';
  if (t >= 60 && t <= 69) return 'passenger';
  if (t >= 40 && t <= 49) return 'hsc';
  if (t >= 30 && t <= 39) return 'fishing';
  return 'other';
}

let dtCache: any[] = [];
let dtCacheAt = 0;
let dtInflight: Promise<any[]> | null = null;
const DT_TTL = 45000;
const DT_HEADERS = { 'Digitraffic-User': 'OSIRIS-OSINT', 'Accept-Encoding': 'gzip' };

async function fetchDigitraffic(): Promise<any[]> {
  if (Date.now() - dtCacheAt < DT_TTL) return dtCache;
  if (dtInflight) return dtInflight;
  dtInflight = (async () => {
    try {
      const [locRes, vesRes] = await Promise.all([
        fetch('https://meri.digitraffic.fi/api/ais/v1/locations', { headers: DT_HEADERS, signal: AbortSignal.timeout(12000) }),
        fetch('https://meri.digitraffic.fi/api/ais/v1/vessels', { headers: DT_HEADERS, signal: AbortSignal.timeout(12000) }),
      ]);
      if (!locRes.ok) return dtCache;
      const loc = await locRes.json();
      const meta = new Map<number, any>();
      if (vesRes.ok) {
        const vs = await vesRes.json();
        if (Array.isArray(vs)) for (const v of vs) meta.set(v.mmsi, v);
      }
      const ships: any[] = [];
      for (const f of (loc.features || [])) {
        const p = f.properties || {};
        const c = f.geometry?.coordinates;
        if (!c || c.length < 2) continue;
        const m = meta.get(p.mmsi) || {};
        ships.push({
          id: p.mmsi, mmsi: p.mmsi,
          lat: c[1], lng: c[0],
          speed: typeof p.sog === 'number' ? p.sog : 0,
          heading: (p.heading != null && p.heading < 360) ? p.heading : (p.cog ?? 0),
          name: (m.name && m.name.trim()) || `MMSI ${p.mmsi}`,
          destination: (m.destination && m.destination.trim()) || '',
          type: aisTypeToCategory(m.shipType || 0),
          source: 'digitraffic',
          timestamp: Date.now(),
        });
      }
      if (ships.length > 0) { dtCache = ships; dtCacheAt = Date.now(); }
      return dtCache;
    } catch {
      return dtCache;
    } finally {
      dtInflight = null;
    }
  })();
  return dtInflight;
}

function connectAisStream() {
  if (globalForAis.isAisConnecting) return;
  const apiKey = process.env.AIS_API_KEY;
  if (!apiKey) return;

  globalForAis.isAisConnecting = true;
  let ws: WebSocket;

  try {
    ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
  } catch (e) {
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
    try {
      const parsed = JSON.parse(data.toString());
      const mmsi = parsed.MetaData?.MMSI;
      if (!mmsi) return;

      const existing = shipsCache.get(mmsi) || {
        id: mmsi, mmsi: mmsi, timestamp: Date.now()
      };

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
      } 
      else if (parsed.MessageType === "ShipStaticData" && parsed.Message?.ShipStaticData) {
        const staticData = parsed.Message.ShipStaticData;
        existing.name = staticData.Name ? staticData.Name.trim() : existing.name;
        existing.destination = staticData.Destination ? staticData.Destination.trim() : existing.destination;
        existing.type = getOsirisShipType(staticData.Type);
      }

      // Only store if we have coordinates
      if (existing.lat && existing.lng) {
        shipsCache.set(mmsi, existing);
      }

      // Limit cache size to prevent memory leak (allow up to 20,000 ships)
      if (shipsCache.size > 20000) {
        const firstKey = shipsCache.keys().next().value;
        if (firstKey) shipsCache.delete(firstKey);
      }
    } catch (e) {
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

// --- SCM Integration: VesselAPI Hybrid Fallback (Satellite AIS) ---
let lastVesselApiFetch = 0;
async function fetchVesselApiFallback() {
  // Mock data removed per user request. We only rely on real live stream data.
}

// Response cache — merging + congestion math over thousands of ships is O(ports×ships);
// caching keeps it cheap at scale and lets Cloudflare's edge serve most requests.
let respCache: any = null;
let respCacheAt = 0;
const RESP_TTL = 30000;
const SHIP_CAP = 8000; // keep the map (and payload) performant
const EDGE_CC = 'public, s-maxage=30, stale-while-revalidate=60';

export async function GET() {
  if (respCache && Date.now() - respCacheAt < RESP_TTL) {
    return NextResponse.json(respCache, { headers: { 'Cache-Control': EDGE_CC } });
  }

  // Keyless Digitraffic feed (always) + keyed aisstream cache (if configured), merged by MMSI.
  const dtShips = await fetchDigitraffic();

  // Clean up stale aisstream ships (older than 10 minutes)
  const now = Date.now();
  for (const [mmsi, ship] of shipsCache.entries()) {
    if (now - ship.timestamp > 10 * 60 * 1000) {
      shipsCache.delete(mmsi);
    }
  }

  const byMmsi = new Map<number, any>();
  for (const s of dtShips) byMmsi.set(s.mmsi, s);
  for (const s of shipsCache.values()) byMmsi.set(s.mmsi, s); // aisstream (global) overrides
  let ships = Array.from(byMmsi.values());
  if (ships.length > SHIP_CAP) ships = ships.slice(0, SHIP_CAP);

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
      if (getDistanceKm(choke.lat, choke.lng, ships[i].lat, ships[i].lng) < 100) nearbyCount++;
    }
    
    // Dynamically adjust risk based on live ship concentration
    let dynamicRisk = choke.risk;
    if (nearbyCount > 50) dynamicRisk = 'CRITICAL';
    else if (nearbyCount > 20 && dynamicRisk !== 'CRITICAL') dynamicRisk = 'HIGH';
    else if (nearbyCount > 5 && dynamicRisk === 'LOW') dynamicRisk = 'ELEVATED';

    return {
      ...choke,
      traffic: `${choke.traffic} | LIVE SHIPS: ${nearbyCount}`,
      risk: dynamicRisk
    };
  });

  const payload = {
    ports: dynamicPorts,
    chokepoints: dynamicChokepoints,
    ships,
    total_ports: dynamicPorts.length,
    total_chokepoints: dynamicChokepoints.length,
    total_ships: ships.length,
    sources: (process.env.AIS_API_KEY ? ['aisstream.io'] : []).concat(['Digitraffic marine AIS']),
    timestamp: new Date().toISOString(),
  };
  respCache = payload;
  respCacheAt = Date.now();

  return NextResponse.json(payload, { headers: { 'Cache-Control': EDGE_CC } });
}
