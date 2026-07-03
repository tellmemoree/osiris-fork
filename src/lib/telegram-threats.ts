/**
 * OSIRIS — Shared Telegram Threat Corpus
 *
 * Fetches and caches the last 1.5 h of messages across all UA_THREAT_CHANNELS.
 * Results are cached 15 min at module level with inflight coalescing so that
 * /api/drone-threats and /api/weapon-threats never double-scrape the same pages
 * (and neither do concurrent requests to the same route).
 *
 * getThreatCorpus()   — returns TgMessage[] (cached 15 min)
 * classifyWeapons()   — maps a message to the WeaponType(s) it mentions
 * matchOblasts()      — maps a message to the OblastRef(s) it names
 */

import { stealthFetch } from '@/lib/stealthFetch';

// ── channels ────────────────────────────────────────────────────────────────

export const UA_THREAT_CHANNELS = [
  'GeneralStaffUA', 'DeepStateUA', 'Militaryland', 'UkraineWarReport',
  'ukraine_now', 'ua_forces', 'kpszsu', 'war_monitor',
] as const;

// ── types ───────────────────────────────────────────────────────────────────

export interface TgMessage {
  text: string;
  ts: number;      // epoch ms
  channel: string; // bare channel name, e.g. "war_monitor"
}

export interface OblastRef {
  oblast: string;
  coords: [number, number]; // [lng, lat] GeoJSON order
  tokens: string[];
}

export type WeaponType = 'KAB' | 'CRUISE' | 'BALLISTIC' | 'DRONE' | 'KINZHAL' | 'S300' | 'KH22';

export interface RouteWaypoint {
  lat: number;
  lng: number;
  oblast: string;
  ts: string;     // ISO
  text: string;
  channel: string;
  alarmConfirmed?: boolean; // true when air-raid history records this oblast alarmed near ts
}

export interface RouteWave {
  waveIndex: number;
  startedAt: string;    // ISO of first waypoint
  waypoints: RouteWaypoint[];
}

// ── oblast refs (verbatim from kab-threats) ─────────────────────────────────

export const OBLAST_REFS: OblastRef[] = [
  { oblast: 'Kharkiv oblast',        coords: [36.230, 49.990], tokens: ['харків', 'харківщ', 'kharkiv', 'чугуїв', "куп'янськ", 'kupiansk', 'вовчанськ', 'vovchansk', 'ізюм', 'izium'] },
  { oblast: 'Sumy oblast',           coords: [34.800, 50.910], tokens: ['сумщ', 'сумськ', 'сумської', 'м. суми', 'sumy', 'шостк', 'конотоп'] },
  { oblast: 'Zaporizhzhia oblast',   coords: [35.139, 47.838], tokens: ['запоріж', 'запорізьк', 'zaporizh', 'оріхів', 'оріхов', 'гуляйполе', 'huliaipole', 'токмак', 'tokmak'] },
  { oblast: 'Kherson oblast',        coords: [32.601, 46.635], tokens: ['херсон', 'херсонщ', 'kherson', 'берислав'] },
  { oblast: 'Donetsk oblast',        coords: [37.800, 48.000], tokens: ['донеччин', 'донецьк', 'donetsk', 'краматорськ', 'kramatorsk', "слов'янськ", 'покровськ', 'pokrovsk', 'костянтинівк', 'часів яр', 'торецьк', 'toretsk', 'авдіїв'] },
  { oblast: 'Dnipropetrovsk oblast', coords: [35.046, 48.465], tokens: ['дніпропетровщ', 'дніпро', 'нікополь', 'nikopol', 'кривий ріг', 'kryvyi rih', 'павлоград', 'марганець'] },
  { oblast: 'Chernihiv oblast',      coords: [31.285, 51.498], tokens: ['чернігівщ', 'чернігів', 'chernihiv', 'новгород-сіверськ', 'семенівк'] },
  { oblast: 'Mykolaiv oblast',       coords: [31.994, 46.975], tokens: ['миколаївщ', 'миколаїв', 'mykolaiv', 'очаків', 'снігурівк'] },
  { oblast: 'Poltava oblast',        coords: [34.551, 49.588], tokens: ['полтавщ', 'полтав', 'poltava', 'кременчук', 'kremenchuk', 'лубни'] },
  { oblast: 'Luhansk oblast',        coords: [39.300, 48.566], tokens: ['луганщ', 'луганськ', 'luhansk', 'luhans', 'рубіжн', 'сєвєродонецьк', 'лисичанськ'] },
  { oblast: 'Odesa oblast',          coords: [30.723, 46.482], tokens: ['одещ', 'одеськ', 'odesa', 'odessa', 'ізмаїл', 'чорноморськ', 'южне'] },
  { oblast: 'Kyiv oblast',           coords: [30.523, 50.450], tokens: ['київщ', 'київськ', 'kyiv', 'kyivsk', 'бровар', 'бориспіл', 'vasylkiv', 'васильків'] },
  { oblast: 'Zhytomyr oblast',       coords: [28.658, 50.255], tokens: ['житомирщ', 'житомир', 'zhytomyr', 'бердичів', 'коростень'] },
  { oblast: 'Rivne oblast',          coords: [26.251, 50.620], tokens: ['рівненщ', 'рівн', 'rivne', 'рівного', 'рівному'] },
  { oblast: 'Vinnytsia oblast',      coords: [28.468, 49.233], tokens: ['вінниц', 'вінниці', 'vinnytsia', 'вінниця', 'жмеринк'] },
  { oblast: 'Khmelnytskyi oblast',   coords: [26.987, 49.423], tokens: ['хмельниц', 'khmelnytsk', 'хмельницьк', "кам'янець"] },
  { oblast: 'Kirovohrad oblast',     coords: [32.262, 48.508], tokens: ['кіровоград', 'kirovohrad', 'кропивниц', 'kropyvnytsk'] },
];

