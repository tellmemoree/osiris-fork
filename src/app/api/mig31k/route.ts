import { NextResponse } from 'next/server';
import { getThreatCorpus, matchOblasts, isMig31Mention } from '@/lib/telegram-threats';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — MiG-31K / Kinzhal-carrier Detection (dual-signal)
 *
 * Fuses two independent signals into a single Mig31kResponse:
 *   1. ADS-B — self-fetches /api/flights and scans all four flight arrays for
 *      known MiG-31 ICAO type codes (MG31 / MIG31 / M31 / M31K).
 *   2. Telegram — scans the shared 1.5-h corpus for isMig31Mention() matches
 *      and aggregates sightings by geographic anchor (oblast centroid, known
 *      airbase, or nationwide fallback).
 *
 * Cache: 60 s route-level with inflight-coalescence.
 * Upstream corpus cached 15 min in telegram-threats.ts.
 * Flights TTL governed by /api/flights; this route accepts whatever /api/flights
 * returns (fresh or stale-cached) — no additional staleness check needed.
 *
 * SSRF: no user-supplied URLs — self-origin is env-controlled, not user input.
 *
 * Error policy:
 *   - Promise.allSettled — one side failure returns the other.
 *   - Total failure + stale cache → 200 with stale data.
 *   - Total failure + no cache → 200 with empty-but-valid response (never 500).
 */

const WINDOW_HOURS = 1.5;
const CACHE_TTL_MS = 60_000; // 60 s — carrier sightings are fast-moving intelligence

// ── ICAO type codes ──────────────────────────────────────────────────────────
//
// MiG-31 ICAO designators from Mictronics tar1090-db convention.
// Aircraft DB (~/.osiris-data/aircraft-db.csv.gz) was empty at implementation
// time (DB not yet downloaded in this environment), so codes are sourced from
// the Mictronics CSV header docs and known UA-tracker usage:
//   MG31  — primary Mictronics type code for all MiG-31 variants
//   MIG31 — alternate spelling used by some feeder stations
//   M31   — short form seen in low-fidelity feeds
//   M31K  — MiG-31K (Kinzhal carrier) variant-specific code
// Revisit when DB downloads successfully: grep typeCode column for 'MG' / 'M31'.
const MIG31_TYPE_CODES = new Set(['MG31', 'MIG31', 'M31', 'M31K']);

// ── known airbases (RU/BY hosting MiG-31K) ──────────────────────────────────

const AIRBASES: [RegExp, [number, number], string][] = [
  [/саваслейк/iu,  [42.31, 55.44], 'Savasleyka AB'],
  [/мачулищ/iu,    [27.58, 53.77], 'Machulishchy AB'],
  [/моздок/iu,     [44.58, 43.79], 'Mozdok AB'],
];

// ── types ────────────────────────────────────────────────────────────────────

interface Mig31kDetection {
  source:      'adsb' | 'telegram';
  sourceLabel: 'ADS-B detected' | 'Telegram-reported';
  lat:         number | null;
  lng:         number | null;
  locationName: string;
  detectedAt:  string;
  // ADS-B specific
  callsign?:     string;
  icao24?:       string;
  registration?: string;
  model?:        string;
  alt?:          number;
  speed_knots?:  number | null;
  heading?:      number;
  // Telegram specific
  text?:    string;
  count?:   number;
  sources?: string[];
}

interface Mig31kResponse {
  detections:   Mig31kDetection[];
  active:       boolean;
  total:        number;
  window_hours: number;
  timestamp:    string;
}

// ── module-level cache ───────────────────────────────────────────────────────

let cached:   Mig31kResponse | null = null;
let cachedAt                        = 0;
let inflight: Promise<Mig31kResponse> | null = null;

// ── flights response shape (subset used here) ────────────────────────────────

interface FlightRecord {
  callsign?:     string;
  icao24?:       string;
  registration?: string;
  model?:        string;
  lat?:          number;
  lng?:          number;
  alt?:          number;
  speed_knots?:  number | null;
  heading?:      number;
}

interface FlightsResponse {
  commercial_flights?: FlightRecord[];
  private_flights?:    FlightRecord[];
  private_jets?:       FlightRecord[];
  military_flights?:   FlightRecord[];
}

// ── ADS-B signal ─────────────────────────────────────────────────────────────

async function fetchAdsbDetections(): Promise<Mig31kDetection[]> {
  const base = process.env.OSIRIS_SELF_ORIGIN ?? 'http://127.0.0.1:3000';
  const res = await fetch(`${base}/api/flights`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`/api/flights responded ${res.status}`);

  const data = (await res.json()) as FlightsResponse;
  const allFlights: FlightRecord[] = [
    ...(data.commercial_flights ?? []),
    ...(data.private_flights    ?? []),
    ...(data.private_jets       ?? []),
    ...(data.military_flights   ?? []),
  ];

  const detections: Mig31kDetection[] = [];
  for (const f of allFlights) {
    const modelCode = (f.model ?? '').toUpperCase();
    if (!MIG31_TYPE_CODES.has(modelCode)) continue;

    detections.push({
      source:      'adsb',
      sourceLabel: 'ADS-B detected',
      lat:         f.lat ?? null,
      lng:         f.lng ?? null,
      locationName: f.callsign ?? f.icao24 ?? 'Unknown',
      detectedAt:  new Date().toISOString(),
      callsign:    f.callsign,
      icao24:      f.icao24,
      registration: f.registration,
      model:       f.model,
      alt:         f.alt,
      speed_knots: f.speed_knots ?? null,
      heading:     f.heading,
    });
  }
  return detections;
}

