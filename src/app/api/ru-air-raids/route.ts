import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { stealthFetch } from '@/lib/stealthFetch';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Russian Oblast Air Raid Alerts (Telegram-derived)
 *
 * No structured, keyless feed exists for Ukrainian cross-border strike alerts
 * on Russian border oblasts. Strike/drone incursion reports circulate as free
 * text in Russian OSINT and regional Telegram channels. This route scrapes
 * those channels, regex-detects alert mentions, attributes each message to a
 * Russian oblast by keyword, keeps only the 24-hour window, and returns one
 * event per oblast (the most recent matching message).
 *
 * This is an explicitly heuristic, text-derived signal — not a structured alert.
 * Channels that have disabled the t.me/s/ web preview are silently skipped.
 */

// ---------------------------------------------------------------------------
// Persistence — OSIRIS_DATA_DIR/ru-air-raid-history.json
// ---------------------------------------------------------------------------
const DATA_DIR =
  process.env.OSIRIS_DATA_DIR ??
  path.join(process.env.HOME ?? '/root', '.osiris-data');
const FILE = path.join(DATA_DIR, 'ru-air-raid-history.json');

const SNAP_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const MAX_SNAPS = 288;                    // 5-min intervals × 12/h × 24h

interface RuAirRaidSnap {
  ts: string;      // ISO
  active: string[]; // oblast names that were 'active' at this point
}

let lastSnap = 0; // epoch ms — module-level, survives across requests

async function readHistory(): Promise<RuAirRaidSnap[]> {
  try {
    const txt = await fs.readFile(FILE, 'utf8');
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function writeHistory(snaps: RuAirRaidSnap[]): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(snaps.slice(-MAX_SNAPS)), 'utf8');
  } catch (e) {
    console.warn('[OSIRIS] ru-air-raids: persist failed', e instanceof Error ? e.message : e);
  }
}

// RU-side channels that routinely report drone/strike incursions into border oblasts.
const RU_ALERT_CHANNELS = [
  'bazabazon',       // Baza — RU breaking news, reports drone incursions
  'mashnews',        // Mash — high-volume breaking news
  'shot_shot',       // Shot — Belgorod/Kursk/Bryansk focus
  'Molyar_Belgorod', // Belgorod regional
  'kursk_today',     // Kursk regional
  'voronezh_online', // Voronezh regional
];

// Alert detection patterns — Russian Cyrillic terms for drones, strikes, alarms.
// Require /u flag for \p{} and /i for case-insensitive Unicode matching.
const ALERT_TERMS: RegExp[] = [
  /дрон/iu,
  /бпла/iu,
  /атак/iu,
  /тревог/iu,        // тревога — alarm/warning
  /прилёт/iu,
  /прилет/iu,        // "arrival" — RU slang for impact
  /беспилотник/iu,
  /обстрел/iu,       // shelling
  /удар/iu,          // strike
];

// Stand-down / all-clear detection patterns.
const CLEAR_TERMS: RegExp[] = [
  /отбой/iu,               // all-clear (most reliable single-word signal)
  /тревог[аи]\s+отменен/iu, // тревога отменена / тревоги отменены
  /отмен\w+\s+тревог/iu,   // отмена тревог[и]
  /угроз\w*\s+\w*\s*нет/iu, // угрозы нет / угрозы больше нет / угрозы БПЛА нет
  /угроз\w+\s+миновал/iu,  // угроза миновала
  /тревога\s+снята/iu,     // alarm lifted
  /можно\s+покинуть\s+укрыти/iu, // "can leave shelters"
];

interface RuOblastRef {
  oblast: string;
  lat: number;
  lng: number;
  tokens: string[]; // Cyrillic stems to match in message text
}

const RU_OBLAST_REFS: RuOblastRef[] = [
  { oblast: 'Belgorod Oblast',  lat: 50.595, lng: 36.587, tokens: ['белгород'] },
  { oblast: 'Kursk Oblast',     lat: 51.730, lng: 36.193, tokens: ['курск'] },
  { oblast: 'Bryansk Oblast',   lat: 53.243, lng: 34.364, tokens: ['брянск'] },
  { oblast: 'Voronezh Oblast',  lat: 51.672, lng: 39.184, tokens: ['воронеж'] },
  { oblast: 'Rostov Oblast',    lat: 47.222, lng: 39.720, tokens: ['ростов'] },
  { oblast: 'Krasnodar Krai',   lat: 45.039, lng: 38.987, tokens: ['краснодар', 'кубань'] },
  { oblast: 'Lipetsk Oblast',   lat: 52.609, lng: 39.599, tokens: ['липецк'] },
  { oblast: 'Tambov Oblast',    lat: 52.732, lng: 41.440, tokens: ['тамбов'] },
  { oblast: 'Saratov Oblast',   lat: 51.533, lng: 46.034, tokens: ['саратов'] },
  { oblast: 'Volgograd Oblast', lat: 48.708, lng: 44.513, tokens: ['волгоград'] },
];

