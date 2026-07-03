import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Correlated Events Aggregator
 *
 * Joins signals from 5 live routes (air-raids, weapon-threats, kab-threats,
 * drone-threats, missile-threats) and emits one CorrelatedEvent per oblast
 * that has >= 2 distinct signal types within the last 60 minutes.
 *
 * Self-fetch pattern mirrors /api/oblast-pressure:
 *   - Promise.allSettled over all 5 sources
 *   - AbortSignal.timeout(8000) per fetch
 *   - Failed source silently skipped (never kills the route)
 *   - Stale-on-error: serve last good response if compute fails
 *
 * Cache: 60s in-memory + inflight-coalescence (one pending Promise per module,
 *        not one per request).
 * Env:   OSIRIS_SELF_ORIGIN — default http://localhost:3001
 */

// ---------------------------------------------------------------------------
// Exported types (panel imports these)
// ---------------------------------------------------------------------------

export interface Signal {
  type: 'air_raid' | 'weapon' | 'kab' | 'drone' | 'missile';
  weapon_type?: string;
  ts: string;
  source?: string;
  snippet?: string;
}

export interface CorrelatedEvent {
  oblast: string;
  lat: number;
  lng: number;
  signals: Signal[];
  alarm_confirmed: boolean;
  match_tightness_min: number;
  ts: string;
}