// Precompiled leading-boundary matchers per oblast (same technique as kab-threats).
// Leading boundary: must not be preceded by a letter/digit.
// Trailing letters are allowed because tokens are declension stems.
const OBLAST_MATCHERS = OBLAST_REFS.map((ref) => ({
  ref,
  regexes: ref.tokens.map(
    (t) => new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu'),
  ),
}));

// ── railway / rail infrastructure patterns ───────────────────────────────────

export const RAILWAY_PATTERNS: RegExp[] = [
  /вокзал/iu,                      // station (terminal building)
  /залізниц/iu,                    // railway / railroad
  /залізничн/iu,                   // railway (adjective)
  /залізнодорожн/iu,               // railroad (adj, alternative spelling)
  /депо/iu,                        // rail depot
  /потяг|поїзд/iu,                 // train
  /локомотив/iu,                   // locomotive
  /рейки/iu,                       // rail tracks
  /railway|rail[\s-]?strike|rail[\s-]?attack/i,
];

// ── weapon vocab ─────────────────────────────────────────────────────────────

// KAB patterns copied verbatim from kab-threats/route.ts.
const KAB_PATTERNS: RegExp[] = [
  /(?<!\p{L})каб(?:и|ів|ами|ах|у)?(?!\p{L})/iu,
  /(?<!\p{L})kab(?:s)?(?!\p{L})/iu,
  /(?<!\p{L})умп[кб](?!\p{L})/iu,
  /керован\p{L}*\s+аві?абомб/iu,
  /планир\p{L}*\s+бомб/iu,
  /glide[-\s]*bomb|guided\s+(?:aerial\s+)?bomb/i,
];

const WEAPON_VOCAB: Record<WeaponType, RegExp[]> = {
  KAB: KAB_PATTERNS,
  CRUISE: [
    /(?<!\p{L})калібр(?!\p{L})/iu,
    /(?<!\p{L})kh?-?101(?!\p{L})/iu,
    /(?<!\p{L})kh?-?555(?!\p{L})/iu,
    /крилата ракета/iu,
  ],
  BALLISTIC: [
    /(?<!\p{L})іскандер(?!\p{L})/iu,
    /(?<!\p{L})iskander(?!\p{L})/iu,
    /балістич/iu,
  ],
  DRONE: [
    /(?<!\p{L})шахед(?!\p{L})/iu,
    /(?<!\p{L})shahed(?!\p{L})/iu,
    /(?<!\p{L})герань(?!\p{L})/iu,
    /(?<!\p{L})geran(?!\p{L})/iu,
    /(?<!\p{L})бпла(?!\p{L})/iu,
    /дрон-?камікадз/iu,
  ],
  KINZHAL: [
    /(?<!\p{L})кинджал(?!\p{L})/iu,
    /(?<!\p{L})kinzhal(?!\p{L})/iu,
    /гіперзвук/iu,
  ],
  S300: [
    /с-?300/iu,
    /с-?400/iu,
    /зенітна ракета по наземн/iu,
  ],
  KH22: [
    /х-?22(?!\p{L})/iu,
    /kh-?22(?!\p{L})/iu,
    /х-?32(?!\p{L})/iu,
  ],
};

// All weapon types in a stable iteration order.
const ALL_WEAPON_TYPES: WeaponType[] = ['KAB', 'CRUISE', 'BALLISTIC', 'DRONE', 'KINZHAL', 'S300', 'KH22'];

// ── corpus cache constants ───────────────────────────────────────────────────

const WINDOW_HOURS = 1.5;
const WINDOW_MS    = WINDOW_HOURS * 60 * 60 * 1000;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — data is text scraped from Telegram; it ages slowly

// ── module-level cache state ─────────────────────────────────────────────────

let corpus:         TgMessage[] | null = null;
let corpusAt                           = 0;
let corpusInflight: Promise<TgMessage[]> | null = null;

// ── internal helpers ─────────────────────────────────────────────────────────

// Extract { text, ts, channel } per message from a Telegram /s/ HTML page.
function parseTelegramMessages(html: string, channel: string): TgMessage[] {
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
    out.push({ text, ts, channel });
  }
  return out;
}

