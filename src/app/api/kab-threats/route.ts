import { NextResponse } from 'next/server';
import { stealthFetch } from '@/lib/stealthFetch';
import path from 'path';
import os from 'os';
import { findBestPlace, matchOblasts, type OblastRef } from '@/lib/conflict-geo';
import {
  loadTrackEntries, mergeAndSaveTracks,
  type TrackEntry,
} from '@/lib/threat-tracks';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — KAB / Glide-Bomb Threat Signal (Telegram-derived)
 *
 * There is no structured, keyless feed for guided glide-bomb (KAB / UMPK) threats:
 * the binary air-raid feed (vadimklimenko) carries no threat type, and alerts.in.ua
 * has no KAB category. KAB warnings circulate as free text in Ukrainian OSINT
 * Telegram channels. This route scrapes those channels, regex-detects KAB mentions
 * (UK / RU / EN, with Unicode-aware word boundaries), attributes each to an oblast by
 * keyword, keeps only the recent window, and aggregates one threat marker per oblast.
 *
 * This is an explicitly heuristic, text-derived signal — not a structured alert.
 * It replaces the ADS-B `bomb_risk` flag as the primary KAB indicator, because the
 * aircraft launching glide bombs fly with transponders off and never appear on ADS-B.
 *
 * Disk persistence: accumulated TrackEntry[] written to ~/.osiris-data/kab-tracks.json.
 * On cold-start (e.g. after a Docker rebuild), stored entries seed the in-memory
 * accumulator so the layer is populated immediately without waiting for a fresh scrape.
 */

// UA-focused channels that routinely report inbound KAB/UMPK launches.
// GeneralStaffUA / Militaryland / ukraine_now removed — they scrape 0 messages
// and/or post after-action summaries rather than real-time warnings.
const UA_THREAT_CHANNELS = [
  'DeepStateUA', 'UkraineWarReport',
  'ua_forces', 'kpszsu', 'war_monitor',
  'vanek_nikolaev',
];

// KAB / guided-glide-bomb mentions across UK / RU / EN. The \p{L} look-arounds give
// Unicode-aware word boundaries so we don't match inside words like "кабінет",
// "кабель" or "Kabul". Requires the /u flag (present on each pattern).
const KAB_PATTERNS: RegExp[] = [
  /(?<!\p{L})каб(?:и|ів|ами|ах|у)?(?!\p{L})/iu, // КАБ + UK/RU declensions
  /(?<!\p{L})kab(?:s)?(?!\p{L})/iu,             // English "KAB"
  /(?<!\p{L})умп[кб](?!\p{L})/iu,               // УМПК / УМПБ glide-kit
  /керован\p{L}*\s+аві?абомб/iu,                // керована авіабомба / RU авиабомба
  /планир\p{L}*\s+бомб/iu,                      // RU "планирующая бомба"
  /glide[-\s]*bomb|guided\s+(?:aerial\s+)?bomb/i,
];

const WINDOW_HOURS = 1.5;
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;
const CACHE_TTL_MS = 60_000;

// ── disk persistence ──────────────────────────────────────────────────────────
const KAB_TRACKS_FILE = path.join(os.homedir(), '.osiris-data', 'kab-tracks.json');
// 6h rolling window — KAB sorties cluster within a single operational day;
// the 1.5h scrape window * 4 covers a full sortie cycle without unbounded growth.
const KAB_TRACK_TTL_MS = 6 * 60 * 60 * 1000;

// ── types ─────────────────────────────────────────────────────────────────────

interface KabThreat {
  oblast: string;
  regionName: string;
  level: 'oblast';
  alertType: 'KAB';
  lat: number;
  lng: number;
  place?: string; // city/village named in the latest mention, if resolvable — otherwise lat/lng is the oblast centroid
  count: number;
  startedAt: string; // ISO of the most recent mention
  text: string;      // snippet of the most recent mention
  sources: string[];
}

interface KabResponse {
  threats: KabThreat[];
  total: number;
  window_hours: number;
  timestamp: string;
}

