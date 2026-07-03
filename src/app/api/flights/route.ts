
import { NextResponse } from 'next/server';
import { stealthFetch } from '@/lib/stealthFetch';
import { loadDb, lookupAircraft } from '@/lib/aircraftDb';

/**
 * OSIRIS — Flight Data API
 *
 * Data source: OpenSky Network /api/states/all (global, no API key needed).
 *
 * Why not adsb.lol: their server (netcup VPS in Germany) throttles this host
 * to ~12KB/s regardless of response size or query region. Even a 62KB response
 * takes 7s; the full N.America response (3+ MB) would take ~280s. OpenSky serves
 * 13,000+ aircraft globally in ~1s at full line speed.
 *
 * Rate limit: OpenSky free tier = 400 calls/day. We refresh at most once per
 * 5 min (288 calls/day). GPS-jamming detection is disabled (OpenSky has no
 * NACp field); re-enable by adding an adsb.lol Ukraine-region supplement later.
 */

const OPENSKY_GLOBAL_URL = 'https://opensky-network.org/api/states/all';
// 5 min refresh = 288 calls/day, safely under OpenSky's 400/day free tier.
// CACHE_TTL (60s) governs how stale the served response can be; actual upstream
// data only changes when OPENSKY_TTL elapses.
const OPENSKY_TTL = 300_000;

// Helicopter type codes
const HELI_TYPES = new Set([
  'R22','R44','R66','B06','B06T','B204','B205','B206','B212','B222','B230',
  'B407','B412','B427','B429','B430','B505','B525',
  'AS32','AS35','AS50','AS55','AS65',
  'EC20','EC25','EC30','EC35','EC45','EC55','EC75',
  'H125','H130','H135','H145','H155','H160','H175','H215','H225',
  'S55','S58','S61','S64','S70','S76','S92',
  'A109','A119','A139','A169','A189','AW09',
  'MD52','MD60','MDHI','MD90','NOTR',
  'B47G','HUEY','GAMA','CABR','EXE',
]);

// Private jet types
const PRIVATE_JET_TYPES = new Set([
  'G150','G200','G280','GLEX','G500','G550','G600','G650','G700',
  'GLF2','GLF3','GLF4','GLF5','GLF6','GL5T','GL7T','GV','GIV',
  'CL30','CL35','CL60','BD70','BD10',
  'C25A','C25B','C25C','C500','C510','C525','C550','C560','C56X','C680','C700','C750',
  'E35L','E50P','E55P','E545','E550',
  'FA50','FA7X','FA8X','F900','F2TH',
  'LJ35','LJ40','LJ45','LJ60','LJ70','LJ75',
  'PC12','PC24','TBM7','TBM8','TBM9',
  'PRM1','SF50','EA50','VLJ',
]);

// Military type indicators
const MILITARY_INDICATORS = new Set([
  'C17','C5M','C130','C30J','KC10','KC46','KC35','E3CF','E3TF','E8A',
  'B1B','B2','B52','F16','F15','F18','F22','F35','A10','F117',
  'RC135','E6B','P8A','P3','MQ9','RQ4','U2','EP3','RC12',
  'V22','CH47','UH60','AH64','AH1Z','MV22',
  'EUFI','RFAL','TORD','TYP','GR4',
]);

const AIRLINE_CODE_RE = /^([A-Z]{3})\d/;

// Internal aircraft record — a shared shape for both adsb.lol and OpenSky data.
// `alt_baro` is feet (or 0 when on-ground); `t`/`r`/`nac_p`/`dbFlags` are absent
// for OpenSky-sourced records so classification falls back to callsign only.
interface AdsbAircraft {
  hex?: string;
  flight?: string;
  t?: string;
  r?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | string;
  gs?: number;
  track?: number;
  squawk?: string;
  dbFlags?: number;
  nac_p?: number;
}

// OpenSky state vector field indices
const OS_HEX = 0, OS_FLIGHT = 1, OS_LON = 5, OS_LAT = 6;
const OS_BARO_M = 7, OS_ON_GROUND = 8, OS_VEL_MS = 9, OS_TRACK = 10, OS_SQUAWK = 14;

