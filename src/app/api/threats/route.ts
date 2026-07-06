import { NextResponse } from 'next/server';
import { confidenceBand, splitWaveIntoChains } from '@/lib/telegram-threats';
import type { TrailPoint } from '@/lib/telegram-threats';
import { raionKeyForPoint } from '@/lib/raion-lookup';

// Max real-world drone speed (km/h) used to split a wave's waypoints into
// per-object chains — see splitWaveIntoChains in telegram-threats.ts.
const DRONE_CHAIN_MAX_KMH = 250;

// Trail length cap — most-recent N points kept per chain, oldest-to-newest.
const TRAIL_MAX_POINTS = 8;

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Unified Threat Layer Aggregator
 *
 * Merges the 4 existing threat-signal routes (kab-threats, drone-threats,
 * missile-threats, mig31k) into a single GeoJSON FeatureCollection with a
 * 7-way display taxonomy (fpv / cruise / ballistic / kab / aviation / recon / uav),
 * so the client can render one unified point-icon layer instead of 4 separate
 * toggles.
 *
 * This is a NEW, additive aggregator route. It does NOT modify, replace, or
 * remove /api/kab-threats, /api/drone-threats, /api/missile-threats, or
 * /api/mig31k — those stay live and unmodified, and /api/correlated-events
 * (which self-fetches those same 4 routes) is untouched by this change.
 *
 * Self-fetch pattern mirrors /api/correlated-events:
 *   - Promise.allSettled over all 4 sources
 *   - AbortSignal.timeout(8000) per fetch
 *   - Failed source silently skipped (never kills the route)
 *   - Stale-on-error: serve last good response if compute fails
 *
 * Cache: 60s in-memory + inflight-coalescence (one pending Promise per module,
 *        not one per request) — matches the 60s cache TTL already used by all
 *        4 upstream routes, so this aggregator never polls faster than its
 *        sources actually refresh.
 * Env:   OSIRIS_SELF_ORIGIN — default http://localhost:3001 (same convention
 *        as correlated-events / oblast-pressure / mig31k; no new env var).
 */

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type UnifiedThreatType =
  | 'fpv' | 'cruise' | 'ballistic' | 'kab' | 'aviation' | 'recon' | 'uav';

export interface UnifiedThreatProperties {
  fid?:        number; // stable per-response index, stamped post-hoc — map click-to-select keys off this (GeoJSON sources here have no generateId)
  tid:         string; // stable track/chain id across polls — identity independent of array position
  ttype:       UnifiedThreatType;
  title:       string;
  place?:      string;
  oblast:      string;
  confidence:  number;
  band:        'low' | 'medium' | 'high';
  bearing:     number | null;
  approximate: boolean;
  sources:     number;
  ts:          string;
  alarmConfirmed?:  boolean; // drone/missile waypoint corroborated by alarm-history (source route's own check)
  neptunConfirmed?: boolean; // point resolves into a raion currently active in /api/neptun-alerts
  trail?:      TrailPoint[]; // oldest-to-newest, capped at TRAIL_MAX_POINTS; last entry == this feature's geometry coords
}

export interface UnifiedThreatFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] }; // [lng, lat]
  properties: UnifiedThreatProperties;
}

export interface UnifiedThreatFeatureCollection {
  type: 'FeatureCollection';
  features: UnifiedThreatFeature[];
}

export interface UnifiedThreatsResponse {
  features:      UnifiedThreatFeatureCollection;
  alarm_vectors: unknown[];
  uav_count:     number;
  timestamp:     string;
}

// ---------------------------------------------------------------------------
// Cache + inflight coalescence
// ---------------------------------------------------------------------------

const CACHE_TTL = 60_000;

let cached: UnifiedThreatsResponse | null = null;
let cachedAt = 0;
let inflight: Promise<UnifiedThreatsResponse> | null = null;

// ---------------------------------------------------------------------------
// Upstream response shapes (narrowed from JSON; only fields we use)
// ---------------------------------------------------------------------------

interface KabThreat {
  oblast?: string;
  regionName?: string;
  lat?: number;
  lng?: number;
  place?: string;
  count?: number;
  startedAt?: string;
  sources?: string[];
}

interface KabData {
  threats?: KabThreat[];
}

interface DroneWaypoint {
  lat?: number;
  lng?: number;
  oblast?: string;
  place?: string;
  ts?: string;
  channel?: string;
  confidence?: number;
  subtype?: 'FPV' | 'RECON' | 'UAV';
  bearing?: number | null;
  alarmConfirmed?: boolean;
}

