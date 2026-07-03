import { NextResponse } from 'next/server';
import { getThreatCorpus, buildRoute } from '@/lib/telegram-threats';
import type { RouteWave, WeaponType } from '@/lib/telegram-threats';
import { readAlarmHistory, isOblastAlarmed } from '@/lib/alarm-history';

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

const MISSILE_TYPES = ['CRUISE', 'BALLISTIC', 'KINZHAL', 'KH22'] as const;
type MissileType = typeof MISSILE_TYPES[number];

const MISSILE_META: Record<MissileType, { label: string; color: string }> = {
  CRUISE:    { label: 'Cruise Missile',  color: '#FF4444' },
  BALLISTIC: { label: 'Ballistic',       color: '#FF8C00' },
  KINZHAL:   { label: 'Kinzhal',         color: '#FFD700' },
  KH22:      { label: 'Kh-22',           color: '#FF69B4' },
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
  routes:        MissileRoute[];
  alarm_vectors: RouteWave[];   // all waves flattened across all missile types for propagation-arrow rendering
  total:         number;
  window_hours:  number;
  timestamp:     string;
}

let cached:   MissileResponse | null = null;
let cachedAt                         = 0;
let inflight: Promise<MissileResponse> | null = null;

async function buildMissileResponse(): Promise<MissileResponse> {
  const messages = await getThreatCorpus();
  const routes: MissileRoute[] = [];

  // Load alarm history once; shared across all missile types.
  // Missiles are fast and alarms are issued PRE-EMPTIVELY — the oblast may be
  // alarmed up to 60 min before the Telegram sighting, and only 15 min after.
  const alarmHistory = await readAlarmHistory();

  for (const wt of MISSILE_TYPES) {
    const waves = buildRoute(messages, wt as WeaponType);
    if (waves.length === 0) continue;

    for (const wave of waves) {
      for (const wp of wave.waypoints) {
        wp.alarmConfirmed = isOblastAlarmed(wp.oblast, wp.ts, alarmHistory, 60 * 60_000, 15 * 60_000);
      }
    }

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
    alarm_vectors: routes.flatMap(r => r.waves),
    total:         routes.length,
    window_hours:  WINDOW_HOURS,
    timestamp:     new Date().toISOString(),
  };
}

export async function GET() {
  const now = Date.now();

  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }

  if (inflight) {
    try {
      return NextResponse.json(await inflight, {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
      });
    } catch {
      return NextResponse.json(
        { routes: [], total: 0, window_hours: WINDOW_HOURS, error: 'Failed to fetch missile threats' },
        { status: 500 },
      );
    }
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
