import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const DATA_DIR = process.env.OSIRIS_DATA_DIR ?? path.join(process.env.HOME ?? os.homedir(), '.osiris-data');
const FILE = path.join(DATA_DIR, 'air-raid-history.json');

export interface AlarmSnap { ts: string; active: string[]; }

export async function readAlarmHistory(): Promise<AlarmSnap[]> {
  try {
    const txt = await fs.readFile(FILE, 'utf8');
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// Returns true if `oblast` had an active air-raid alarm at any 5-min snapshot
// within the given window around `isoTs`. Uses lowercase comparison so
// "Kharkiv oblast" matches regardless of casing in the stored history.
export function isOblastAlarmed(
  oblast: string,
  isoTs: string,
  history: AlarmSnap[],
  windowBeforeMs = 45 * 60_000,
  windowAfterMs  = 45 * 60_000,
): boolean {
  const ts = new Date(isoTs).getTime();
  if (isNaN(ts) || history.length === 0) return false;
  const from = ts - windowBeforeMs;
  const to   = ts + windowAfterMs;
  const norm = oblast.toLowerCase();
  return history.some(snap => {
    const snapTs = new Date(snap.ts).getTime();
    if (isNaN(snapTs) || snapTs < from || snapTs > to) return false;
    return snap.active.some(a => a.toLowerCase() === norm);
  });
}

// ── alarm vectors ─────────────────────────────────────────────────────────────

// Oblast centroid map: [lng, lat] — MapLibre convention (lng first).
// Covers all 25 oblasts + Kyiv city that appear in the alarm history feed.
const UA_OBLAST_CENTROIDS: Record<string, [number, number]> = {
  'Kyiv Oblast':                [30.516, 50.073],
  'Kyiv':                       [30.523, 50.450], // city distinct from oblast
  'Chernihiv Oblast':           [31.300, 51.498],
  'Sumy Oblast':                [34.799, 50.910],
  'Kharkiv Oblast':             [36.296, 49.993],
  'Zaporizhzhia Oblast':        [35.144, 47.838],
  'Dnipropetrovsk Oblast':      [34.985, 48.464],
  'Poltava Oblast':             [34.552, 49.588],
  'Cherkasy Oblast':            [31.457, 49.444],
  'Kirovohrad Oblast':          [32.262, 48.508],
  'Mykolaiv Oblast':            [31.992, 46.975],
  'Odesa Oblast':               [30.732, 46.482],
  'Vinnytsia Oblast':           [28.468, 49.233],
  'Khmelnytskyi Oblast':        [26.987, 49.422],
  'Zhytomyr Oblast':            [28.658, 50.254],
  'Rivne Oblast':               [26.252, 50.620],
  'Volyn Oblast':               [24.720, 51.258],
  'Lviv Oblast':                [24.029, 49.842],
  'Ivano-Frankivsk Oblast':     [24.711, 48.923],
  'Ternopil Oblast':            [25.594, 49.554],
  'Zakarpattia Oblast':         [22.722, 48.620],
  'Chernivtsi Oblast':          [25.935, 48.293],
  'Kherson Oblast':             [32.616, 46.636],
  'Luhansk Oblast':             [38.934, 48.574],
  'Donetsk Oblast':             [37.802, 48.015],
  // Occupied territories — feed emits these; include so vector chains through south don't silently break
  'Crimea':                     [34.102, 44.952],
  'Sevastopol':                 [33.526, 44.616],
};

// Geographic adjacency: only adjacent oblasts can form a propagation vector.
// Non-adjacent pairs in a wave reflect simultaneous activations, not directionality.
const UA_OBLAST_ADJACENCY: Record<string, string[]> = {
  'Chernihiv Oblast':           ['Kyiv Oblast', 'Sumy Oblast'],                          // not adjacent to Cherkasy (Kyiv Oblast between)
  'Sumy Oblast':                ['Chernihiv Oblast', 'Poltava Oblast', 'Kharkiv Oblast'],
  'Kharkiv Oblast':             ['Sumy Oblast', 'Poltava Oblast', 'Dnipropetrovsk Oblast', 'Donetsk Oblast', 'Luhansk Oblast'],
  'Luhansk Oblast':             ['Kharkiv Oblast', 'Donetsk Oblast'],
  'Donetsk Oblast':             ['Kharkiv Oblast', 'Luhansk Oblast', 'Zaporizhzhia Oblast', 'Dnipropetrovsk Oblast'],
  'Zaporizhzhia Oblast':        ['Donetsk Oblast', 'Dnipropetrovsk Oblast', 'Kherson Oblast'],
  'Kherson Oblast':             ['Zaporizhzhia Oblast', 'Mykolaiv Oblast', 'Crimea', 'Dnipropetrovsk Oblast'],
  'Crimea':                     ['Kherson Oblast', 'Sevastopol'],
  'Sevastopol':                 ['Crimea'],
  'Mykolaiv Oblast':            ['Kherson Oblast', 'Odesa Oblast', 'Dnipropetrovsk Oblast', 'Kirovohrad Oblast'],
  'Odesa Oblast':               ['Mykolaiv Oblast', 'Kirovohrad Oblast', 'Vinnytsia Oblast'],
  'Dnipropetrovsk Oblast':      ['Kharkiv Oblast', 'Donetsk Oblast', 'Zaporizhzhia Oblast', 'Kherson Oblast', 'Mykolaiv Oblast', 'Kirovohrad Oblast', 'Poltava Oblast'],
  'Poltava Oblast':             ['Sumy Oblast', 'Kharkiv Oblast', 'Dnipropetrovsk Oblast', 'Kirovohrad Oblast', 'Cherkasy Oblast', 'Kyiv Oblast'],
  'Kirovohrad Oblast':          ['Dnipropetrovsk Oblast', 'Mykolaiv Oblast', 'Odesa Oblast', 'Vinnytsia Oblast', 'Cherkasy Oblast', 'Poltava Oblast'],
  'Cherkasy Oblast':            ['Kyiv Oblast', 'Poltava Oblast', 'Kirovohrad Oblast', 'Vinnytsia Oblast'], // not adjacent to Khmelnytskyi or Zhytomyr
  'Kyiv Oblast':                ['Chernihiv Oblast', 'Poltava Oblast', 'Cherkasy Oblast', 'Vinnytsia Oblast', 'Zhytomyr Oblast', 'Kyiv'], // not adjacent to Sumy (Chernihiv between)
  'Kyiv':                       ['Kyiv Oblast'],
  'Zhytomyr Oblast':            ['Kyiv Oblast', 'Vinnytsia Oblast', 'Khmelnytskyi Oblast', 'Rivne Oblast'],  // not adjacent to Cherkasy or Volyn
  'Vinnytsia Oblast':           ['Kyiv Oblast', 'Cherkasy Oblast', 'Kirovohrad Oblast', 'Odesa Oblast', 'Khmelnytskyi Oblast', 'Zhytomyr Oblast'],
  'Khmelnytskyi Oblast':        ['Zhytomyr Oblast', 'Vinnytsia Oblast', 'Ternopil Oblast', 'Rivne Oblast'],  // not adjacent to Lviv (Ternopil between) or Cherkasy
  'Rivne Oblast':               ['Volyn Oblast', 'Zhytomyr Oblast', 'Khmelnytskyi Oblast', 'Ternopil Oblast', 'Lviv Oblast'],
  'Volyn Oblast':               ['Rivne Oblast', 'Lviv Oblast'],                                             // not adjacent to Zhytomyr (Rivne between)
  'Lviv Oblast':                ['Volyn Oblast', 'Rivne Oblast', 'Ternopil Oblast', 'Ivano-Frankivsk Oblast', 'Zakarpattia Oblast'], // not adjacent to Khmelnytskyi (Ternopil between)
  'Ternopil Oblast':            ['Rivne Oblast', 'Khmelnytskyi Oblast', 'Lviv Oblast', 'Ivano-Frankivsk Oblast', 'Chernivtsi Oblast'],
  'Ivano-Frankivsk Oblast':     ['Lviv Oblast', 'Ternopil Oblast', 'Chernivtsi Oblast', 'Zakarpattia Oblast'],
  'Zakarpattia Oblast':         ['Lviv Oblast', 'Ivano-Frankivsk Oblast'],
  'Chernivtsi Oblast':          ['Ternopil Oblast', 'Ivano-Frankivsk Oblast'],
};

// Dev-time integrity check — mismatched keys silently drop vectors
if (process.env.NODE_ENV !== 'production') {
  for (const k of Object.keys(UA_OBLAST_ADJACENCY)) {
    if (!UA_OBLAST_CENTROIDS[k]) console.warn(`[alarm-history] adjacency key '${k}' not in centroid map`);
  }
}

// Normalise oblast names coming from the history file (which uses "Kharkiv oblast"
// lowercase "o") to match the centroid map keys (title-case "Oblast").
function normKey(name: string): string {
  return name.replace(/\s+oblast$/i, ' Oblast').replace(/\boblast\b/i, 'Oblast');
}

export interface AlarmVector {
  id:         string;
  fromOblast: string;
  toOblast:   string;
  fromLat:    number;
  fromLng:    number;
  toLat:      number;
  toLng:      number;
  bearing:    number;   // degrees, for icon-rotate in MapLibre
  confidence: 'high' | 'medium';
  ts:         string;   // ISO — timestamp of the second (destination) oblast's activation
}

// Only consider snaps from the last 2 hours: stale snaps produce misleading vectors.
const RECENT_WINDOW_MS = 2 * 60 * 60 * 1_000;

// Waves close when > 40 min elapses with no new activations.
const VECTOR_WINDOW_MS = 40 * 60 * 1_000;

// Euclidean distance thresholds (degrees) — fine for this scale.
// 0.5 filters Kyiv city↔Kyiv Oblast (centroid gap ~0.38°) while preserving
// real adjacent pairs like Zaporizhzhia↔Dnipropetrovsk (0.65°) and Kherson↔Mykolaiv (0.71°).
const MIN_DIST_DEG = 0.5;
const MAX_DIST_DEG = 8.0;

function euclidDist(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const dLng = bLng - aLng;
  const dLat = bLat - aLat;
  return Math.sqrt(dLng * dLng + dLat * dLat);
}

/**
 * Reads the stored air-raid history, finds oblasts that newly activate in
 * temporal succession within the last 2 hours, and derives propagation
 * vectors between consecutive activations within each wave.
 *
 * Returns [] if the history file is missing, unreadable, or contains no
 * recent data.
 */
export async function buildAlarmVectors(): Promise<AlarmVector[]> {
  let snaps: AlarmSnap[];
  try {
    snaps = await readAlarmHistory();
  } catch {
    return [];
  }

  if (snaps.length === 0) return [];

  const cutoff = Date.now() - RECENT_WINDOW_MS;

  // Filter to recent snaps only; sort by time ascending.
  const recent = snaps
    .filter(s => {
      const t = new Date(s.ts).getTime();
      return !isNaN(t) && t >= cutoff;
    })
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  if (recent.length < 2) return [];

  // Walk snaps; collect newly-activated oblasts per snap (Set difference).
  interface ActivationEvent {
    oblast: string;
    ts: number; // epoch ms of the snap where this oblast first appeared in the wave
  }

  const vectors: AlarmVector[] = [];
  let prevActive = new Set<string>(recent[0].active.map(normKey));

  // Accumulate activation events into time-contiguous waves.
  // Each wave is a list of (oblast, ts) pairs in time order.
  const waves: ActivationEvent[][] = [];
  let currentWave: ActivationEvent[] = [];
  let lastActivationTs = new Date(recent[0].ts).getTime();

  for (let i = 1; i < recent.length; i++) {
    const snap = recent[i];
    const snapTs = new Date(snap.ts).getTime();
    const activeNow = new Set(snap.active.map(normKey));

    // Newly activated: in activeNow but not prevActive
    const newlyActive: string[] = [];
    for (const name of activeNow) {
      if (!prevActive.has(name)) newlyActive.push(name);
    }

    if (newlyActive.length > 0) {
      // Gap check: if too long since last activation, close current wave and start fresh
      if (currentWave.length > 0 && snapTs - lastActivationTs > VECTOR_WINDOW_MS) {
        waves.push(currentWave);
        currentWave = [];
      }
      for (const oblast of newlyActive) {
        currentWave.push({ oblast, ts: snapTs });
      }
      lastActivationTs = snapTs;
    }

    prevActive = activeNow;
  }
  if (currentWave.length > 0) waves.push(currentWave);

  // Build vectors within each wave.
  for (const wave of waves) {
    if (wave.length < 2) continue;

    const confidence: 'high' | 'medium' = wave.length >= 3 ? 'high' : 'medium';

    for (let i = 0; i + 1 < wave.length; i++) {
      const from = wave[i];
      const to   = wave[i + 1];

      if (from.oblast === to.oblast) continue;

      // Same 5-min snapshot = simultaneous alarms, not sequential — bearing is noise
      if (from.ts === to.ts) continue;
      // Adjacency gate: non-adjacent oblasts cannot be connected (critical for correctness)
      if (!UA_OBLAST_ADJACENCY[from.oblast]?.includes(to.oblast)) continue;

      const fromCoords = UA_OBLAST_CENTROIDS[from.oblast];
      const toCoords   = UA_OBLAST_CENTROIDS[to.oblast];
      if (!fromCoords || !toCoords) continue;

      const [fromLng, fromLat] = fromCoords;
      const [toLng,   toLat]   = toCoords;

      const dist = euclidDist(fromLng, fromLat, toLng, toLat);
      if (dist < MIN_DIST_DEG || dist > MAX_DIST_DEG) continue;

      // Bearing in degrees; convention matches MapLibre icon-rotate.
      const bearing = Math.atan2(toLng - fromLng, toLat - fromLat) * 180 / Math.PI;

      vectors.push({
        id:         `${from.oblast}→${to.oblast}@${to.ts}`,
        fromOblast: from.oblast,
        toOblast:   to.oblast,
        fromLat,
        fromLng,
        toLat,
        toLng,
        bearing,
        confidence,
        ts: new Date(to.ts).toISOString(),
      });
    }
  }

  return vectors;
}
