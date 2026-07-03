
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 5 * 60 * 1000;
let outageCache: OutageRecord[] | null = null;
let cachedAt = 0;
let inflight: Promise<OutageRecord[]> | null = null;

type OutageType = 'scheduled' | 'emergency' | 'unknown';
type OutageSeverity = 'partial' | 'full';

type OutageRecord = {
  regionName: string;
  lat: number;
  lng: number;
  type: OutageType;
  severity: OutageSeverity;
  schedule: string;
  source: string;
};

// Ukrainian power / energy Telegram channels with public web preview.
// yasno_ua has web preview disabled (only "Channel created" visible).
const OUTAGE_CHANNELS = [
  'ukrenergo',      // Ukrenergo — national grid operator (daily status posts)
  'dtek_official',  // DTEK — Eastern/Central Ukraine power
  'suspilne_news',  // Suspilne national broadcaster
  'hromadske_ua',   // Hromadske — reliable civil-society news
  'serhii_flash',   // Serhii Flash — active UA war/energy reporter
  'informnapalm',   // InformNapalm — UA OSINT investigations
];

// Terms that flag a post as outage-related (Cyrillic stems + English).
// Also catches Ukrenergo's daily "СТАН ЕНЕРГОСИСТЕМИ" grid-status posts.
const OUTAGE_TERMS = [
  'відключення', 'відімкнення', 'знеструмлення', 'знеструмил',
  'аварійн', 'планов', 'без світла', 'blackout',
  'відключат', 'відключил', 'вимкнен',
  'електроенергі', 'power cut', 'power outage', 'light cut',
  'стан енергосистеми',
];

// Stems (lowercase Cyrillic) → canonical OBLAST_COORDS key.
// Each oblast gets BOTH its standard adjective stem AND its -щина/-ч(ч)ина
// colloquial form, because Telegram channels use both interchangeably
// (e.g. "Сумщині" vs "Сумській области").  Longer/more-specific stems come
// first so a longer match wins before a short prefix fires.
const REGION_STEMS: Array<[string, string]> = [
  ['вінниц',            'Vinnytska Oblast'],
  ['волин',             'Volynska Oblast'],
  ['дніпропетровськ',   'Dnipropetrovska Oblast'],
  ['дніпр',             'Dnipropetrovska Oblast'],
  ['донеч',             'Donetska Oblast'],   // Донеччині / Донеч (–ч)
  ['донецьк',           'Donetska Oblast'],
  ['житомир',           'Zhytomyrska Oblast'],
  ['закарпат',          'Zakarpatska Oblast'],
  ['запоріж',           'Zaporizka Oblast'],
  ['івано-франківськ',  'Ivano-Frankivska Oblast'],
  ['київськ',           'Kyivska Oblast'],
  ['київщин',           'Kyivska Oblast'],    // Київщині
  ['київ',              'Kyiv City'],
  ['кіровоград',        'Kirovohradska Oblast'],
  ['кропивниц',         'Kirovohradska Oblast'],
  ['луган',             'Luhanska Oblast'],   // Луганщині / Луганській
  ['львів',             'Lvivska Oblast'],
  ['миколаїв',          'Mykolaivska Oblast'],
  ['одещин',            'Odeska Oblast'],     // Одещині
  ['одес',              'Odeska Oblast'],
  ['полтав',            'Poltavska Oblast'],
  ['рівн',              'Rivnenska Oblast'],
  ['сумщин',            'Sumska Oblast'],     // Сумщині
  ['сумськ',            'Sumska Oblast'],
  ['суми',              'Sumska Oblast'],
  ['терноп',            'Ternopilska Oblast'],
  ['харків',            'Kharkivska Oblast'],
  ['херсон',            'Khersonska Oblast'],
  ['хмельнич',          'Khmelnytska Oblast'], // Хмельниччині
  ['хмельниц',          'Khmelnytska Oblast'],
  ['черкащин',          'Cherkaska Oblast'],  // Черкащині
  ['черкас',            'Cherkaska Oblast'],
  ['чернівеч',          'Chernivtetska Oblast'], // Чернівеччині
  ['чернів',            'Chernivtetska Oblast'],
  ['чернігів',          'Chernihivska Oblast'],
];

const OBLAST_COORDS: Record<string, [number, number]> = {
  'Vinnytska Oblast':        [49.233,  28.468],
  'Volynska Oblast':         [50.747,  25.325],
  'Dnipropetrovska Oblast':  [48.465,  35.046],
  'Donetska Oblast':         [48.000,  37.800],
  'Zhytomyrska Oblast':      [50.255,  28.658],
  'Zakarpatska Oblast':      [48.620,  23.297],
  'Zaporizka Oblast':        [47.838,  35.139],
  'Ivano-Frankivska Oblast': [48.922,  24.711],
  'Kyivska Oblast':          [50.900,  31.200],
  'Kyiv City':               [50.452,  30.518],
  'Kirovohradska Oblast':    [48.508,  32.262],
  'Luhanska Oblast':         [48.566,  39.300],
  'Lvivska Oblast':          [49.839,  24.029],
  'Mykolaivska Oblast':      [46.975,  31.994],
  'Odeska Oblast':           [46.482,  30.723],
  'Poltavska Oblast':        [49.588,  34.551],
  'Rivnenska Oblast':        [50.620,  26.251],
  'Sumska Oblast':           [50.910,  34.800],
  'Ternopilska Oblast':      [49.553,  25.594],
  'Kharkivska Oblast':       [49.990,  36.230],
  'Khersonska Oblast':       [46.635,  32.601],
  'Khmelnytska Oblast':      [49.423,  26.987],
  'Cherkaska Oblast':        [49.445,  32.060],
  'Chernivtetska Oblast':    [48.292,  25.940],
  'Chernihivska Oblast':     [51.498,  31.285],
};

