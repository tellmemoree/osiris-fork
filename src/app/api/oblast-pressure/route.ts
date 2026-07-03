import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Oblast Pressure Index
 *
 * Aggregates 4 live signals into a weighted 0–100 pressure score per oblast:
 *   - ballistic (0.40): active air-raid alerts (oblast-level)
 *   - kab       (0.30): KAB / glide-bomb Telegram-derived counts, scaled 0–5→0–1
 *   - frontline (0.20): Haversine distance from centroid to nearest occupied feature vertex
 *   - outage    (0.10): power outage severity (full→1.0, partial→0.5)
 *
 * Internal fetches: self-fetch to base URL, AbortSignal.timeout(8000), Promise.allSettled.
 * A failed source contributes 0 to its component — never kills the route.
 *
 * Cache: 60s in-memory + inflight-coalescence (one pending Promise, not one per request).
 * Env:   OSIRIS_SELF_ORIGIN — default http://127.0.0.1:3000 (container port)
 */

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

interface OblastScore {
  name_en: string;
  score: number;
  level: 'low' | 'med' | 'high' | 'critical';
  lng: number;
  lat: number;
  components: { ballistic: number; kab: number; frontline: number; outage: number };
}

interface PressureResponse {
  oblasts: OblastScore[];
  timestamp: string;
  sources: { air_raids: boolean; kab: boolean; frontline: boolean; outage: boolean };
}

let cached: PressureResponse | null = null;
let cachedAt = 0;
let inflight: Promise<PressureResponse> | null = null;

// ---------------------------------------------------------------------------
// Oblast centroids [lng, lat] — sourced from OBLAST_INFO in /api/air-raids
// and cross-referenced with ukraine-oblasts.geojson name_en values.
// ---------------------------------------------------------------------------

const OBLAST_CENTROIDS: Record<string, [number, number]> = {
  'Cherkasy oblast':        [32.060, 49.445],
  'Chernihiv oblast':       [31.285, 51.498],
  'Chernivtsi oblast':      [25.940, 48.292],
  'Crimea':                 [34.102, 44.952],
  'Dnipropetrovsk oblast':  [35.046, 48.465],
  'Donetsk oblast':         [37.800, 48.000],
  'Ivano-Frankivsk oblast': [24.711, 48.922],
  'Kharkiv oblast':         [36.230, 49.990],
  'Kherson oblast':         [32.601, 46.635],
  'Khmelnytskyi oblast':    [26.987, 49.423],
  'Kirovohrad oblast':      [32.262, 48.508],
  'Kyiv':                   [30.523, 50.452],
  'Kyiv oblast':            [30.523, 50.450],
  'Luhansk oblast':         [39.300, 48.566],
  'Lviv oblast':            [24.029, 49.839],
  'Mykolaiv oblast':        [31.994, 46.975],
  'Odesa oblast':           [30.723, 46.482],
  'Poltava oblast':         [34.551, 49.588],
  'Rivne oblast':           [26.251, 50.620],
  'Sevastopol':             [33.522, 44.616],
  'Sumy oblast':            [34.800, 50.910],
  'Ternopil oblast':        [25.594, 49.553],
  'Vinnytsia oblast':       [28.468, 49.233],
  'Volyn oblast':           [25.325, 50.747],
  'Zakarpattia oblast':     [23.297, 48.620],
  'Zaporizhzhia oblast':    [35.139, 47.838],
  'Zhytomyr oblast':        [28.658, 50.255],
};

// ---------------------------------------------------------------------------
// Outage regionName (power-outages route) → name_en (geojson).
// Mirrors OUTAGE_REGION_TO_GEOJSON in OsirisMap.tsx exactly.
// ---------------------------------------------------------------------------