interface TgMessage {
  text: string;
  ts: number; // epoch ms
}

// ── module-level cache + cold-start seed ──────────────────────────────────────

let cached: KabResponse | null = null;
let cachedAt = 0;
let inflight: Promise<KabResponse> | null = null;

// Seed in-memory on module load so first request after a Docker rebuild is instant.
// Returns a Promise<TrackEntry[]> — awaited lazily in GET before serving stale.
const trackSeed: Promise<TrackEntry[]> = loadTrackEntries(KAB_TRACKS_FILE);

// ── helpers ───────────────────────────────────────────────────────────────────

function isKab(text: string): boolean {
  return KAB_PATTERNS.some((re) => re.test(text));
}

// Extract { text, ts } per message from a Telegram /s/ HTML page.
function parseTelegramMessages(html: string): TgMessage[] {
  const out: TgMessage[] = [];
  const blocks = html.split('tgme_widget_message_wrap').slice(1);
  for (const block of blocks) {
    const textMatch = block.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
    if (!textMatch) continue;
    const text = textMatch[1]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .trim();
    if (!text || text.length < 8) continue;

    const dateMatch = block.match(/<time[^>]*datetime="([^"]+)"/i);
    const ts = dateMatch ? new Date(dateMatch[1]).getTime() : NaN;
    if (Number.isNaN(ts)) continue;
    out.push({ text, ts });
  }
  return out;
}

