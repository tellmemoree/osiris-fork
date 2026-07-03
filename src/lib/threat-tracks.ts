/**
 * OSIRIS — Drone / Missile Route Track Persistence
 *
 * Mirrors the shadow-fleet track ring-buffer pattern for drone and missile
 * route waypoints. Each route-build extracts new waypoints from the corpus,
 * merges them with the stored history, prunes old entries, and writes back.
 *
 * On cold-start, the stored history lets routes render immediately without
 * waiting for a fresh Telegram scrape.
 *
 * File layout:
 *   ~/.osiris-data/drone-route-tracks.json   — 24h rolling window
 *   ~/.osiris-data/missile-route-tracks.json — 12h rolling window
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { WAVE_GAP_MS, waveGapFor, msgFingerprint, type WeaponType, type RouteWave, type RouteWaypoint } from '@/lib/telegram-threats';

const DATA_DIR = path.join(os.homedir(), '.osiris-data');

export const DRONE_TRACKS_FILE   = path.join(DATA_DIR, 'drone-route-tracks.json');
export const MISSILE_TRACKS_FILE = path.join(DATA_DIR, 'missile-route-tracks.json');

export const DRONE_TRACK_TTL_MS   = 24 * 60 * 60 * 1000; // 24h — Shahed swarms span hours
export const MISSILE_TRACK_TTL_MS = 12 * 60 * 60 * 1000; // 12h — missile strikes are fast

// WAVE_GAP_MS imported from telegram-threats.ts — single source of truth

export interface TrackEntry {
  weaponType:     string;
  ts:             number;  // epoch ms — sort key and dedup anchor
  channel:        string;
  oblast:         string;
  lat:            number;
  lng:            number;
  text:           string;
  alarmConfirmed: boolean;
  fingerprint?:   string;  // optional — old on-disk entries lack it
}

// ── disk I/O ──────────────────────────────────────────────────────────────────

export async function loadTrackEntries(file: string): Promise<TrackEntry[]> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return (raw as TrackEntry[]).filter(
      e => typeof e?.ts === 'number' && isFinite(e.ts) &&
           typeof e?.lat === 'number' && isFinite(e.lat) &&
           typeof e?.lng === 'number' && isFinite(e.lng) &&
           typeof e?.weaponType === 'string' &&
           typeof e?.channel === 'string' &&
           typeof e?.oblast === 'string',
    );
  } catch {
    return [];
  }
}

async function saveTrackEntries(file: string, entries: TrackEntry[]): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(file, JSON.stringify(entries));
  } catch { /* non-fatal */ }
}

// ── merge ─────────────────────────────────────────────────────────────────────

/**
 * Merges `incoming` entries into the stored history, prunes entries older
 * than `ttlMs`, deduplicates by `${weaponType}:${channel}:${ts}`, writes back
 * to disk, and returns the updated array.
 *
 * weaponType is part of the dedup key because the missile file is shared by all
 * missile types: a single message classified as two types (e.g. the generic
 * `ракетн` fallback co-firing with a specific type) produces two entries with
 * the same channel+ts but different weaponType, and both must be kept.
 */
export async function mergeAndSaveTracks(
  file:     string,
  ttlMs:    number,
  incoming: TrackEntry[],
): Promise<TrackEntry[]> {
  if (incoming.length === 0) {
    // Still prune stale entries even if there is nothing new
    const existing = (await loadTrackEntries(file)).filter(e => e.ts > Date.now() - ttlMs);
    await saveTrackEntries(file, existing);
    return existing;
  }

  const cutoff  = Date.now() - ttlMs;
  const existing = (await loadTrackEntries(file)).filter(e => e.ts > cutoff);

  const seen = new Set(existing.map(e => `${e.weaponType}:${e.channel}:${e.ts}`));
  for (const entry of incoming) {
    const key = `${entry.weaponType}:${entry.channel}:${entry.ts}`;
    if (!seen.has(key)) {
      existing.push(entry);
      seen.add(key);
    }
  }

  existing.sort((a, b) => a.ts - b.ts);
  await saveTrackEntries(file, existing);
  return existing;
}

// ── wave building ─────────────────────────────────────────────────────────────

/**
 * Converts stored TrackEntry[] into RouteWave[] using the same logic as
 * buildRoute() in telegram-threats.ts (sort by ts, per-weapon wave gaps,
 * skip consecutive same-oblast waypoints, propagate confidence).
 *
 * Call this with the 24h (or 12h) accumulated entry set (pre-filtered to one
 * weapon type) to get the full historical route back as waves the client already
 * knows how to render.
 *
 * Uses waveGapFor(weaponType) to mirror buildRoute() exactly — mismatched gap
 * values would cause the reconstructed route to differ from what was stored.
 * Falls back to WAVE_GAP_MS if no entries are present or weaponType is unknown.
 */
export function buildWavesFromEntries(entries: TrackEntry[]): RouteWave[] {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);

  // Derive weapon type from first entry; all entries in a typed call share the same type
  const weaponType = sorted[0]?.weaponType as WeaponType | undefined;
  const gapMs = weaponType ? waveGapFor(weaponType) : WAVE_GAP_MS;

  const waves: RouteWave[] = [];
  let current: RouteWaypoint[] = [];
  let currentChannels = new Set<string>();
  let lastTs = 0;

  const flush = () => {
    if (current.length > 0) {
      // Recompute confidence from accumulated channels — do not copy stale per-entry
      // values which were frozen at the 1.5h corpus window, not the 12h rebuild window.
      const conf = currentChannels.size;
      for (const wp of current) wp.confidence = conf;
      waves.push({
        waveIndex:  waves.length,
        startedAt:  current[0].ts,
        waypoints:  [...current],
      });
      current = [];
      currentChannels = new Set<string>();
    }
  };

  for (const entry of sorted) {
    if (lastTs && entry.ts - lastTs > gapMs) flush();

    currentChannels.add(entry.channel);

    const last = current[current.length - 1];
    if (last && last.oblast === entry.oblast) {
      // Same oblast back-to-back — update lastTs but don't add a duplicate waypoint
      lastTs = entry.ts;
      continue;
    }

    current.push({
      lat:            entry.lat,
      lng:            entry.lng,
      oblast:         entry.oblast,
      ts:             new Date(entry.ts).toISOString(),
      text:           entry.text,
      channel:        entry.channel,
      alarmConfirmed: entry.alarmConfirmed,
      confidence:     undefined, // stamped by flush() after full wave is known
    });
    lastTs = entry.ts;
  }

  flush();
  return waves;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Converts RouteWave[] waypoints → TrackEntry[] for persistence. */
export function wavesToTrackEntries(
  waves:      RouteWave[],
  weaponType: string,
): TrackEntry[] {
  return waves.flatMap(wave =>
    wave.waypoints.map(wp => {
      const ts = new Date(wp.ts).getTime();
      return {
        weaponType,
        ts,
        channel:        wp.channel,
        oblast:         wp.oblast,
        lat:            wp.lat,
        lng:            wp.lng,
        text:           wp.text,
        alarmConfirmed: !!wp.alarmConfirmed,
        fingerprint:    msgFingerprint(wp.text, ts),
      };
    }),
  );
}
