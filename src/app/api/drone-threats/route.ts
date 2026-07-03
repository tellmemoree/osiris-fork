import { NextResponse } from 'next/server';
import { getThreatCorpus, classifyWeapons, matchOblasts, buildRoute, extractUAVCount } from '@/lib/telegram-threats';
import type { OblastRef, RouteWave } from '@/lib/telegram-threats';
import { readAlarmHistory, isOblastAlarmed, buildAlarmVectors } from '@/lib/alarm-history';
import type { AlarmVector } from '@/lib/alarm-history';
import {
  DRONE_TRACKS_FILE, DRONE_TRACK_TTL_MS,
  loadTrackEntries, mergeAndSaveTracks, buildWavesFromEntries, wavesToTrackEntries,
} from '@/lib/threat-tracks';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Drone Threat Signal (Telegram-derived)
 *
 * Thin route on top of the shared telegram-threats corpus.
 * Filters the 1.5-h message window for DRONE weapon mentions
 * (Shahed / Geran / БПЛА / drone-kamikaze / мопед patterns), then:
 *   1. Aggregates one DroneEvent per affected oblast (active threats).
 *   2. Extracts route waypoints and persists them to drone-route-tracks.json.
 *   3. Returns routes built from the full 24h accumulated history so the
 *      complete attack trajectory is visible, not just the last 1.5 h.
 *
 * Cache: 60 s route-level (processed result).
 * The underlying corpus is cached 15 min in telegram-threats.ts, so actual
 * Telegram scrapes happen at most once per 15 min regardless of traffic.
 */

const WINDOW_HOURS = 1.5;
const CACHE_TTL_MS = 60_000;

interface DroneEvent {
  oblast:      string;
  regionName:  string;
  level:       'oblast';
  alertType:   'DRONE';
  lat:         number;
  lng:         number;
  count:       number;
  startedAt:   string;
  text:        string;
  sources:     string[];
}

interface DroneResponse {
  threats:       DroneEvent[];
  waves:         RouteWave[];
  total:         number;
  window_hours:  number;
  timestamp:     string;
  uav_count?:    number;
  alarm_vectors?: AlarmVector[];
}

// ── module-level cache + cold-start seed ─────────────────────────────────────

let cached:   DroneResponse | null = null;
let cachedAt                       = 0;
let inflight: Promise<DroneResponse> | null = null;

// Seed in-memory with stored history on module load so first request is instant
let trackSeed = loadTrackEntries(DRONE_TRACKS_FILE);

// ── builder ──────────────────────────────────────────────────────────────────

async function buildDroneResponse(): Promise<DroneResponse> {
  const messages = await getThreatCorpus();

  type AggEntry = {
    ref:        OblastRef;
    count:      number;
    latestTs:   number;
    latestText: string;
    sources:    Set<string>;
  };

  const agg = new Map<string, AggEntry>();

  for (const msg of messages) {
    if (!classifyWeapons(msg.text).includes('DRONE')) continue;
    const refs = matchOblasts(msg.text);
    if (refs.length === 0) continue;

    for (const ref of refs) {
      const cur = agg.get(ref.oblast);
      if (!cur) {
        agg.set(ref.oblast, {
          ref,
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
  }

  const threats: DroneEvent[] = Array.from(agg.values())
    .map((a) => ({
      oblast:     a.ref.oblast,
      regionName: a.ref.oblast,
      level:      'oblast' as const,
      alertType:  'DRONE'  as const,
      lng:        a.ref.coords[0],
      lat:        a.ref.coords[1],
      count:      a.count,
      startedAt:  new Date(a.latestTs).toISOString(),
      text:       a.latestText.length > 220 ? a.latestText.slice(0, 220) + '…' : a.latestText,
      sources:    Array.from(a.sources).map((s) => `t.me/${s}`),
    }))
    .sort((x, y) => new Date(y.startedAt).getTime() - new Date(x.startedAt).getTime());

  // Build current-corpus waves and annotate with alarm history; build alarm
  // vectors in parallel (reads from disk — no upstream fetch).
  const currentWaves = buildRoute(messages, 'DRONE');
  const [alarmHistory, alarmVectors] = await Promise.all([
    readAlarmHistory(),
    buildAlarmVectors(),
  ]);
  for (const wave of currentWaves) {
    for (const wp of wave.waypoints) {
      wp.alarmConfirmed = isOblastAlarmed(wp.oblast, wp.ts, alarmHistory);
    }
  }

  // UAV count: apply after buildRoute() so messages are already deduplicated
  // at the corpus level; extractUAVCount takes MAX across all drone messages.
  const droneTexts = messages
    .filter(msg => classifyWeapons(msg.text).includes('DRONE'))
    .map(msg => msg.text);
  const uavCount = extractUAVCount(droneTexts);

  // Merge new waypoints into 24h track history
  const newEntries = wavesToTrackEntries(currentWaves, 'DRONE');
  const accumulated = await mergeAndSaveTracks(DRONE_TRACKS_FILE, DRONE_TRACK_TTL_MS, newEntries);

  // Return routes built from full 24h history (supersedes the 1.5h currentWaves)
  const waves = buildWavesFromEntries(accumulated);

  return {
    threats,
    waves,
    total:         threats.length,
    window_hours:  WINDOW_HOURS,
    timestamp:     new Date().toISOString(),
    uav_count:     uavCount,
    alarm_vectors: alarmVectors,
  };
}

// ── route handler ────────────────────────────────────────────────────────────

export async function GET() {
  const now = Date.now();

  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }

  // Serve stale immediately while recomputing (cold-start: serve seed if available)
  if (!cached) {
    const seed = await trackSeed;
    if (seed.length > 0) {
      const seedWaves = buildWavesFromEntries(seed);
      cached = {
        threats:       [],
        waves:         seedWaves,
        total:         0,
        window_hours:  WINDOW_HOURS,
        timestamp:     new Date().toISOString(),
        uav_count:     0,
        alarm_vectors: [],
      };
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
        { threats: [], waves: [], total: 0, window_hours: WINDOW_HOURS, uav_count: 0, alarm_vectors: [], error: 'Failed to fetch drone threats' },
        { status: 500 },
      );
    }
  }

  // Stale-while-revalidate: return stale immediately, compute in background
  if (cached) {
    inflight = buildDroneResponse();
    inflight.then(data => { cached = data; cachedAt = Date.now(); }).catch(() => {}).finally(() => { inflight = null; });
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }

  inflight = buildDroneResponse();
  try {
    const data = await inflight;
    cached   = data;
    cachedAt = Date.now();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  } catch (error) {
    console.error('[OSIRIS] drone-threats fetch error:', error);
    return NextResponse.json(
      {
        threats:       [],
        waves:         [],
        total:         0,
        window_hours:  WINDOW_HOURS,
        uav_count:     0,
        alarm_vectors: [],
        error:         error instanceof Error ? error.message : 'Failed to fetch drone threats',
      },
      { status: 500 },
    );
  } finally {
    inflight = null;
  }
}