// Fetch the global aircraft feed from OpenSky. Returns null on failure (caller
// keeps last-good data). Altitude is metres → converted to feet; speed is m/s →
// knots, so classifyFlight() works without changes.
async function fetchGlobal(): Promise<AdsbAircraft[] | null> {
  try {
    const res = await stealthFetch(OPENSKY_GLOBAL_URL, { hardTimeoutMs: 15000 });
    if (!res.ok) return null;
    const data = await res.json() as { states?: (string | number | boolean | null)[][] };
    return (data.states ?? []).reduce<AdsbAircraft[]>((acc, s) => {
      const hex = s[OS_HEX] as string | null;
      const lat = s[OS_LAT] as number | null;
      const lon = s[OS_LON] as number | null;
      if (!hex || lat == null || lon == null) return acc;
      const baroM = s[OS_BARO_M] as number | null;
      const onGround = s[OS_ON_GROUND] as boolean | null;
      const velMs = s[OS_VEL_MS] as number | null;
      acc.push({
        hex,
        flight: ((s[OS_FLIGHT] as string | null) ?? '').trim() || undefined,
        lat,
        lon,
        // 0 ft triggers classifyFlight's isGrounded (< 100 ft) check
        alt_baro: onGround ? 0 : (baroM != null ? Math.round(baroM / 0.3048) : undefined),
        gs: velMs != null ? velMs / 0.5144 : undefined,
        track: (s[OS_TRACK] as number | null) ?? undefined,
        squawk: (s[OS_SQUAWK] as string | null) ?? undefined,
        dbFlags: 0,
      });
      return acc;
    }, []);
  } catch (e) {
    console.warn('OpenSky global fetch failed:', e);
    return null;
  }
}

function classifyFlight(f: AdsbAircraft) {
  const modelUpper = (f.t || '').toUpperCase();
  const flightStr = (f.flight || '').trim().toUpperCase();
  const dbFlags = (f.dbFlags || 0);

  // Skip fixed structures
  if (modelUpper === 'TWR') return null;

  const lat = f.lat;
  const lon = f.lon;
  if (lat == null || lon == null) return null;

  const callsign = flightStr || f.hex || 'UNKNOWN';
  const altRaw = f.alt_baro;
  const altMeters = typeof altRaw === 'number' ? altRaw * 0.3048 : 0;
  const speedKnots = typeof f.gs === 'number' ? Math.round(f.gs * 10) / 10 : null;
  const heading = f.track || 0;
  const isHeli = HELI_TYPES.has(modelUpper);
  const isGrounded = typeof altRaw === 'number' && altRaw < 100;

  // Extract airline code
  const airlineMatch = AIRLINE_CODE_RE.exec(callsign);
  const airlineCode = airlineMatch ? airlineMatch[1] : '';

  // Classification (type-based checks degrade gracefully to 'commercial' when
  // aircraft type is unavailable, as is the case for OpenSky-sourced records)
  let category: 'commercial' | 'private' | 'jet' | 'military' = 'commercial';
  if (dbFlags & 1 || MILITARY_INDICATORS.has(modelUpper) || (f.flight || '').match(/^(RCH|KING|DUKE|EVAC|JAKE|REACH|CONVOY)\d/i)) {
    category = 'military';
  } else if (PRIVATE_JET_TYPES.has(modelUpper)) {
    category = 'jet';
  } else if (!airlineCode && modelUpper && !['A319','A320','A321','A332','A333','A339','A343','A359','A388','B737','B738','B739','B38M','B39M','B752','B753','B763','B764','B772','B77L','B77W','B788','B789','B78X','E170','E175','E190','E195','CRJ7','CRJ9','AT43','AT72','DH8D'].includes(modelUpper)) {
    category = 'private';
  }

  const classifiedLat = Math.round(lat * 100000) / 100000;
  const classifiedLng = Math.round(lon * 100000) / 100000;

  return {
    callsign,
    lat: classifiedLat,
    lng: classifiedLng,
    alt: Math.round(altMeters),
    heading: Math.round(heading),
    speed_knots: speedKnots,
    model: f.t || 'Unknown',
    icao24: f.hex || '',
    registration: f.r || 'N/A',
    squawk: f.squawk || '',
    airline_code: airlineCode,
    aircraft_category: isHeli ? 'heli' : 'plane',
    category,
    grounded: isGrounded,
    nac_p: f.nac_p,
    type: 'flight',
  };
}

type ClassifiedFlight = NonNullable<ReturnType<typeof classifyFlight>>;
type JammingPoint = { lat: number; lng: number; nac_p: number; callsign: string };

interface FlightResponse {
  commercial_flights: ClassifiedFlight[];
  private_flights: ClassifiedFlight[];
  private_jets: ClassifiedFlight[];
  military_flights: ClassifiedFlight[];
  gps_jamming: ReturnType<typeof aggregateJamming>;
  total: number;
  timestamp: string;
}

const JAMMING_NACAP_THRESHOLD = 4;

// Load aircraft type cache from disk at startup (non-blocking)
loadDb().catch(() => {});

