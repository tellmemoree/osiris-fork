import { NextResponse } from 'next/server';
import { getThreatCorpus, buildRoute } from '@/lib/telegram-threats';
import type { RouteWave, WeaponType } from '@/lib/telegram-threats';
import { readAlarmHistory, isOblastAlarmed } from '@/lib/alarm-history';
import {
  MISSILE_TRACKS_FILE, MISSILE_TRACK_TTL_MS,
  loadTrackEntries, mergeAndSaveTracks, buildWavesFromEntries, wavesToTrackEntries,
  type TrackEntry,
} from '@/lib/threat-tracks';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Missile Threat Routes (Telegram-derived)
 *
 * Builds temporal route waves for each active missile type (CRUISE, BALLISTIC,
 * KINZHAL, KH22) from the shared 1.5-h Telegram corpus.
 *
 * Analysis / probability-assessment messages are filtered out by buildRoute().
 * Multiple simultaneous waves (separate attack groups) are split at 25-min gaps.
 *
 * Cache: 60 s. Corpus: shared 15-min cache via getThreatCorpus().
 */

const WINDOW_HOURS = 1.5;
const CACHE_TTL_MS = 60_000;

const MISSILE_TYPES = ['CRUISE', 'BALLISTIC', 'KINZHAL', 'KH22', 'S300'] as const;
type MissileType = typeof MISSILE_TYPES[number];

const MISSILE_META: Record<MissileType, { label: string; color: string }> = {
  CRUISE:    { label: 'Cruise Missile',  color: '#FF4444' },
  BALLISTIC: { label: 'Ballistic',       color: '#FF8C00' },
  KINZHAL:   { label: 'Kinzhal',         color: '#FFD700' },
  KH22:      { label: 'Kh-22',           color: '#FF69B4' },
  S300:      { label: 'S-300',           color: '#9C27B0' },
};

interface MissileRoute {
  weaponType: MissileType;
  label:      string;
  color:      string;
  waves:      RouteWave[];   // one per distinct attack group
  latestAt:   string;
  sources:    string[];
}

interface MissileResponse {
  routes:       MissileRoute[];
  total:        number;
  window_hours: number;
  timestamp:    string;
}

let cached:   MissileResponse | null = null;
let cachedAt                         = 0;
let inflight: Promise<MissileResponse> | null = null;

// Seed in-memory with stored history on module load
let trackSeed = loadTrackEntries(MISSILE_TRACKS_FILE);

async function buildMissileResponse(): Promise<MissileResponse> {
  const messages = await getThreatCorpus();
  const routes: MissileRoute[] = [];

  const alarmHistory = await readAlarmHistory();

  // Collect all new waypoints across missile types for joint persistence
  const allNewEntries: TrackEntry[] = [];

  for (const wt of MISSILE_TYPES) {
    const waves = buildRoute(messages, wt as WeaponType);
    if (waves.length === 0) continue;

    for (const wave of waves) {
      for (const wp of wave.waypoints) {
        wp.alarmConfirmed = isOblastAlarmed(wp.oblast, wp.ts, alarmHistory, 60 * 60_000, 15 * 60_000);
      }
    }

    // Collect for persistence (tagged with weaponType)
    allNewEntries.push(...wavesToTrackEntries(waves, wt));
  }

  // Merge all missile waypoints into single 12h store (all types share one file;
  // weaponType field preserves per-type identity for route reconstruction)
  const accumulated = await mergeAndSaveTracks(MISSILE_TRACKS_FILE, MISSILE_TRACK_TTL_MS, allNewEntries);

  // Rebuild per-type routes from 12h accumulated history
  for (const wt of MISSILE_TYPES) {
    const typeEntries = accumulated.filter(e => e.weaponType === wt);
    if (typeEntries.length === 0) continue;

    const waves = buildWavesFromEntries(typeEntries);
    if (waves.length === 0) continue;

    const allWaypoints = waves.flatMap(w => w.waypoints);
    const sources = [...new Set(allWaypoints.map(w => `t.me/${w.channel}`))];

    routes.push({
      weaponType: wt,
      ...MISSILE_META[wt],
      waves,
      latestAt: allWaypoints[allWaypoints.length - 1].ts,
      sources,
    });
  }

  return {
    routes,
    total:        routes.length,
    window_hours: WINDOW_HOURS,
    timestamp:    new Date().toISOString(),
  };
}

export async function GET() {
  const now = Date.now();

  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }

  // Cold-start seed: populate cache from disk history before first corpus refresh
  if (!cached) {
    const seed = await trackSeed;
    if (seed.length > 0) {
      const seedRoutes: MissileRoute[] = [];
      for (const wt of MISSILE_TYPES) {
        const typeEntries = seed.filter(e => e.weaponType === wt);
        if (typeEntries.length === 0) continue;
        const waves = buildWavesFromEntries(typeEntries);
        if (waves.length === 0) continue;
        const allWps = waves.flatMap(w => w.waypoints);
        if (allWps.length === 0) continue;
        seedRoutes.push({
          weaponType: wt, ...MISSILE_META[wt], waves,
          latestAt: allWps[allWps.length - 1].ts,
          sources: [...new Set(allWps.map(w => `t.me/${w.channel}`))],
        });
      }
      cached = { routes: seedRoutes, total: seedRoutes.length, window_hours: WINDOW_HOURS, timestamp: new Date().toISOString() };
    }
  }

  if (inflight) {
    try {
      return NextResponse.json(await inflight, {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
      });
    } catch {
      if (cached) return NextResponse.json(cached, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } });
      return NextResponse.json(
        { routes: [], total: 0, window_hours: WINDOW_HOURS, error: 'Failed to fetch missile threats' },
        { status: 500 },
      );
    }
  }

  // Stale-while-revalidate: return stale immediately, compute in background
  if (cached) {
    inflight = buildMissileResponse();
    inflight.then(data => { cached = data; cachedAt = Date.now(); }).catch(() => {}).finally(() => { inflight = null; });
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }

  inflight = buildMissileResponse();
  try {
    const data = await inflight;
    cached   = data;
    cachedAt = Date.now();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  } catch (error) {
    console.error('[OSIRIS] missile-threats fetch error:', error);
    return NextResponse.json(
      { routes: [], total: 0, window_hours: WINDOW_HOURS, error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 },
    );
  } finally {
    inflight = null;
  }
}