// Precompile a leading-boundary regex per token. A token must start at a
// non-letter/non-digit position so "курский" matches "курск" but "закурск"
// does not. Trailing characters are allowed (tokens are stems). Compiled once.
// The (?<![\p{L}\p{N}]) lookbehind is sufficient for Cyrillic stem collision
// (e.g. a Kyiv-city prefix overlap would require this pattern to be in the UA
// feed; here the collision risk is low, but the guard is already in place).
const OBLAST_MATCHERS = RU_OBLAST_REFS.map((ref) => ({
  ref,
  regexes: ref.tokens.map(
    (t) =>
      new RegExp(
        `(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        'iu',
      ),
  ),
}));

const WINDOW_HOURS = 24;
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;

// 5 min — status (active/all-clear) changes need to surface faster than the
// previous 15-min TTL. Matched to the snapshot interval.
const CACHE_TTL_MS = 5 * 60 * 1000;

// 6 hours with no fresh alert-term message → status falls to 'unknown'
const DECAY_MS = 6 * 60 * 60 * 1000;

export interface RuAlertEvent {
  oblast: string;
  lat: number;
  lng: number;
  started_at: string;          // ISO — most recent alert-term message
  status: 'active' | 'all-clear' | 'unknown';
  cleared_at?: string;         // ISO — most recent clear-term message (only when status='all-clear')
  confidence: 'high' | 'medium' | 'low';
  channel_count: number;       // distinct channels that matched this oblast
  source: string;              // primary source t.me/... (channel with latest alert post)
  snippet: string;             // message text ≤200 chars from latest alert post
}

export interface RuAirRaidsResponse {
  events: RuAlertEvent[];
  total: number;
  window_hours: number;
  timestamp: string;
}

interface TgMessage {
  text: string;
  ts: number; // epoch ms
}

// Module-level cache + inflight coalescing — one pending Promise, not one per request.
let cached: RuAirRaidsResponse | null = null;
let cachedAt = 0;
let inflight: Promise<RuAirRaidsResponse> | null = null;

function isAlert(text: string): boolean {
  return ALERT_TERMS.some((re) => re.test(text));
}

function isClear(text: string): boolean {
  return CLEAR_TERMS.some((re) => re.test(text));
}

function matchOblasts(text: string): RuOblastRef[] {
  return OBLAST_MATCHERS.filter(({ regexes }) =>
    regexes.some((re) => re.test(text)),
  ).map(({ ref }) => ref);
}

// Extract { text, ts } per message from a Telegram /s/ HTML page.
// If the channel owner has disabled web preview, the HTML contains no
// tgme_widget_message_wrap blocks and this returns [], which is silently skipped.
function parseTelegramMessages(html: string): TgMessage[] {
  const out: TgMessage[] = [];
  const blocks = html.split('tgme_widget_message_wrap').slice(1);
  for (const block of blocks) {
    const textMatch = block.match(
      /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i,
    );
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

// Per-oblast accumulator during aggregation.
interface OblastAgg {
  ref: RuOblastRef;
  latestAlertTs: number;
  latestAlertText: string;
  latestAlertSource: string;
  latestClearTs: number;
  alertChannels: Set<string>;
}

async function buildEvents(): Promise<RuAirRaidsResponse> {
  const cutoff = Date.now() - WINDOW_MS;
  const results = await Promise.allSettled(
    RU_ALERT_CHANNELS.map((c) => fetchChannel(c).then((m) => ({ c, m }))),
  );

  const agg = new Map<string, OblastAgg>();

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { c, m } = r.value;
    for (const msg of m) {
      if (msg.ts < cutoff) continue;

      const alert = isAlert(msg.text);
      const clear = isClear(msg.text);
      if (!alert && !clear) continue;

      const refs = matchOblasts(msg.text);
      if (refs.length === 0) continue; // no location — can't place it

      for (const ref of refs) {
        let entry = agg.get(ref.oblast);
        if (!entry) {
          entry = {
            ref,
            latestAlertTs: 0,
            latestAlertText: '',
            latestAlertSource: '',
            latestClearTs: 0,
            alertChannels: new Set<string>(),
          };
          agg.set(ref.oblast, entry);
        }

        // Clear wins if present in the same message — a message matching both
        // patterns (e.g. "тревога отменена") is unambiguously an all-clear even
        // though it contains the alert stem "тревог".
        if (alert && !clear && msg.ts > entry.latestAlertTs) {
          entry.latestAlertTs = msg.ts;
          entry.latestAlertText = msg.text;
          entry.latestAlertSource = `t.me/${c}`;
          entry.alertChannels.add(c);
        } else if (alert && !clear) {
          // Still counts as a channel that posted an alert, even if not latest.
          entry.alertChannels.add(c);
        }

        if (clear && msg.ts > entry.latestClearTs) {
          entry.latestClearTs = msg.ts;
        }
      }
    }
  }

  const now = Date.now();

  const events: RuAlertEvent[] = Array.from(agg.values())
    .filter((a) => a.latestAlertTs > 0) // must have at least one alert-term message
    .map((a) => {
      // Status derivation: clear wins only when strictly newer than the latest alert.
      // Equal timestamps (same-message or same Telegram minute-bucket) remain 'active'
      // — safer to not prematurely clear when uncertain.
      let status: 'active' | 'all-clear' | 'unknown';
      if (a.latestClearTs > a.latestAlertTs) {
        status = 'all-clear';
      } else if (now - a.latestAlertTs < DECAY_MS) {
        status = 'active';
      } else {
        status = 'unknown';
      }

      const channelCount = a.alertChannels.size;
      const confidence: 'high' | 'medium' | 'low' =
        channelCount >= 3 ? 'high' : channelCount === 2 ? 'medium' : 'low';

      const event: RuAlertEvent = {
        oblast: a.ref.oblast,
        lat: a.ref.lat,
        lng: a.ref.lng,
        started_at: new Date(a.latestAlertTs).toISOString(),
        status,
        confidence,
        channel_count: channelCount,
        source: a.latestAlertSource,
        snippet:
          a.latestAlertText.length > 200
            ? a.latestAlertText.slice(0, 200) + '…'
            : a.latestAlertText,
      };

      if (status === 'all-clear') {
        event.cleared_at = new Date(a.latestClearTs).toISOString();
      }

      return event;
    })
    .sort(
      (x, y) =>
        new Date(y.started_at).getTime() - new Date(x.started_at).getTime(),
    );

  return {
    events,
    total: events.length,
    window_hours: WINDOW_HOURS,
    timestamp: new Date().toISOString(),
  };
}

const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
};

export async function GET(req: Request) {
  // -------------------------------------------------------------------------
  // ?history=1 — return accumulated snapshots, no upstream fetch needed
  // -------------------------------------------------------------------------
  const { searchParams } = new URL(req.url);
  if (searchParams.get('history') === '1') {
    const history = await readHistory();
    return NextResponse.json({
      history,
      count: history.length,
      timestamp: new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // Normal path — serve from cache or fetch live
  // -------------------------------------------------------------------------
  const now = Date.now();

  // Serve from module-level cache if still fresh.
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cached, { headers: CACHE_HEADERS });
  }

  // Coalesce concurrent requests onto the single in-flight promise.
  if (inflight) {
    try {
      return NextResponse.json(await inflight, { headers: CACHE_HEADERS });
    } catch {
      return NextResponse.json(
        { events: [], total: 0, window_hours: WINDOW_HOURS, error: 'Upstream fetch failed' },
        { status: 500 },
      );
    }
  }

  inflight = buildEvents();
  try {
    const data = await inflight;
    cached = data;
    cachedAt = Date.now();

    // Persist snapshot if enough time has passed since the last one.
    if (Date.now() - lastSnap >= SNAP_INTERVAL_MS) {
      lastSnap = Date.now();
      const activeOblasts = data.events
        .filter((e) => e.status === 'active')
        .map((e) => e.oblast);
      try {
        const history = await readHistory();
        history.push({ ts: new Date(lastSnap).toISOString(), active: activeOblasts });
        await writeHistory(history);
      } catch (e) {
        console.warn('[OSIRIS] ru-air-raids: snapshot append failed', e instanceof Error ? e.message : e);
      }
    }

    return NextResponse.json(data, { headers: CACHE_HEADERS });
  } catch (error) {
    console.error('[OSIRIS] RU air-raid fetch error:', error);
    // Serve stale on upstream failure — never serve empty if we have prior data.
    if (cached) {
      return NextResponse.json(cached, { headers: CACHE_HEADERS });
    }
    return NextResponse.json(
      {
        events: [],
        total: 0,
        window_hours: WINDOW_HOURS,
        error: 'Failed to fetch RU air-raid alerts',
      },
      { status: 500 },
    );
  } finally {
    inflight = null;
  }
}