// ── Telegram signal ───────────────────────────────────────────────────────────

async function fetchTelegramDetections(): Promise<Mig31kDetection[]> {
  const messages = await getThreatCorpus();

  // Dedup via channel:ts fingerprint
  const seen = new Set<string>();
  const relevant = messages.filter((msg) => {
    if (!isMig31Mention(msg.text)) return false;
    const fp = `${msg.channel}:${msg.ts}`;
    if (seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });

  // Aggregate by geo-key
  type AggEntry = {
    lat:        number | null;
    lng:        number | null;
    locationName: string;
    count:      number;
    latestTs:   number;
    latestText: string;
    sources:    Set<string>;
  };

  const agg = new Map<string, AggEntry>();

  for (const msg of relevant) {
    // Geo resolution: (1) known airbase keyword, (2) oblast centroid, (3) nationwide
    let lat: number | null = null;
    let lng: number | null = null;
    let locationName = 'Nationwide';
    let geoKey       = 'nationwide';

    // Check airbases first (more specific than oblast)
    for (const [re, coords, name] of AIRBASES) {
      if (re.test(msg.text)) {
        [lng, lat] = coords;
        locationName = name;
        geoKey       = name;
        break;
      }
    }

    // Fall back to oblast centroid
    if (geoKey === 'nationwide') {
      const refs = matchOblasts(msg.text);
      if (refs.length > 0) {
        [lng, lat]   = refs[0].coords;
        locationName = refs[0].oblast;
        geoKey       = refs[0].oblast;
      }
    }

    const cur = agg.get(geoKey);
    if (!cur) {
      agg.set(geoKey, {
        lat,
        lng,
        locationName,
        count:      1,
        latestTs:   msg.ts,
        latestText: msg.text,
        sources:    new Set([msg.channel]),
      });
    } else {
      cur.count += 1;
      cur.sources.add(msg.channel);
      if (msg.ts > cur.latestTs) {
        cur.latestTs   = msg.ts;
        cur.latestText = msg.text;
      }
    }
  }

  return Array.from(agg.values()).map((a) => ({
    source:      'telegram' as const,
    sourceLabel: 'Telegram-reported' as const,
    lat:         a.lat,
    lng:         a.lng,
    locationName: a.locationName,
    detectedAt:  new Date(a.latestTs).toISOString(),
    text:        a.latestText.length > 220 ? a.latestText.slice(0, 220) + '…' : a.latestText,
    count:       a.count,
    sources:     Array.from(a.sources).map((s) => `t.me/${s}`),
  }));
}

// ── builder ───────────────────────────────────────────────────────────────────

async function buildMig31kResponse(): Promise<Mig31kResponse> {
  const [adsbResult, tgResult] = await Promise.allSettled([
    fetchAdsbDetections(),
    fetchTelegramDetections(),
  ]);

  const detections: Mig31kDetection[] = [
    ...(adsbResult.status === 'fulfilled' ? adsbResult.value : []),
    ...(tgResult.status   === 'fulfilled' ? tgResult.value   : []),
  ];

  if (adsbResult.status === 'rejected') {
    console.warn('[OSIRIS] mig31k ADS-B fetch failed:', adsbResult.reason);
  }
  if (tgResult.status === 'rejected') {
    console.warn('[OSIRIS] mig31k Telegram fetch failed:', tgResult.reason);
  }

  return {
    detections,
    active:       detections.length > 0,
    total:        detections.length,
    window_hours: WINDOW_HOURS,
    timestamp:    new Date().toISOString(),
  };
}

// ── empty fallback ────────────────────────────────────────────────────────────

const EMPTY_RESPONSE: Mig31kResponse = {
  detections:   [],
  active:       false,
  total:        0,
  window_hours: WINDOW_HOURS,
  timestamp:    new Date().toISOString(),
};

// ── route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  const now = Date.now();
  const headers = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' };

  // Serve fresh cache
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cached, { headers });
  }

  // Join existing in-flight request
  if (inflight) {
    try {
      return NextResponse.json(await inflight, { headers });
    } catch {
      // inflight failed — fall through to stale or empty
      return NextResponse.json(
        cached ?? EMPTY_RESPONSE,
        { headers },
      );
    }
  }

  inflight = buildMig31kResponse();
  try {
    const data = await inflight;
    cached   = data;
    cachedAt = Date.now();
    return NextResponse.json(data, { headers });
  } catch (error) {
    console.error('[OSIRIS] mig31k build error:', error);
    // Total failure: serve stale if available, else return empty (never 500)
    return NextResponse.json(cached ?? EMPTY_RESPONSE, { headers });
  } finally {
    inflight = null;
  }
}