export interface CorrelatedEventsResponse {
  events: CorrelatedEvent[];
  count: number;
  window_hours: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Cache + inflight coalescence
// ---------------------------------------------------------------------------

const CACHE_TTL = 60_000;

let cached: CorrelatedEventsResponse | null = null;
let cachedAt = 0;
let inflight: Promise<CorrelatedEventsResponse> | null = null;

// ---------------------------------------------------------------------------
// Oblast centroids [lng, lat] — copied from oblast-pressure/route.ts
// Keys are the canonical name_en values used across all signal sources.
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
// Response shape types (narrowed from upstream JSON)
// ---------------------------------------------------------------------------

interface AirAlert {
  oblast: string;
  startedAt?: string | null;
  lat?: number | null;
  lng?: number | null;
}

interface AirRaidsData {
  alerts?: AirAlert[];
  timestamp?: string;
}

interface ThreatEntry {
  oblast?: string;
  weaponType?: string;
  startedAt?: string;
  lat?: number | null;
  lng?: number | null;
  sources?: string[];
  text?: string;
}

interface ThreatsData {
  threats?: ThreatEntry[];
}

interface MissileWaypoint {
  oblast?: string;
  lat?: number | null;
  lng?: number | null;
  ts?: string;
  channel?: string;
  text?: string;
}

interface MissileWave {
  waypoints?: MissileWaypoint[];
}

interface MissileRoute {
  weaponType?: string;
  waves?: MissileWave[];
}

interface MissileData {
  routes?: MissileRoute[];
}

// ---------------------------------------------------------------------------
// Per-oblast signal accumulator
// ---------------------------------------------------------------------------

interface OblastAccumulator {
  signals: Signal[];
  coords: [number, number] | null;
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

async function computeCorrelatedEvents(): Promise<CorrelatedEventsResponse> {
  // Default must match the live deploy (Next listens on :3000); the other
  // self-fetch routes (markets, oblast-pressure) use the same default.
  const base = process.env.OSIRIS_SELF_ORIGIN ?? 'http://127.0.0.1:3000';

  const [airRes, weaponRes, kabRes, droneRes, missileRes] = await Promise.allSettled([
    fetch(`${base}/api/air-raids`,      { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() as Promise<AirRaidsData> : null),
    fetch(`${base}/api/weapon-threats`, { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() as Promise<ThreatsData>   : null),
    fetch(`${base}/api/kab-threats`,    { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() as Promise<ThreatsData>   : null),
    fetch(`${base}/api/drone-threats`,  { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() as Promise<ThreatsData>   : null),
    fetch(`${base}/api/missile-threats`,{ signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() as Promise<MissileData>   : null),
  ]);

  const airData     = airRes.status    === 'fulfilled' ? airRes.value    : null;
  const weaponData  = weaponRes.status === 'fulfilled' ? weaponRes.value : null;
  const kabData     = kabRes.status    === 'fulfilled' ? kabRes.value    : null;
  const droneData   = droneRes.status  === 'fulfilled' ? droneRes.value  : null;
  const missileData = missileRes.status === 'fulfilled' ? missileRes.value : null;

  // -------------------------------------------------------------------------
  // 60-minute rolling window cutoff
  // -------------------------------------------------------------------------
  const cutoff = Date.now() - 60 * 60_000;

  // -------------------------------------------------------------------------
  // Oblast signal map:  oblast_name → { signals, first-seen coords }
  // -------------------------------------------------------------------------
  const byOblast = new Map<string, OblastAccumulator>();

  function ensureOblast(oblast: string): OblastAccumulator {
    if (!byOblast.has(oblast)) {
      byOblast.set(oblast, { signals: [], coords: null });
    }
    return byOblast.get(oblast)!;
  }

  function recordCoords(acc: OblastAccumulator, lat: number | null | undefined, lng: number | null | undefined): void {
    if (acc.coords === null && typeof lat === 'number' && isFinite(lat) && typeof lng === 'number' && isFinite(lng)) {
      acc.coords = [lng, lat];
    }
  }

  // -------------------------------------------------------------------------
  // air_raids — keep all currently active alerts (they are within the window
  // by definition; the feed only returns live alerts).
  // -------------------------------------------------------------------------
  if (airData?.alerts && Array.isArray(airData.alerts)) {
    const responseTs = airData.timestamp ?? new Date().toISOString();
    for (const a of airData.alerts) {
      const oblast = typeof a.oblast === 'string' ? a.oblast : null;
      if (!oblast) continue;
      // The air-raids feed only returns CURRENTLY-ACTIVE alerts, so every entry is
      // a live signal regardless of when it started — UA alerts routinely run for
      // hours. Stamp the signal at the response time (the alert is active "now")
      // rather than the original startedAt: this keeps long-running alerts from
      // being dropped by the 60-min window (which previously flipped
      // alarm_confirmed to false mid-alert) without inflating match_tightness_min
      // with a stale start time.
      const acc = ensureOblast(oblast);
      recordCoords(acc, a.lat, a.lng);
      acc.signals.push({
        type: 'air_raid',
        ts: responseTs,
      });
    }
  }

  // -------------------------------------------------------------------------
  // weapon — threats[]
  // -------------------------------------------------------------------------
  if (weaponData?.threats && Array.isArray(weaponData.threats)) {
    for (const t of weaponData.threats) {
      const oblast = typeof t.oblast === 'string' ? t.oblast : null;
      if (!oblast) continue;
      const ts = typeof t.startedAt === 'string' ? t.startedAt : '';
      if (!ts || new Date(ts).getTime() < cutoff) continue;
      const acc = ensureOblast(oblast);
      recordCoords(acc, t.lat, t.lng);
      acc.signals.push({
        type: 'weapon',
        weapon_type: typeof t.weaponType === 'string' ? t.weaponType : undefined,
        ts,
        source: Array.isArray(t.sources) && t.sources.length > 0 ? t.sources[0] : undefined,
        snippet: typeof t.text === 'string' ? t.text.slice(0, 120) : undefined,
      });
    }
  }

  // -------------------------------------------------------------------------
  // kab — threats[] (same shape as weapon)
  // -------------------------------------------------------------------------
  if (kabData?.threats && Array.isArray(kabData.threats)) {
    for (const t of kabData.threats) {
      const oblast = typeof t.oblast === 'string' ? t.oblast : null;
      if (!oblast) continue;
      const ts = typeof t.startedAt === 'string' ? t.startedAt : '';
      if (!ts || new Date(ts).getTime() < cutoff) continue;
      const acc = ensureOblast(oblast);
      recordCoords(acc, t.lat, t.lng);
      acc.signals.push({
        type: 'kab',
        weapon_type: 'KAB',
        ts,
        source: Array.isArray(t.sources) && t.sources.length > 0 ? t.sources[0] : undefined,
        snippet: typeof t.text === 'string' ? t.text.slice(0, 120) : undefined,
      });
    }
  }

  // -------------------------------------------------------------------------
  // drone — threats[] (NOT waves)
  // -------------------------------------------------------------------------
  if (droneData?.threats && Array.isArray(droneData.threats)) {
    for (const t of droneData.threats) {
      const oblast = typeof t.oblast === 'string' ? t.oblast : null;
      if (!oblast) continue;
      const ts = typeof t.startedAt === 'string' ? t.startedAt : '';
      if (!ts || new Date(ts).getTime() < cutoff) continue;
      const acc = ensureOblast(oblast);
      recordCoords(acc, t.lat, t.lng);
      acc.signals.push({
        type: 'drone',
        weapon_type: 'DRONE',
        ts,
        source: Array.isArray(t.sources) && t.sources.length > 0 ? t.sources[0] : undefined,
        snippet: typeof t.text === 'string' ? t.text.slice(0, 120) : undefined,
      });
    }
  }

  // -------------------------------------------------------------------------
  // missile — flatten routes[].waves[].waypoints[]
  // -------------------------------------------------------------------------
  if (missileData?.routes && Array.isArray(missileData.routes)) {
    for (const route of missileData.routes) {
      const weaponType = typeof route.weaponType === 'string' ? route.weaponType : undefined;
      if (!Array.isArray(route.waves)) continue;
      for (const wave of route.waves) {
        if (!Array.isArray(wave.waypoints)) continue;
        for (const wp of wave.waypoints) {
          const oblast = typeof wp.oblast === 'string' ? wp.oblast : null;
          if (!oblast) continue;
          const ts = typeof wp.ts === 'string' ? wp.ts : '';
          if (!ts || new Date(ts).getTime() < cutoff) continue;
          const acc = ensureOblast(oblast);
          recordCoords(acc, wp.lat, wp.lng);
          acc.signals.push({
            type: 'missile',
            weapon_type: weaponType,
            ts,
            source: (typeof wp.channel === 'string' && wp.channel) ? `t.me/${wp.channel}` : undefined,
            snippet: typeof wp.text === 'string' ? wp.text.slice(0, 120) : undefined,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Join — emit CorrelatedEvent only when >= 2 distinct signal types present
  // -------------------------------------------------------------------------
  const events: CorrelatedEvent[] = [];

  for (const [oblast, acc] of byOblast) {
    const { signals } = acc;
    const distinctTypes = new Set(signals.map(s => s.type));
    if (distinctTypes.size < 2) continue;

    // Timestamps of all non-air-raid signals plus air-raid signals that parse OK
    const tsValues = signals
      .map(s => new Date(s.ts).getTime())
      .filter(t => isFinite(t));

    const minTs = Math.min(...tsValues);
    const maxTs = Math.max(...tsValues);

    const alarm_confirmed = distinctTypes.has('air_raid');
    const match_tightness_min = Math.round((maxTs - minTs) / 60_000);
    const ts = new Date(maxTs).toISOString();

    // Resolve coords: first signal with finite coords, then centroid.
    // Skip if neither is available — a (0,0) null-island point is worse than omission.
    const centroid = OBLAST_CENTROIDS[oblast];
    let lat: number, lng: number;
    if (acc.coords !== null) {
      [lng, lat] = acc.coords;
    } else if (centroid) {
      [lng, lat] = centroid;
    } else {
      continue;
    }

    events.push({ oblast, lat, lng, signals, alarm_confirmed, match_tightness_min, ts });
  }

  // Sort newest first
  events.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  return {
    events,
    count: events.length,
    window_hours: 1,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route handler — inflight-coalescence mirrors oblast-pressure pattern
// ---------------------------------------------------------------------------

export async function GET() {
  const now = Date.now();

  // Serve from cache if fresh
  if (cached && now - cachedAt < CACHE_TTL) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }

  // Coalesce concurrent requests: attach to the in-flight promise instead of
  // launching a second parallel computation
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
        { events: [], count: 0, window_hours: 1, timestamp: new Date().toISOString(), error: 'Failed to compute correlated events' },
        { status: 500 },
      );
    }
  }

  inflight = computeCorrelatedEvents();
  try {
    const data = await inflight;
    cached = data;
    cachedAt = Date.now();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  } catch (error) {
    console.error('[OSIRIS] correlated-events compute error:', error);
    // Serve stale if available
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
      });
    }
    return NextResponse.json(
      {
        events: [],
        count: 0,
        window_hours: 1,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Failed to compute correlated events',
      },
      { status: 500 },
    );
  } finally {
    inflight = null;
  }
}