async function fetchChannel(channel: string): Promise<TgMessage[]> {
  try {
    const res = await stealthFetch(`https://t.me/s/${channel}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return parseTelegramMessages(await res.text());
  } catch {
    return [];
  }
}

/**
 * Rebuild KabThreat[] from accumulated TrackEntry[].
 *
 * Each TrackEntry represents one channel's mention of a KAB event in a given
 * oblast at a given timestamp. We re-aggregate by oblast to reconstruct the
 * KabThreat shape the client expects — using the most recent ts and text per
 * oblast, and collecting all contributing channels as sources.
 */
function buildThreatsFromEntries(entries: TrackEntry[]): KabThreat[] {
  type Agg = {
    lat: number; lng: number; place?: string;
    count: number; latestTs: number; latestText: string; sources: Set<string>;
  };
  const agg = new Map<string, Agg>();

  for (const e of entries) {
    const cur = agg.get(e.oblast);
    if (!cur) {
      agg.set(e.oblast, {
        lat: e.lat, lng: e.lng, place: e.place,
        count: 1,
        latestTs: e.ts,
        latestText: e.text,
        sources: new Set([e.channel]),
      });
    } else {
      cur.count += 1;
      cur.sources.add(e.channel);
      if (e.ts > cur.latestTs) {
        cur.latestTs = e.ts;
        cur.latestText = e.text;
        // Pin/place track the latest mention, same as text/ts above — an older
        // entry's resolved place shouldn't outlive the mention it came from.
        cur.lat = e.lat;
        cur.lng = e.lng;
        cur.place = e.place;
      }
    }
  }

  return Array.from(agg.entries())
    .map(([oblast, a]) => ({
      oblast,
      regionName: oblast,
      level: 'oblast' as const,
      alertType: 'KAB' as const,
      lat: a.lat,
      lng: a.lng,
      place: a.place,
      count: a.count,
      startedAt: new Date(a.latestTs).toISOString(),
      text: a.latestText.length > 220 ? a.latestText.slice(0, 220) + '…' : a.latestText,
      sources: Array.from(a.sources).map((s) => `t.me/${s}`),
    }))
    .sort((x, y) => new Date(y.startedAt).getTime() - new Date(x.startedAt).getTime());
}

// ── builder ───────────────────────────────────────────────────────────────────

async function buildThreats(): Promise<KabResponse> {
  const cutoff = Date.now() - WINDOW_MS;
  const results = await Promise.allSettled(
    UA_THREAT_CHANNELS.map((c) => fetchChannel(c).then((m) => ({ c, m })))
  );

  // oblast -> aggregate (current 1.5h window only)
  type AggEntry = {
    ref: OblastRef; count: number; latestTs: number; latestText: string; sources: Set<string>;
  };
  const agg = new Map<string, AggEntry>();

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { c, m } = r.value;
    for (const msg of m) {
      if (msg.ts < cutoff) continue;
      if (!isKab(msg.text)) continue;
      const refs = matchOblasts(msg.text.toLowerCase());
      if (refs.length === 0) continue;

      for (const ref of refs) {
        const cur = agg.get(ref.oblast);
        if (!cur) {
          agg.set(ref.oblast, { ref, count: 1, latestTs: msg.ts, latestText: msg.text, sources: new Set([c]) });
        } else {
          cur.count += 1;
          cur.sources.add(c);
          if (msg.ts > cur.latestTs) {
            cur.latestTs = msg.ts;
            cur.latestText = msg.text;
          }
        }
      }
    }
  }

  // Convert current-window aggregates -> TrackEntry[] for persistence.
  // One entry per (channel, oblast) pair, timestamped at the latest mention.
  const newEntries: TrackEntry[] = [];
  for (const [, a] of agg) {
    // A city/village named in the text is more precise than the oblast
    // centroid — same resolution telegram-threats.ts uses for drone routes.
    // KAB previously had no city-level geocoding at all (oblast-centroid
    // only), which is why every KAB marker piled up at one point per oblast.
    const place = findBestPlace(a.latestText);
    for (const channel of a.sources) {
      newEntries.push({
        weaponType:     'KAB',
        ts:             a.latestTs,
        channel,
        oblast:         a.ref.oblast,
        lat:            place ? place.coords[0] : a.ref.coords[1],
        lng:            place ? place.coords[1] : a.ref.coords[0],
        place:          place?.name,
        text:           a.latestText.length > 220 ? a.latestText.slice(0, 220) + '…' : a.latestText,
        alarmConfirmed: false,
      });
    }
  }

  // Merge into disk store; returned set covers the full KAB_TRACK_TTL_MS window
  // so the layer reflects more than just the last 1.5h scrape.
  const accumulated = await mergeAndSaveTracks(KAB_TRACKS_FILE, KAB_TRACK_TTL_MS, newEntries);
  const threats = buildThreatsFromEntries(accumulated);

  return {
    threats,
    total: threats.length,
    window_hours: WINDOW_HOURS,
    timestamp: new Date().toISOString(),
  };
}

// ── route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }

  // On cold-start: seed from disk so the layer is populated before first scrape.
  if (!cached) {
    const seed = await trackSeed;
    if (seed.length > 0) {
      const seedThreats = buildThreatsFromEntries(seed);
      cached = {
        threats:      seedThreats,
        total:        seedThreats.length,
        window_hours: WINDOW_HOURS,
        timestamp:    new Date().toISOString(),
      };
      // Stamp cachedAt so the disk-seeded data is actually served via the fast
      // path on cold start (the point of #110); without this it stays 0 and the
      // fast path is never taken, so every request recomputes.
      cachedAt = now;
    }
  }

  if (inflight) {
    try {
      return NextResponse.json(await inflight, {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
      });
    } catch {
      if (cached) return NextResponse.json(cached, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } });
      return NextResponse.json({ threats: [], total: 0, window_hours: WINDOW_HOURS, error: 'Failed to fetch KAB threats' }, { status: 500 });
    }
  }

  // Stale-while-revalidate: return stale immediately, compute in background.
  if (cached) {
    inflight = buildThreats();
    inflight.then(data => { cached = data; cachedAt = Date.now(); }).catch(() => {}).finally(() => { inflight = null; });
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }

  inflight = buildThreats();
  try {
    const data = await inflight;
    cached   = data;
    cachedAt = Date.now();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  } catch (error) {
    console.error('[OSIRIS] KAB threat fetch error:', error);
    return NextResponse.json(
      { threats: [], total: 0, window_hours: WINDOW_HOURS, error: error instanceof Error ? error.message : 'Failed to fetch KAB threats' },
      { status: 500 },
    );
  } finally {
    inflight = null;
  }
}