interface DroneWave {
  waypoints?: DroneWaypoint[];
}

interface DroneData {
  waves?: DroneWave[];
  alarm_vectors?: unknown[];
  uav_count?: number;
}

interface MissileWaypoint {
  lat?: number;
  lng?: number;
  oblast?: string;
  place?: string;
  ts?: string;
  channel?: string;
  confidence?: number;
  alarmConfirmed?: boolean;
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

interface Mig31kDetection {
  lat?: number | null;
  lng?: number | null;
  locationName?: string;
  detectedAt?: string;
  count?: number;
  sources?: string[];
}

interface Mig31kData {
  detections?: Mig31kDetection[];
}

interface NeptunData {
  updatedAt?: string | null;
  activeKeys?: string[];
}

interface AirRaidAlert {
  oblast?: string;
}

interface AirRaidData {
  alerts?: AirRaidAlert[];
  error?: unknown;
}

// ---------------------------------------------------------------------------
// Display titles (Ukrainian), per unified type
// ---------------------------------------------------------------------------

const TITLES: Record<UnifiedThreatType, string> = {
  fpv:       'FPV-дрон',
  cruise:    'Крилата ракета',
  ballistic: 'Балістична ракета',
  kab:       'Керована авіабомба',
  aviation:  'Авіація·МіГ-31К',
  recon:     'Розвідувальний БпЛА',
  uav:       'БпЛА',
};

// Ballistic-family missile types collapse into a single 'ballistic' bucket.
const BALLISTIC_FAMILY = new Set(['BALLISTIC', 'KINZHAL', 'S300', 'KH22']);

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

async function computeUnifiedThreats(): Promise<UnifiedThreatsResponse> {
  const base = process.env.OSIRIS_SELF_ORIGIN ?? 'http://127.0.0.1:3000';

  const [kabRes, droneRes, missileRes, mig31kRes, neptunRes, airRaidRes] = await Promise.allSettled([
    fetch(`${base}/api/kab-threats`,     { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() as Promise<KabData>     : null),
    fetch(`${base}/api/drone-threats`,   { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() as Promise<DroneData>   : null),
    fetch(`${base}/api/missile-threats`, { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() as Promise<MissileData> : null),
    fetch(`${base}/api/mig31k`,          { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() as Promise<Mig31kData>  : null),
    fetch(`${base}/api/neptun-alerts`,   { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() as Promise<NeptunData>  : null),
    fetch(`${base}/api/air-raids`,       { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() as Promise<AirRaidData> : null),
  ]);

  const kabData     = kabRes.status     === 'fulfilled' ? kabRes.value     : null;
  const droneData   = droneRes.status   === 'fulfilled' ? droneRes.value   : null;
  const missileData = missileRes.status === 'fulfilled' ? missileRes.value : null;
  const mig31kData  = mig31kRes.status   === 'fulfilled' ? mig31kRes.value  : null;
  const neptunData  = neptunRes.status  === 'fulfilled' ? neptunRes.value  : null;
  const airRaidData = airRaidRes.status === 'fulfilled' ? airRaidRes.value : null;

  if (kabRes.status === 'rejected')     console.warn('[OSIRIS] threats: kab-threats fetch failed:', kabRes.reason);
  if (droneRes.status === 'rejected')   console.warn('[OSIRIS] threats: drone-threats fetch failed:', droneRes.reason);
  if (missileRes.status === 'rejected') console.warn('[OSIRIS] threats: missile-threats fetch failed:', missileRes.reason);
  if (mig31kRes.status === 'rejected')  console.warn('[OSIRIS] threats: mig31k fetch failed:', mig31kRes.reason);
  if (neptunRes.status === 'rejected')  console.warn('[OSIRIS] threats: neptun-alerts fetch failed:', neptunRes.reason);
  if (airRaidRes.status === 'rejected') console.warn('[OSIRIS] threats: air-raids fetch failed:', airRaidRes.reason);

  // Corroboration sources for the live-alarm filter below. Each derives to
  // `null` when its source is unusable (rejected/non-ok/malformed/degraded),
  // which signals "skip this check" rather than "nothing is active" — an
  // empty-but-valid Set (no active raions/oblasts right now) is a real signal
  // and must NOT collapse to null, or every waypoint would look confirmed.
  // `updatedAt` is null on neptun-alerts' own stale-error fallback even when
  // activeKeys is still a valid (possibly populated) array — gate on the
  // array shape only, not the optional timestamp.
  const neptunKeys: Set<string> | null =
    neptunData && Array.isArray(neptunData.activeKeys)
      ? new Set(neptunData.activeKeys)
      : null;

  // air-raids' stale-but-good path returns HTTP 200 with a populated `alerts`
  // array AND a truthy `error` string — exactly the case where corroboration
  // matters most. Gate on the array shape only, not the optional error field.
  const alarmedOblasts: Set<string> | null =
    airRaidData && Array.isArray(airRaidData.alerts)
      ? new Set(airRaidData.alerts.map(a => String(a.oblast ?? '').toLowerCase()))
      : null;

  const features: UnifiedThreatFeature[] = [];

  // -------------------------------------------------------------------------
  // KAB — one feature per oblast-level threat entry
  // -------------------------------------------------------------------------
  if (kabData?.threats && Array.isArray(kabData.threats)) {
    for (const t of kabData.threats) {
      if (typeof t.lat !== 'number' || typeof t.lng !== 'number' || !isFinite(t.lat) || !isFinite(t.lng)) continue;
      const oblast = typeof t.oblast === 'string' ? t.oblast : (typeof t.regionName === 'string' ? t.regionName : 'Unknown');
      // Confidence = distinct reporting channels, matching the drone/missile
      // semantics — NOT raw mention count (t.count counts repeat posts from
      // the same channel, which would misrepresent corroboration strength).
      const confidence = Array.isArray(t.sources) ? t.sources.length : 0;
      const place = typeof t.place === 'string' ? t.place : undefined;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [t.lng, t.lat] },
        properties: {
          tid: `kab|${place ?? oblast}`,
          ttype: 'kab',
          title: TITLES.kab,
          place,
          oblast,
          confidence,
          band: confidenceBand(confidence),
          bearing: null, // KAB threats carry no computed bearing signal
          approximate: !t.place, // oblast-centroid fallback only when no city resolved
          sources: confidence,
          ts: typeof t.startedAt === 'string' ? t.startedAt : new Date().toISOString(),
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Drone-threats waypoints — grouped into per-object chains (splitWaveIntoChains)
  // so a tracked UAV relocates across polls instead of leaving N disconnected
  // static markers. Each chain -> exactly ONE feature, positioned at the
  // chain's most recent waypoint, carrying a `trail` of its recent history.
  // -------------------------------------------------------------------------
  if (droneData?.waves && Array.isArray(droneData.waves)) {
    for (const wave of droneData.waves) {
      if (!Array.isArray(wave.waypoints)) continue;

      // splitWaveIntoChains requires RouteWaypoint's non-optional `text`;
      // DroneWaypoint (this route's narrowed upstream shape) has no `text`
      // field, so stub it in — chain-splitting never reads `text`.
      const validWaypoints = wave.waypoints.filter(
        (wp): wp is DroneWaypoint & { lat: number; lng: number; oblast: string; ts: string; channel: string } =>
          typeof wp.lat === 'number' && isFinite(wp.lat) &&
          typeof wp.lng === 'number' && isFinite(wp.lng) &&
          typeof wp.oblast === 'string' &&
          typeof wp.ts === 'string' &&
          typeof wp.channel === 'string',
      );
      if (validWaypoints.length === 0) continue;

      const routeWaypoints = validWaypoints.map((wp) => ({ ...wp, text: '' }));
      const chains = splitWaveIntoChains(routeWaypoints, DRONE_CHAIN_MAX_KMH);

      for (const chain of chains) {
        if (chain.length === 0) continue;
        const last = chain[chain.length - 1];
        const first = chain[0];

        const ttype: UnifiedThreatType =
          last.subtype === 'FPV' ? 'fpv' : last.subtype === 'RECON' ? 'recon' : 'uav';
        const confidence = typeof last.confidence === 'number' ? last.confidence : 0;

        const trailSlice = chain.length > TRAIL_MAX_POINTS
          ? chain.slice(chain.length - TRAIL_MAX_POINTS)
          : chain;
        const trail: TrailPoint[] = trailSlice.map((wp) => ({
          lat: wp.lat,
          lng: wp.lng,
          ts: new Date(wp.ts).getTime(),
        }));

        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [last.lng, last.lat] },
          properties: {
            // Keyed off the chain's first waypoint so a moving drone keeps the
            // same tid across polls that still see that waypoint. Coordinates
            // rounded to ~100m added to cut collisions between two distinct
            // chains that start in the same oblast within the same minute
            // (Telegram timestamps are minute-grained) — without this, both
            // chains would share one tid and click-selection would highlight
            // whichever one MapLibre happened to draw last.
            // Known limitation, accepted for this stateless-per-poll-rebuild
            // model (no persisted track store): if the chain's first waypoint
            // ages out of the rolling window, or a later-arriving waypoint
            // shifts where the 250km/h split falls, the "first" waypoint
            // changes and tid changes with it — the marker keeps moving
            // correctly, only its selection-highlight can occasionally reset.
            // Fixing that fully needs a persisted track store matching new
            // chains to prior ones by proximity+heading; out of scope here.
            tid: `${ttype}:${new Date(first.ts).getTime()}:${first.oblast}:${first.lat.toFixed(3)},${first.lng.toFixed(3)}`,
            ttype,
            title: TITLES[ttype],
            place: last.place,
            oblast: last.oblast,
            confidence,
            band: confidenceBand(confidence),
            bearing: typeof last.bearing === 'number' ? last.bearing : null,
            approximate: !last.place, // no named place resolved -> oblast-centroid fallback
            sources: confidence,   // confidence IS the distinct-channel count for waypoints
            ts: last.ts,
            alarmConfirmed: last.alarmConfirmed === true,
            trail,
          },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Missile-threats routes — split cruise vs ballistic-family via weaponType
  // -------------------------------------------------------------------------
  if (missileData?.routes && Array.isArray(missileData.routes)) {
    for (const route of missileData.routes) {
      const weaponType = typeof route.weaponType === 'string' ? route.weaponType : '';
      const ttype: UnifiedThreatType | null =
        weaponType === 'CRUISE' ? 'cruise'
        : BALLISTIC_FAMILY.has(weaponType) ? 'ballistic'
        : null;
      if (!ttype) continue; // unrecognized weaponType — skip rather than mis-bucket
      if (!Array.isArray(route.waves)) continue;

      for (const wave of route.waves) {
        if (!Array.isArray(wave.waypoints)) continue;
        for (const wp of wave.waypoints) {
          if (typeof wp.lat !== 'number' || typeof wp.lng !== 'number' || !isFinite(wp.lat) || !isFinite(wp.lng)) continue;
          const confidence = typeof wp.confidence === 'number' ? wp.confidence : 0;
          const oblast = typeof wp.oblast === 'string' ? wp.oblast : 'Unknown';
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [wp.lng, wp.lat] },
            properties: {
              tid: `${ttype}|${wp.place ?? oblast}`,
              ttype,
              title: TITLES[ttype],
              place: wp.place,
              oblast,
              confidence,
              band: confidenceBand(confidence),
              bearing: null, // missile-threats waypoints carry no bearing field today
              approximate: !wp.place,
              sources: confidence,
              ts: typeof wp.ts === 'string' ? wp.ts : new Date().toISOString(),
              alarmConfirmed: wp.alarmConfirmed === true,
            },
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // MiG-31K detections -> aviation
  // -------------------------------------------------------------------------
  if (mig31kData?.detections && Array.isArray(mig31kData.detections)) {
    for (const d of mig31kData.detections) {
      if (typeof d.lat !== 'number' || typeof d.lng !== 'number' || !isFinite(d.lat) || !isFinite(d.lng)) continue;
      // Confidence = distinct reporting channels (see KAB block above for why
      // raw mention count is the wrong metric here).
      const confidence = Array.isArray(d.sources) ? d.sources.length : 0;
      const oblast = typeof d.locationName === 'string' ? d.locationName : 'Unknown';
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [d.lng, d.lat] },
        properties: {
          tid: `aviation|${oblast}`,
          ttype: 'aviation',
          title: TITLES.aviation,
          place: d.locationName,
          oblast,
          confidence,
          band: confidenceBand(confidence),
          bearing: null, // no bearing signal for MiG-31K sightings
          approximate: false, // ADS-B/telegram-anchored point, never an oblast-centroid stub
          sources: confidence,
          ts: typeof d.detectedAt === 'string' ? d.detectedAt : new Date().toISOString(),
        },
      });
    }
  }

  // Dedupe: the underlying per-type routes each accumulate their own rolling
  // window (24h drone / 12h missile / 6h KAB) so the *same* place gets a fresh
  // feature every time it's re-mentioned, all pinned to the identical
  // coordinate — visually these stack into a single marker anyway, but they
  // inflate the feature count and hide how few distinct threats are actually
  // current. Keep only the most recent feature per (ttype, place-or-oblast)
  // so the map reflects current state; full history still lives in each
  // route's own *-tracks.json for the timeline and other consumers.
  //
  // fpv/recon/uav are EXCLUDED from this dedup: they're already one-feature-
  // per-chain (see splitWaveIntoChains above), so collapsing further by
  // place-or-oblast would re-merge two genuinely different tracked objects
  // that happen to currently sit in the same place — defeating the point of
  // chain-grouping.
  const DRONE_FAMILY_TTYPES = new Set<UnifiedThreatType>(['fpv', 'recon', 'uav']);
  const droneFamilyFeatures = features.filter((f) => DRONE_FAMILY_TTYPES.has(f.properties.ttype));
  const dedupCandidates = features.filter((f) => !DRONE_FAMILY_TTYPES.has(f.properties.ttype));

  const latestByKey = new Map<string, UnifiedThreatFeature>();
  for (const f of dedupCandidates) {
    const key = `${f.properties.ttype}|${f.properties.place ?? f.properties.oblast}`;
    const existing = latestByKey.get(key);
    if (!existing || new Date(f.properties.ts).getTime() > new Date(existing.properties.ts).getTime()) {
      latestByKey.set(key, f);
    }
  }
  const deduped = [...droneFamilyFeatures, ...Array.from(latestByKey.values())];

  // -------------------------------------------------------------------------
  // Live-alarm corroboration filter — parity with neptun.in.ua, which only
  // shows currently-active threats, not every mention inside each source's
  // rolling window (24h drone / 12h missile / 6h KAB). A feature survives if
  // it's corroborated by an active oblast-level air raid, a raion-level
  // Neptune alert, or the source route's own alarm-history check. Aviation
  // (mig31k) bypasses this filter entirely: locationName is often an RU
  // airfield, so alarm-oblast/raion matching structurally doesn't apply.
  //
  // Fail-open guard: if BOTH corroboration sources are simultaneously down,
  // skip filtering and return `deduped` unchanged. This is the exact bug
  // class fixed in commit 9bb93cc (an empty-but-valid air-raids array was
  // read as a truthy Set and stripped every waypoint) — a double-outage here
  // must never blank the whole layer.
  let filtered: UnifiedThreatFeature[];
  if (alarmedOblasts === null && neptunKeys === null) {
    filtered = deduped;
  } else {
    const candidates = deduped.filter(f => f.properties.ttype !== 'aviation');
    const raionKeys = await Promise.all(
      candidates.map(f => raionKeyForPoint(f.geometry.coordinates[1], f.geometry.coordinates[0])),
    );
    candidates.forEach((f, i) => {
      const key = raionKeys[i];
      f.properties.neptunConfirmed = neptunKeys !== null && key !== null && neptunKeys.has(key);
    });

    filtered = deduped.filter(f => {
      if (f.properties.ttype === 'aviation') return true;
      const oblastAlarmed = alarmedOblasts !== null && alarmedOblasts.has(f.properties.oblast.toLowerCase());
      return oblastAlarmed || f.properties.neptunConfirmed === true || f.properties.alarmConfirmed === true;
    });
  }

  // Stable per-response index for map click-to-select (the unified-threats
  // GeoJSON source has no generateId, so features carry no usable id otherwise).
  filtered.forEach((f, i) => { f.properties.fid = i; });

  return {
    features: { type: 'FeatureCollection', features: filtered },
    // Passed through unchanged — existing page.tsx alarm_vectors layer depends
    // on these fields continuing to exist in this exact shape.
    alarm_vectors: Array.isArray(droneData?.alarm_vectors) ? droneData!.alarm_vectors! : [],
    uav_count: typeof droneData?.uav_count === 'number' ? droneData.uav_count : 0,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route handler — inflight-coalescence mirrors correlated-events pattern
// ---------------------------------------------------------------------------

const EMPTY_RESPONSE: UnifiedThreatsResponse = {
  features: { type: 'FeatureCollection', features: [] },
  alarm_vectors: [],
  uav_count: 0,
  timestamp: new Date().toISOString(),
};

export async function GET() {
  const now = Date.now();
  const headers = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' };

  if (cached && now - cachedAt < CACHE_TTL) {
    return NextResponse.json(cached, { headers });
  }

  if (inflight) {
    try {
      return NextResponse.json(await inflight, { headers });
    } catch {
      return NextResponse.json(cached ?? EMPTY_RESPONSE, { headers });
    }
  }

  inflight = computeUnifiedThreats();
  try {
    const data = await inflight;
    cached = data;
    cachedAt = Date.now();
    return NextResponse.json(data, { headers });
  } catch (error) {
    console.error('[OSIRIS] unified threats compute error:', error);
    // Stale-on-error: never serve empty if we have something, never 5xx either.
    return NextResponse.json(cached ?? EMPTY_RESPONSE, { headers });
  } finally {
    inflight = null;
  }
}