const OUTAGE_TO_NAME_EN: Record<string, string> = {
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

// ---------------------------------------------------------------------------
// Scope: only oblasts on the active frontline or sharing a land border with
// Russia. Western/central oblasts far from the contact line score near zero
// on every signal and just add visual noise to the choropleth.
//   Russia-border: Chernihiv (Bryansk), Sumy (Kursk/Bryansk), Kharkiv (Belgorod),
//                  Luhansk (Voronezh/Rostov), Donetsk (Rostov)
//   Active frontline (no direct Russia border): Zaporizhzhia, Kherson
//   Occupied: Crimea, Sevastopol
//   Strategic depth (adjacent to frontline, regularly struck): Dnipropetrovsk, Mykolaiv
// ---------------------------------------------------------------------------

const PRESSURE_OBLASTS = new Set([
  'Chernihiv oblast',
  'Sumy oblast',
  'Kharkiv oblast',
  'Luhansk oblast',
  'Donetsk oblast',
  'Zaporizhzhia oblast',
  'Kherson oblast',
  'Dnipropetrovsk oblast',
  'Mykolaiv oblast',
  'Crimea',
  'Sevastopol',
]);

// ---------------------------------------------------------------------------
// Haversine distance — returns km between two [lng, lat] points
// ---------------------------------------------------------------------------

function haversineKm(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Frontline proximity score for a single centroid.
// Walks all coordinates of all occupied features; returns the bucket score.
// ---------------------------------------------------------------------------

function frontlineProximityScore(
  cLng: number,
  cLat: number,
  occupiedFeatures: any[],
): number {
  if (occupiedFeatures.length === 0) return 0;

  let minKm = Infinity;

  for (const feat of occupiedFeatures) {
    const geom = feat?.geometry;
    if (!geom) continue;

    // Flatten coordinate rings to a list of [lng, lat] pairs
    let rings: number[][][] = [];
    if (geom.type === 'Polygon') {
      rings = geom.coordinates as number[][][];
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates as number[][][][]) {
        rings.push(...poly);
      }
    } else if (geom.type === 'LineString') {
      rings = [geom.coordinates as number[][]];
    } else if (geom.type === 'MultiLineString') {
      rings = geom.coordinates as number[][][];
    } else if (geom.type === 'Point') {
      const [lng, lat] = geom.coordinates as number[];
      const d = haversineKm(cLng, cLat, lng, lat);
      if (d < minKm) minKm = d;
      continue;
    }

    for (const ring of rings) {
      for (const coord of ring) {
        const [lng, lat] = coord;
        const d = haversineKm(cLng, cLat, lng, lat);
        if (d < minKm) minKm = d;
      }
    }
  }

  if (minKm < 50)  return 1.0;
  if (minKm < 150) return 0.6;
  if (minKm < 300) return 0.3;
  return 0;
}

// ---------------------------------------------------------------------------
// Level classifier
// ---------------------------------------------------------------------------

function scoreToLevel(score: number): 'low' | 'med' | 'high' | 'critical' {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'med';
  return 'low';
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

async function computePressure(): Promise<PressureResponse> {
  const base = process.env.OSIRIS_SELF_ORIGIN ?? 'http://127.0.0.1:3000';

  // Fetch all 4 sources concurrently; a timeout or error on any source is non-fatal.
  const [airRes, kabRes, flRes, outRes] = await Promise.allSettled([
    fetch(`${base}/api/air-raids`,    { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null),
    fetch(`${base}/api/kab-threats`,  { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null),
    fetch(`${base}/api/frontlines`,   { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null),
    fetch(`${base}/api/power-outages`,{ signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null),
  ]);

  // Extract payloads (null if source failed)
  const airData  = airRes.status  === 'fulfilled' ? airRes.value  : null;
  const kabData  = kabRes.status  === 'fulfilled' ? kabRes.value  : null;
  const flData   = flRes.status   === 'fulfilled' ? flRes.value   : null;
  const outData  = outRes.status  === 'fulfilled' ? outRes.value  : null;

  const sources = {
    air_raids: airData !== null,
    kab:       kabData !== null,
    frontline: flData  !== null,
    outage:    outData !== null,
  };

  // Pre-process source data
  // -- Ballistic: set of oblasts with active oblast-level alerts
  const activeBallistic = new Set<string>();
  if (airData?.alerts && Array.isArray(airData.alerts)) {
    for (const a of airData.alerts) {
      if (a.level === 'oblast' && typeof a.oblast === 'string') {
        activeBallistic.add(a.oblast);
      }
    }
  }

  // -- KAB: map of oblast name_en → count
  const kabCounts = new Map<string, number>();
  if (kabData?.threats && Array.isArray(kabData.threats)) {
    for (const t of kabData.threats) {
      if (typeof t.oblast === 'string') {
        kabCounts.set(t.oblast, (kabCounts.get(t.oblast) ?? 0) + (typeof t.count === 'number' ? t.count : 1));
      }
    }
  }

  // -- Frontline: collect occupied features only
  const occupiedFeatures: any[] = [];
  if (flData?.frontlines?.features && Array.isArray(flData.frontlines.features)) {
    for (const f of flData.frontlines.features) {
      if (f?.properties?.statusKey === 'occupied') {
        occupiedFeatures.push(f);
      }
    }
  }

  // -- Outage: map of name_en → severity score
  const outageSeverity = new Map<string, number>();
  if (outData?.outages && Array.isArray(outData.outages)) {
    for (const o of outData.outages) {
      const nameEn = OUTAGE_TO_NAME_EN[o.regionName as string];
      if (!nameEn) continue;
      const sv = o.severity === 'full' ? 1.0 : o.severity === 'partial' ? 0.5 : 0;
      // Use worst severity when multiple posts map to same oblast
      if (sv > (outageSeverity.get(nameEn) ?? 0)) {
        outageSeverity.set(nameEn, sv);
      }
    }
  }

  // Score oblasts: static frontline set + any with an active alert or KAB count.
  // This catches nationwide barrage nights when western oblasts (Lviv, Vinnytsia) are struck.
  const dynamicOblasts = new Set(PRESSURE_OBLASTS);
  for (const name of activeBallistic) if (name in OBLAST_CENTROIDS) dynamicOblasts.add(name);
  for (const name of kabCounts.keys()) if (name in OBLAST_CENTROIDS) dynamicOblasts.add(name);

  const oblasts: OblastScore[] = Object.entries(OBLAST_CENTROIDS)
    .filter(([name_en]) => dynamicOblasts.has(name_en))
    .map(([name_en, [lng, lat]]) => {
    const ballistic = activeBallistic.has(name_en) ? 1.0 : 0;
    const kabCount  = kabCounts.get(name_en) ?? 0;
    const kab       = Math.min(kabCount / 5, 1.0);
    const frontline = frontlineProximityScore(lng, lat, occupiedFeatures);
    const outage    = outageSeverity.get(name_en) ?? 0;

    const score = Math.round(
      (ballistic * 0.40 + kab * 0.30 + frontline * 0.20 + outage * 0.10) * 100
    );

    return {
      name_en,
      score,
      level: scoreToLevel(score),
      lng,
      lat,
      components: { ballistic, kab, frontline, outage },
    };
  });

  return {
    oblasts,
    timestamp: new Date().toISOString(),
    sources,
  };
}

// ---------------------------------------------------------------------------
// Route handler — inflight-coalescence mirrors kab-threats pattern
// ---------------------------------------------------------------------------

export async function GET() {
  const now = Date.now();

  // Serve cached data if fresh
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }

  // Coalesce concurrent requests: attach to the in-flight promise instead of launching a second
  if (inflight) {
    try {
      return NextResponse.json(await inflight, {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
      });
    } catch {
      if (cached) {
        return NextResponse.json(cached, {
          headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
        });
      }
      return NextResponse.json(
        { oblasts: [], timestamp: new Date().toISOString(), error: 'Failed to compute oblast pressure' },
        { status: 500 },
      );
    }
  }

  inflight = computePressure();
  try {
    const data = await inflight;
    cached = data;
    cachedAt = Date.now();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  } catch (error) {
    console.error('[OSIRIS] Oblast pressure compute error:', error);
    // Serve stale if available
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
      });
    }
    return NextResponse.json(
      {
        oblasts: [],
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Failed to compute oblast pressure',
      },
      { status: 500 },
    );
  } finally {
    inflight = null;
  }
}