async function fetchChannel(channel: string): Promise<TgMessage[]> {
  try {
    const res = await stealthFetch(`https://t.me/s/${channel}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return parseTelegramMessages(await res.text(), channel);
  } catch {
    return [];
  }
}

async function fetchCorpus(): Promise<TgMessage[]> {
  const cutoff = Date.now() - WINDOW_MS;
  const settled = await Promise.allSettled(
    UA_THREAT_CHANNELS.map((c) => fetchChannel(c)),
  );
  const messages: TgMessage[] = [];
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const msg of r.value) {
      if (msg.ts >= cutoff) messages.push(msg);
    }
  }
  return messages;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Returns all messages from the last 1.5 h across all UA_THREAT_CHANNELS.
 * Results are cached 15 min at module level with inflight coalescing:
 * only one upstream scrape is ever in flight at a time, regardless of how
 * many routes call this concurrently.
 */
export async function getThreatCorpus(): Promise<TgMessage[]> {
  const now = Date.now();

  if (corpus && now - corpusAt < CACHE_TTL_MS) {
    return corpus;
  }

  if (corpusInflight) {
    // Join the existing in-flight scrape rather than launching a second one.
    return corpusInflight;
  }

  corpusInflight = fetchCorpus();
  try {
    const data = await corpusInflight;
    corpus   = data;
    corpusAt = Date.now();
    return data;
  } finally {
    corpusInflight = null;
  }
}

/**
 * Returns which WeaponType(s) are mentioned in a message.
 * All regex sets are precompiled at module load — this is a pure classifier.
 */
export function classifyWeapons(text: string): WeaponType[] {
  const found: WeaponType[] = [];
  for (const wt of ALL_WEAPON_TYPES) {
    if (WEAPON_VOCAB[wt].some((re) => re.test(text))) {
      found.push(wt);
    }
  }
  return found;
}

/**
 * Returns which UA oblasts are mentioned in a message.
 * Uses leading-boundary regexes compiled once at module load.
 */
export function matchOblasts(text: string): OblastRef[] {
  return OBLAST_MATCHERS
    .filter(({ regexes }) => regexes.some((re) => re.test(text)))
    .map(({ ref }) => ref);
}

// ── route building ───────────────────────────────────────────────────────────

// Messages matching these patterns are threat-level assessments or probability
// forecasts, not actual sightings. They name many oblasts as *potential* targets,
// which produces entirely false routes.
const ANALYSIS_PATTERNS: RegExp[] = [
  /ймовірніст/iu,                       // "probability / likelihood"
  /рівень\s+(загроз|небезпек|атак)/iu,  // "threat / danger / attack level"
  /низьк\p{L}+\s+рівен/iu,             // "low level"
  /висок\p{L}+\s+рівен/iu,             // "high level"
  /середн\p{L}+\s+рівен/iu,            // "medium level"
];

function isAnalysis(text: string): boolean {
  return ANALYSIS_PATTERNS.some(re => re.test(text));
}

// Returns the oblast whose first token match appears earliest in the message
// text (character position) — text order, not OBLAST_REFS definition order.
// One waypoint per message prevents a single "X, Y, Z under threat" post from
// generating a fake multi-step route.
function firstOblastInText(text: string): OblastRef | null {
  let earliest = Infinity;
  let result: OblastRef | null = null;
  for (const { ref, regexes } of OBLAST_MATCHERS) {
    for (const re of regexes) {
      const m = re.exec(text);
      if (m && m.index < earliest) {
        earliest = m.index;
        result   = ref;
      }
    }
  }
  return result;
}

// A 25-minute gap between consecutive sighting messages is treated as a new
// wave (separate attack group / drone swarm).
const WAVE_GAP_MS = 25 * 60 * 1000;

/**
 * Builds temporal route waves for a given weapon type.
 *
 * Each wave is a contiguous series of sighting messages (no >25 min gap).
 * Analysis / probability-assessment messages are excluded entirely.
 * Each qualifying message contributes at most one waypoint (first-mentioned
 * oblast in text order), preventing forecast posts from faking routes.
 */
export function buildRoute(messages: TgMessage[], weaponType: WeaponType): RouteWave[] {
  const relevant = messages
    .filter(msg => classifyWeapons(msg.text).includes(weaponType) && !isAnalysis(msg.text))
    .sort((a, b) => a.ts - b.ts);

  const waves: RouteWave[] = [];
  let current: RouteWaypoint[] = [];
  let lastTs = 0;

  const flush = () => {
    if (current.length > 0) {
      waves.push({ waveIndex: waves.length, startedAt: current[0].ts, waypoints: current });
      current = [];
    }
  };

  for (const msg of relevant) {
    if (lastTs && msg.ts - lastTs > WAVE_GAP_MS) flush();

    const ref = firstOblastInText(msg.text);
    if (!ref) { lastTs = msg.ts; continue; }

    const last = current[current.length - 1];
    if (last && last.oblast === ref.oblast) { lastTs = msg.ts; continue; }

    current.push({
      lat:     ref.coords[1],
      lng:     ref.coords[0],
      oblast:  ref.oblast,
      ts:      new Date(msg.ts).toISOString(),
      text:    msg.text.length > 120 ? msg.text.slice(0, 120) + '…' : msg.text,
      channel: msg.channel,
    });
    lastTs = msg.ts;
  }

  flush();
  return waves;
}
