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

// GeneralStaffUA / Militaryland / ukraine_now removed: scrape 0 messages and/or
// post after-action summaries rather than real-time warnings.
export const UA_THREAT_CHANNELS = [
  'DeepStateUA', 'UkraineWarReport',
  'ua_forces', 'kpszsu', 'war_monitor',
  'vanek_nikolaev', // RU-language UA channel; uses "мопед" as Shahed alias
] as const;

// Strike-report channels: post after-action summaries, not real-time threat alerts.
// Kept separate from UA_THREAT_CHANNELS so drone/missile route builders never see
// multi-oblast summary posts as waypoints of an active wave.
export const STRIKE_REPORT_CHANNELS = [
  'ssternenko',
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
  confidence?: number;      // number of distinct channels that reported this waypoint's wave
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
  { oblast: 'Kyiv oblast',           coords: [30.523, 50.450], tokens: ['київщ', 'київськ', 'kyivsk', 'бровар', 'бориспіл', 'vasylkiv', 'васильків'] },
  { oblast: 'Kyiv City',             coords: [30.523, 50.450], tokens: ['kyiv', 'київ'] },
  { oblast: 'Zhytomyr oblast',       coords: [28.658, 50.255], tokens: ['житомирщ', 'житомир', 'zhytomyr', 'бердичів', 'коростень'] },
  { oblast: 'Rivne oblast',          coords: [26.251, 50.620], tokens: ['рівненщ', 'рівн', 'rivne', 'рівного', 'рівному'] },
  { oblast: 'Vinnytsia oblast',      coords: [28.468, 49.233], tokens: ['вінниц', 'вінниці', 'vinnytsia', 'вінниця', 'жмеринк'] },
  { oblast: 'Khmelnytskyi oblast',   coords: [26.987, 49.423], tokens: ['хмельниц', 'khmelnytsk', 'хмельницьк', "кам'янець"] },
  { oblast: 'Kirovohrad oblast',     coords: [32.262, 48.508], tokens: ['кіровоград', 'kirovohrad', 'кропивниц', 'kropyvnytsk'] },
  // ── Western oblasts (previously missing — strikes/drones reach these) ─────
  { oblast: 'Lviv oblast',           coords: [24.030, 49.840], tokens: ['львів', 'львівщ', 'львівськ', 'lviv', 'дрогобич', 'drohobych', 'стрий', 'stryi'] },
  { oblast: 'Ternopil oblast',       coords: [25.595, 49.554], tokens: ['тернопіл', 'тернопільщ', 'тернопільськ', 'ternopil', 'кременець'] },
  { oblast: 'Volyn oblast',          coords: [25.325, 50.747], tokens: ['волин', 'волинськ', 'волинщ', 'volyn', 'луцьк', 'lutsk', 'ковель'] },
  { oblast: 'Ivano-Frankivsk oblast',coords: [24.711, 48.923], tokens: ['івано-франківськ', 'івано-франківщ', 'прикарпатт', 'ivano-frankivsk', 'коломия', 'калуш'] },
  { oblast: 'Zakarpattia oblast',    coords: [22.288, 48.621], tokens: ['закарпат', 'zakarpat', 'ужгород', 'uzhhorod', 'мукачев', 'mukachevo'] },
  { oblast: 'Chernivtsi oblast',     coords: [25.935, 48.292], tokens: ['чернівц', 'чернівецьк', 'буковин', 'chernivtsi', 'буковина'] },
  { oblast: 'Cherkasy oblast',       coords: [32.060, 49.445], tokens: ['черкащ', 'черкаськ', 'cherkasy', 'умань', 'uman', 'черкаси'] },
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
    /(?<!\p{L})х-?101(?!\p{L})/iu,    // Cyrillic Х (кириличний) — UA writers use Х not K
    /(?<!\p{L})kh?-?555(?!\p{L})/iu,
    /(?<!\p{L})х-?555(?!\p{L})/iu,
    /крилат\p{L}*\s+ракет/iu,          // "крилата ракета" and inflections — \p{L}* matches Cyrillic
    /стратегічн\p{L}*\s+ракет/iu,     // "стратегічна ракета" and inflections
    // Removed bare /ракетн/iu — caused false positives on ballistic / S-300 posts
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
    /(?<!\p{L})мопед/iu,  // vanek_nikolaev alias for Shahed ("мопед", "мопедів", etc.)
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

// Strike-report corpus: longer window (6h) + longer TTL (30 min) — summaries
// arrive later than live alerts and don't need to be re-scraped as often.
const REPORT_WINDOW_MS  = 6 * 60 * 60 * 1000;
const REPORT_CACHE_TTL_MS = 30 * 60 * 1000;

let reportCorpus:         TgMessage[] | null = null;
let reportCorpusAt                           = 0;
let reportCorpusInflight: Promise<TgMessage[]> | null = null;

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

async function fetchReportCorpus(): Promise<TgMessage[]> {
  const cutoff = Date.now() - REPORT_WINDOW_MS;
  const settled = await Promise.allSettled(
    STRIKE_REPORT_CHANNELS.map((c) => fetchChannel(c)),
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

/**
 * Returns the last 6h of messages from STRIKE_REPORT_CHANNELS.
 * Separate cache from getThreatCorpus() — longer window, longer TTL.
 * Only used by /api/strategic-thermal; never fed into route builders.
 */
export async function getStrikeReportCorpus(): Promise<TgMessage[]> {
  const now = Date.now();
  if (reportCorpus && now - reportCorpusAt < REPORT_CACHE_TTL_MS) return reportCorpus;
  if (reportCorpusInflight) return reportCorpusInflight;
  reportCorpusInflight = fetchReportCorpus();
  try {
    const data = await reportCorpusInflight;
    reportCorpus   = data;
    reportCorpusAt = Date.now();
    return data;
  } finally {
    reportCorpusInflight = null;
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

// ── geo event extraction ─────────────────────────────────────────────────────

// Bilingual event keywords (Cyrillic + Latin) for conflict detection.
const EVENT_KEYWORDS = [
  'вибух', 'удар', 'обстріл', 'атака', 'приліт', 'бій', 'штурм', 'наступ',
  'окупанти', 'зайняли', 'звільнили', 'втрати', 'загинули', 'поранені',
  'explosion', 'strike', 'shelling', 'assault', 'offensive', 'captured', 'liberated', 'casualties',
];

// Max events extracted from the Telegram corpus per call.
const GEO_EVENT_CAP = 50;

// Lazily imported to avoid circular dependency (conflict-geo imports nothing from here).
// We use a dynamic import pattern to keep the module graph clean.
let _geoMapText: ((text: string) => [number, number] | null) | null = null;
let _findPlaceCoords: ((text: string) => [number, number] | null) | null = null;

async function getGeoMapText(): Promise<(text: string) => [number, number] | null> {
  if (!_geoMapText) {
    const m = await import('@/lib/conflict-geo');
    _geoMapText = m.geoMapText;
    _findPlaceCoords = m.findPlaceCoords;
  }
  return _geoMapText;
}

async function getFindPlaceCoords(): Promise<(text: string) => [number, number] | null> {
  if (!_findPlaceCoords) {
    const m = await import('@/lib/conflict-geo');
    _geoMapText = m.geoMapText;
    _findPlaceCoords = m.findPlaceCoords;
  }
  return _findPlaceCoords!;
}

/**
 * Extracts geo-located conflict events from the cached Telegram corpus.
 * Reuses getThreatCorpus() — does NOT launch new channel fetches.
 *
 * Returns up to GEO_EVENT_CAP events, each with a coordinate, event type,
 * ISO published timestamp, and sources array tagged ['telegram'].
 */
export async function extractGeoEvents(): Promise<{
  lat: number;
  lng: number;
  name: string;
  eventType: string;
  published: string;
  sources: string[];
}[]> {
  const geoMap = await getGeoMapText();
  const findPlace = await getFindPlaceCoords();
  const msgs = await getThreatCorpus();

  const out: {
    lat: number;
    lng: number;
    name: string;
    eventType: string;
    published: string;
    sources: string[];
  }[] = [];

  for (const msg of msgs) {
    if (out.length >= GEO_EVENT_CAP) break;

    const lowerText = msg.text.toLowerCase();
    const hasEvent = EVENT_KEYWORDS.some(kw => lowerText.includes(kw.toLowerCase()));
    if (!hasEvent) continue;

    // Priority: (1) ranked town-first resolver, (2) oblast matcher, (3) GEO_DICT fallback.
    // findPlaceCoords returns [lat, lng]; everything else uses [lng, lat] — do not mix.
    let lat: number;
    let lng: number;

    const ranked = findPlace(msg.text); // returns [lat, lng]
    if (ranked) {
      [lat, lng] = ranked;
    } else {
      const oblastRef = firstOblastInText(msg.text);
      if (oblastRef) {
        [lng, lat] = oblastRef.coords; // coords are [lng, lat] in OBLAST_REFS
      } else {
        const coords = geoMap(msg.text);
        if (!coords) continue;
        [lng, lat] = coords; // geoMapText returns [lng, lat]
      }
    }

    // eventType mapping
    let eventType: string;
    if (/штурм|наступ|assault|offensive/i.test(msg.text)) {
      eventType = 'battle';
    } else if (/удар|приліт|strike|обстріл|shelling/i.test(msg.text)) {
      eventType = 'strike';
    } else {
      eventType = 'conflict';
    }

    const published = new Date(msg.ts).toISOString();

    out.push({
      lat,
      lng,
      name: msg.text.slice(0, 120),
      eventType,
      published,
      sources: ['telegram'],
    });
  }

  return out;
}

// ── fingerprinting ───────────────────────────────────────────────────────────

/**
 * Computes a dedup fingerprint for a Telegram message.
 * Normalises whitespace, lower-cases, and truncates to 120 chars before
 * bucketing into 10-minute epochs — so reposts of the same alert within the
 * same 10-min window (across different channels) collapse to a single entry.
 */
export function msgFingerprint(text: string, ts: number): string {
  const normalised = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
  const bucket = Math.floor(ts / 1_800_000); // 30-min epoch bucket — covers typical cross-channel repost lag
  return `${bucket}:${normalised}`;
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

// A 45-minute gap between consecutive sighting messages is treated as a new
// wave (separate attack group / drone swarm). 45 min is used because different
// channels post about the same cruise missile 20-30 min apart; 25 min was
// splitting single strikes into multiple "waves".
export const WAVE_GAP_MS = 45 * 60 * 1000;

// Per-weapon-type wave gap overrides.
// Faster weapons (ballistic, Kinzhal, S-300) have shorter flight times and
// tighter reporting windows; a 45-min gap would merge distinct attack waves.
// CRUISE and DRONE keep the default 45-min gap.
const WAVE_GAPS: Partial<Record<WeaponType, number>> = {
  BALLISTIC: 15 * 60 * 1000,  // 15 min — Iskander/ballistic arc is ~5-8 min flight
  KINZHAL:   10 * 60 * 1000,  // 10 min — hypersonic; separate strikes land close together
  KH22:      20 * 60 * 1000,  // 20 min — supersonic; faster than cruise but slower than ballistic
  S300:      10 * 60 * 1000,  // 10 min — surface-to-surface SAM repurposed; very short flight
  // CRUISE: use WAVE_GAP_MS (45 min) — channels post 20-30 min apart for same missile
  // DRONE:  use WAVE_GAP_MS (45 min) — Shahed swarms span hours, 45-min gap is correct
};

/**
 * Returns the wave-gap threshold (ms) for a given weapon type.
 * Used by both buildRoute() (new waypoints) and buildWavesFromEntries()
 * (12h reconstruction from disk) — both must use the same threshold or
 * the displayed routes will differ from what was stored.
 */
export function waveGapFor(wt: WeaponType): number {
  return WAVE_GAPS[wt] ?? WAVE_GAP_MS;
}

/**
 * Builds temporal route waves for a given weapon type.
 *
 * Each wave is a contiguous series of sighting messages (no gap > waveGapFor(weaponType)).
 * Analysis / probability-assessment messages are excluded entirely.
 * Each qualifying message contributes at most one waypoint (first-mentioned
 * oblast in text order), preventing forecast posts from faking routes.
 *
 * confidence on each waypoint = number of distinct channels in the wave.
 * A wave reported by 3 separate channels is higher-confidence than one from a single channel.
 */
export function buildRoute(messages: TgMessage[], weaponType: WeaponType): RouteWave[] {
  const seenFingerprints = new Set<string>();

  const relevant = messages
    .filter(msg => {
      if (!classifyWeapons(msg.text).includes(weaponType)) return false;
      if (isAnalysis(msg.text)) return false;
      // Dedup reposts: same normalised text in the same 10-min bucket → skip
      const fp = msgFingerprint(msg.text, msg.ts);
      if (seenFingerprints.has(fp)) return false;
      seenFingerprints.add(fp);
      return true;
    })
    .sort((a, b) => a.ts - b.ts);

  const gapMs = waveGapFor(weaponType);
  const waves: RouteWave[] = [];
  let current: RouteWaypoint[] = [];
  let currentChannels: Set<string> = new Set();
  let lastTs = 0;

  const flush = () => {
    if (current.length > 0) {
      const confidence = currentChannels.size;
      for (const wp of current) {
        wp.confidence = confidence;
      }
      waves.push({ waveIndex: waves.length, startedAt: current[0].ts, waypoints: current });
      current = [];
      currentChannels = new Set();
    }
  };

  for (const msg of relevant) {
    if (lastTs && msg.ts - lastTs > gapMs) flush();

    const ref = firstOblastInText(msg.text);
    if (!ref) { lastTs = msg.ts; continue; }

    const last = current[current.length - 1];
    if (last && last.oblast === ref.oblast) {
      // Still count this channel even for a duplicate-oblast message
      currentChannels.add(msg.channel);
      lastTs = msg.ts;
      continue;
    }

    current.push({
      lat:     ref.coords[1],
      lng:     ref.coords[0],
      oblast:  ref.oblast,
      ts:      new Date(msg.ts).toISOString(),
      text:    msg.text.length > 120 ? msg.text.slice(0, 120) + '…' : msg.text,
      channel: msg.channel,
    });
    currentChannels.add(msg.channel);
    lastTs = msg.ts;
  }

  flush();
  return waves;
}

// ── UAV count extraction ─────────────────────────────────────────────────────

/**
 * Extracts the maximum single-strike UAV count mentioned across a set of
 * (already-deduplicated) messages.  Takes the MAX, not the sum, because
 * reposts of the same total figure must not inflate the count.
 *
 * Recognises Ukrainian patterns such as:
 *   "28 × БПЛА", "28 x дрон", "28 Шахедів", "28 дронів", etc.
 */
export function extractUAVCount(messages: string[]): number {
  // [×xх] covers: U+00D7 ×, ASCII x, U+0445 Cyrillic х — all used in UA reporting
  const patterns = [
    /(\d+)\s*[×xх]\s*бпла/giu,
    /(\d+)\s*[×xх]\s*дрон/giu,
    /(\d+)\s*[×xх]\s*шахед/giu,
    /(\d+)\s+бпла/giu,
    /(\d+)\s+дрон\w*/giu,
    /(\d+)\s+шахед\w*/giu,
  ];
  let max = 0;
  for (const msg of messages) {
    for (const p of patterns) {
      // Use matchAll to catch staged counts within one message ("10 БпЛА … now 28 БпЛА")
      for (const m of msg.matchAll(p)) {
        max = Math.max(max, parseInt(m[1], 10));
      }
    }
  }
  return max;
}