// ---------------------------------------------------------------------------
// Telegram HTML parser (mirrors the one in /api/news — kept local to avoid
// cross-route imports which Next.js route isolation doesn't support).
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g,      (_, n) => { try { return String.fromCodePoint(parseInt(n, 10));  } catch { return _; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return _; } })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

interface TgPost { text: string; pubDate: string; link: string; channel: string; }

function parseTelegramHTML(html: string, channel: string): TgPost[] {
  const posts: TgPost[] = [];
  const blocks = html.split('tgme_widget_message_wrap').slice(1);

  for (const block of blocks) {
    const textMatch = block.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
    if (!textMatch) continue;

    const text = decodeEntities(
      textMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    ).trim();
    if (!text || text.length < 10) continue;

    const dateMatch = block.match(
      /<a class="tgme_widget_message_date" href="(https:\/\/t\.me\/[^"]+)"[\s\S]*?<time[^>]*datetime="([^"]+)"/i
    );
    posts.push({
      text,
      pubDate:  dateMatch ? dateMatch[2] : new Date().toISOString(),
      link:     dateMatch ? dateMatch[1] : `https://t.me/${channel}`,
      channel,
    });
  }
  return posts;
}

// ---------------------------------------------------------------------------
// Outage extraction helpers
// ---------------------------------------------------------------------------

function isOutagePost(text: string): boolean {
  const lower = text.toLowerCase();
  return OUTAGE_TERMS.some(term => lower.includes(term));
}

function classifyType(text: string): OutageType {
  const lower = text.toLowerCase();
  if (lower.includes('аварійн') || lower.includes('екстрен') || lower.includes('emergency')) return 'emergency';
  if (lower.includes('планов') || lower.includes('графік') || lower.includes('scheduled')) return 'scheduled';
  return 'unknown';
}

function classifySeverity(text: string): OutageSeverity {
  const lower = text.toLowerCase();
  if (lower.includes('повністю') || lower.includes('повне') || lower.includes('full') || lower.includes('complete')) return 'full';
  return 'partial';
}

function extractRegions(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const [stem, oblast] of REGION_STEMS) {
    if (lower.includes(stem) && !found.includes(oblast)) {
      found.push(oblast);
    }
  }
  return found;
}

function isRecentEnough(pubDate: string, maxAgeMs = 72 * 60 * 60 * 1000): boolean {
  try {
    return Date.now() - new Date(pubDate).getTime() < maxAgeMs;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core scrape + parse
// ---------------------------------------------------------------------------

async function scrapeOutages(): Promise<OutageRecord[]> {
  const fetchChannel = async (channel: string): Promise<TgPost[]> => {
    try {
      const res = await fetch(`https://t.me/s/${channel}`, {
        signal: AbortSignal.timeout(8000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
      if (!res.ok) return [];
      return parseTelegramHTML(await res.text(), channel);
    } catch {
      return [];
    }
  };

  const results = await Promise.allSettled(OUTAGE_CHANNELS.map(fetchChannel));

  // regionName → best record (most recent wins)
  const byRegion = new Map<string, { record: OutageRecord; ts: number; sources: string[] }>();

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const post of result.value) {
      if (!isRecentEnough(post.pubDate)) continue;
      if (!isOutagePost(post.text)) continue;

      const regions = extractRegions(post.text);
      if (regions.length === 0) continue;

      const type     = classifyType(post.text);
      const severity = classifySeverity(post.text);
      const ts       = new Date(post.pubDate).getTime();
      const schedule = post.text.split('\n')[0].substring(0, 120);

      for (const regionName of regions) {
        const coords = OBLAST_COORDS[regionName];
        if (!coords) continue;

        const existing = byRegion.get(regionName);
        if (!existing) {
          byRegion.set(regionName, {
            record: { regionName, lat: coords[0], lng: coords[1], type, severity, schedule, source: post.link },
            ts,
            sources: [post.link],
          });
        } else {
          // Merge sources; keep the most urgent type
          if (!existing.sources.includes(post.link)) existing.sources.push(post.link);
          if (ts > existing.ts) {
            existing.ts = ts;
            existing.record.schedule = schedule;
            existing.record.source = post.link;
          }
          // Escalate type: emergency > unknown > scheduled
          if (type === 'emergency') existing.record.type = 'emergency';
          else if (type === 'scheduled' && existing.record.type === 'unknown') existing.record.type = 'scheduled';
          if (severity === 'full') existing.record.severity = 'full';
        }
      }
    }
  }

  const outages: OutageRecord[] = [];
  for (const { record, sources } of byRegion.values()) {
    if (sources.length > 1) {
      record.source = `${sources.length} reports`;
    }
    outages.push(record);
  }

  return outages;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET() {
  const now = Date.now();

  if (outageCache !== null && now - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(
      { outages: outageCache, total: outageCache.length, live_data: true, timestamp: new Date(cachedAt).toISOString() },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } }
    );
  }

  if (!inflight) {
    inflight = scrapeOutages().then(result => {
      outageCache = result;
      cachedAt = Date.now();
      inflight = null;
      return result;
    }).catch(() => {
      inflight = null;
      return outageCache ?? [];
    });
  }

  try {
    const outages = await inflight;
    return NextResponse.json(
      { outages, total: outages.length, live_data: true, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } }
    );
  } catch {
    return NextResponse.json(
      { outages: [], total: 0, live_data: false, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