// Last-good aircraft list — preserved across refreshes so a transient OpenSky
// outage doesn't blank the map.
let lastGoodAircraft: AdsbAircraft[] = [];
let openskyLastFetch = 0;

let cachedData: FlightResponse | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 60_000;
let refreshing: Promise<void> | null = null;

function buildResponse(aircraft: AdsbAircraft[]): FlightResponse {
  const commercial: ClassifiedFlight[] = [];
  const privateFl: ClassifiedFlight[] = [];
  const jets: ClassifiedFlight[] = [];
  const military: ClassifiedFlight[] = [];
  const gpsJamming: JammingPoint[] = [];

  // Enrich with type and military flag from the Mictronics DB (in-place so
  // records carry the data forward until the next OpenSky refresh replaces them)
  for (const a of aircraft) {
    if (!a.hex) continue;
    const entry = lookupAircraft(a.hex);
    if (!a.t && entry.type) a.t = entry.type;
    if (!a.r && entry.reg)  a.r = entry.reg;
    if (entry.military)     a.dbFlags = (a.dbFlags ?? 0) | 1;
  }

  for (const raw of aircraft) {
    const flight = classifyFlight(raw);
    if (!flight) continue;

    if (typeof flight.nac_p === 'number' && flight.nac_p <= JAMMING_NACAP_THRESHOLD && !flight.grounded) {
      gpsJamming.push({ lat: flight.lat, lng: flight.lng, nac_p: flight.nac_p, callsign: flight.callsign });
    }

    switch (flight.category) {
      case 'military': military.push(flight); break;
      case 'jet':      jets.push(flight);     break;
      case 'private':  privateFl.push(flight); break;
      default:         commercial.push(flight);
    }
  }

  return {
    commercial_flights: commercial,
    private_flights: privateFl,
    private_jets: jets,
    military_flights: military,
    gps_jamming: aggregateJamming(gpsJamming, JAMMING_NACAP_THRESHOLD),
    total: aircraft.length,
    timestamp: new Date().toISOString(),
  };
}

async function refreshAll(): Promise<void> {
  await loadDb(); // ensure disk cache is loaded (no-op after first call)
  const now = Date.now();
  if (now - openskyLastFetch > OPENSKY_TTL) {
    const fresh = await fetchGlobal();
    if (fresh !== null) {
      lastGoodAircraft = fresh;
      openskyLastFetch = now;
    }
    // fresh === null: keep lastGoodAircraft (last-good fallback)
  }
  cachedData = buildResponse(lastGoodAircraft);
  lastFetchTime = Date.now();
}

export async function GET() {
  const now = Date.now();
  const stale = !cachedData || now - lastFetchTime > CACHE_TTL;

  if (stale && !refreshing) {
    refreshing = refreshAll().finally(() => { refreshing = null; });
  }

  // Cold start: block until the first fetch completes so the client gets real
  // data on initial load rather than an empty layer for a full poll cycle.
  if (!cachedData && refreshing) {
    try { await refreshing; } catch { /* fall through to empty response */ }
  }

  const body: FlightResponse = cachedData ?? {
    commercial_flights: [],
    private_flights: [],
    private_jets: [],
    military_flights: [],
    gps_jamming: [],
    total: 0,
    timestamp: new Date().toISOString(),
  };

  const cacheControl = body.total < 100
    ? 'no-store, max-age=0'
    : 'public, s-maxage=30, stale-while-revalidate=60';

  return NextResponse.json(body, { headers: { 'Cache-Control': cacheControl } });
}

function aggregateJamming(points: JammingPoint[], threshold: number) {
  if (points.length === 0) return [];
  const grid = new Map<string, { lat: number; lng: number; count: number; total_nac_p: number }>();
  const GRID_SIZE = 2;

  for (const p of points) {
    const gLat = Math.floor(p.lat / GRID_SIZE) * GRID_SIZE;
    const gLng = Math.floor(p.lng / GRID_SIZE) * GRID_SIZE;
    const key = `${gLat},${gLng}`;
    if (!grid.has(key)) {
      grid.set(key, { lat: gLat + GRID_SIZE / 2, lng: gLng + GRID_SIZE / 2, count: 0, total_nac_p: 0 });
    }
    const cell = grid.get(key)!;
    cell.count++;
    cell.total_nac_p += p.nac_p;
  }

  return Array.from(grid.values())
    .filter(z => z.count >= 3)
    .map(z => ({
      lat: z.lat,
      lng: z.lng,
      severity: Math.round((1 - (z.total_nac_p / z.count) / threshold) * 100),
      count: z.count,
    }));
}
