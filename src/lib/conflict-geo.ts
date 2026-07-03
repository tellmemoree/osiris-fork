/**
 * OSIRIS — Conflict Geo Shared Library
 *
 * Shared constants and utilities used by /api/conflict-events and
 * /api/gdelt (deprecation alias). Extracted so both routes share a single
 * source of truth for GEO_DICT, RSS_FEEDS, CONFLICT_KEYWORDS, and the
 * deduplication / confidence-tiering algorithm.
 *
 * NOTE: GEO_DICT tuples are [lng, lat] (GeoJSON order).
 */

// ── Unified event types ──────────────────────────────────────────────────────

export type Confidence = 'confirmed' | 'reported' | 'unverified';
export type EventType = 'battle' | 'strike' | 'unrest' | 'one-sided' | 'conflict' | 'political';

export interface ConflictEvent {
  id: string;
  lat: number;
  lng: number;
  name: string;
  url?: string;
  html?: string;
  eventType: EventType;
  sources: string[];
  confidence?: Confidence; // set by clusterEvents(); absent on raw pre-cluster events
  published?: string; // ISO 8601 UTC
  deaths?: number;
}

// ── HTML escaping for the `html` field ───────────────────────────────────────
// The `html` field is assembled from scraped RSS title/link. Escape it so the
// value stays inside the repo's "escape all external/scraped data" contract,
// even though no consumer renders it raw today (defense against a future sink).
export function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
// http(s)-only href, quote-escaped for the attribute (blocks javascript:/data:).
export function safeHref(u: string): string {
  const s = String(u ?? '').trim();
  return /^https?:\/\//i.test(s) ? escapeHtml(s) : '#';
}

// ── RSS feeds ────────────────────────────────────────────────────────────────

export const RSS_FEEDS = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',          source: 'BBC World' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml',            source: 'Al Jazeera' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', source: 'NYT World' },
  { url: 'https://kyivindependent.com/feed/',                    source: 'Kyiv Independent' },
  { url: 'https://www.ukrinform.ua/rss/block-lastnews',          source: 'Ukrinform' },
  { url: 'https://www.ukrinform.ua/rss/block-war',               source: 'Ukrinform War' },
  { url: 'https://www.unian.info/rss/war',                       source: 'UNIAN War' },
  { url: 'https://www.pravda.com.ua/eng/rss/',                   source: 'Ukrainska Pravda' },
  { url: 'https://euromaidanpress.com/feed/',                    source: 'Euromaidan Press' },
  { url: 'https://www.understandingwar.org/rss.xml',             source: 'ISW' },
  { url: 'https://meduza.io/rss/all',                            source: 'Meduza' },
  { url: 'https://www.rferl.org/api/z_yqpiiyu-qxq',             source: 'RFE/RL' },
];

// ── Geo dictionary ───────────────────────────────────────────────────────────
// Tuples are [lng, lat] (GeoJSON order).

export const GEO_DICT: Record<string, [number, number]> = {
  'ukraine':        [31.1656, 48.3794],
  'kyiv':           [30.5234, 50.4501],
  'russia':         [37.6173, 55.7558],
  'moscow':         [37.6173, 55.7558],
  'gaza':           [34.4668, 31.5017],
  'israel':         [34.8516, 31.0461],
  'tel aviv':       [34.7818, 32.0853],
  'palestine':      [35.2332, 31.9522],
  'iran':           [53.6880, 32.4279],
  'tehran':         [51.3890, 35.6892],
  'syria':          [38.9968, 34.8021],
  'lebanon':        [35.8623, 33.8547],
  'beirut':         [35.5018, 33.8938],
  'yemen':          [47.5868, 15.5527],
  'houthi':         [44.2066, 15.3694],
  'sudan':          [30.2176, 12.8628],
  'china':          [116.4074, 39.9042],
  'taiwan':         [120.9605, 23.6978],
  'korea':          [127.7669, 35.9078],
  'usa':            [-77.0369, 38.9072],
  'myanmar':        [95.9560, 21.9162],
  'haiti':          [-72.2852, 18.9712],
  'somalia':        [46.1996, 5.1521],
  'bulgaria':       [25.4858, 42.7339],
  'serbia':         [21.0059, 44.0165],
  'greece':         [21.8243, 39.0742],
  'turkey':         [35.2433, 38.9637],
  'macedonia':      [21.7453, 41.6086],
  'romania':        [24.9668, 45.9432],
  'france':         [2.2137, 46.2276],
  'germany':        [10.4515, 51.1657],
  'uk':             [-3.4359, 55.3781],
  'mexico':         [-102.5528, 23.6345],
  // Frontline cities
  'bakhmut':        [38.000, 48.596],
  'avdiivka':       [37.750, 47.967],
  'toretsk':        [37.820, 48.415],
  'chasiv yar':     [37.859, 48.577],
  'kupiansk':       [37.617, 49.709],
  'vovchansk':      [36.940, 50.291],
  'lyman':          [37.802, 48.984],
  'kostiantynivka': [37.700, 48.528],
  'pokrovsk':       [37.176, 48.279],
  'kurakhove':      [37.272, 47.988],
  'orikhiv':        [35.784, 47.568],
  'robotyne':       [35.843, 47.455],
  // Occupied / strategic
  'mariupol':       [37.549, 47.097],
  'melitopol':      [35.363, 46.847],
  'berdyansk':      [36.790, 46.756],
  'energodar':      [34.655, 47.500],
  'kramatorsk':     [37.556, 48.731],
  'sloviansk':      [37.616, 48.865],
  'kherson':        [32.601, 46.635],
  'zaporizhzhia':   [35.139, 47.838],
  'sumy':           [34.800, 50.910],
  'mykolaiv':       [31.994, 46.975],
  'odesa':          [30.723, 46.482],
  'dnipro':         [35.046, 48.465],
  'kharkiv':        [36.230, 49.990],
  'poltava':        [34.551, 49.588],
  // Russian border
  'belgorod':       [36.587, 50.595],
  'kursk':          [36.193, 51.730],
  'bryansk':        [34.364, 53.243],
  'voronezh':       [39.184, 51.672],
  // Russian interior / military airfields
  'rostov':         [39.702, 47.236],
  'krasnodar':      [38.975, 45.035],
  'novorossiysk':   [37.768, 44.724],
  'taganrog':       [38.897, 47.236],
  'volgograd':      [44.513, 48.708],
  'saratov':        [46.034, 51.533],
  'engels':         [46.209, 51.484],
  'morozovsk':      [41.791, 48.315],
  'millerovo':      [40.396, 48.922],
  'yeysk':          [38.277, 46.710],
  'ryazan':         [39.692, 54.627],
  'tula':           [37.617, 54.193],
  'smolensk':       [32.040, 54.782],
  'lipetsk':        [39.571, 52.603],
  'murmansk':       [33.083, 68.958],
  'kazan':          [49.109, 55.796],
  'samara':         [50.100, 53.196],
  'saint petersburg': [30.361, 59.931],
  'dzhankoi':       [34.393, 45.709],
  'saky':           [33.599, 45.134],
  // Crimea
  'crimea':         [34.102, 44.952],
  'sevastopol':     [33.522, 44.587],
  'kerch':          [36.470, 45.354],
  // Moldova / Belarus
  'chisinau':       [28.864, 47.010],
  'tiraspol':       [29.643, 46.843],
  'minsk':          [27.561, 53.904],
};

// ── Conflict keywords ────────────────────────────────────────────────────────

export const CONFLICT_KEYWORDS = [
  'attack', 'strike', 'missile', 'drone', 'war', 'troops', 'military',
  'protest', 'riot', 'police', 'clash', 'bomb', 'killed', 'forces',
  'mobilization', 'counterattack', 'offensive', 'ceasefire', 'shelling',
  'artillery', 'occupied', 'liberated', 'incursion', 'bridgehead',
  'shahed', 'himars', 'kab', 'glide bomb',
];

// ── Geo mapper ───────────────────────────────────────────────────────────────

// Pre-compiled at module load — avoids rebuilding 90+ RegExps on every call.
const GEO_MATCHERS: Array<[RegExp, [number, number]]> = Object.entries(GEO_DICT).map(
  ([loc, point]) => [new RegExp(`\\b${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), point],
);

/**
 * Scans text for the first GEO_DICT keyword using word-boundary matching.
 * Returns a raw [lng, lat] tuple or null if no keyword matches.
 * Callers that need map jitter must apply it themselves.
 */
export function geoMapText(text: string): [number, number] | null {
  const lower = text.toLowerCase();
  for (const [regex, point] of GEO_MATCHERS) {
    if (regex.test(lower)) return point;
  }
  return null;
}

// ── Deduplication + confidence tiering ───────────────────────────────────────

// Source families: sources within the same family share one upstream.
// 'confirmed' requires ≥2 distinct families, not just ≥2 source labels.
const SOURCE_FAMILY: Record<string, string> = {
  'gdelt':      'gdelt',
  'gdelt-rss':  'gdelt',   // same upstream as gdelt geo — not independent
  'telegram':   'telegram',
  'ucdp':       'ucdp',
  'reliefweb':  'reliefweb',
};

function bucketId(key: string): string {
  // btoa is Web-standard and edge-safe; avoids Node-only Buffer.
  return btoa(key).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c] ?? c)).slice(0, 12);
}

/**
 * Clusters raw ConflictEvents by 0.3° spatial proximity + sliding 2-hour
 * temporal window. Within each spatial cell, events are sorted by timestamp
 * and split into clusters whenever the gap between consecutive events exceeds
 * 2h — the same gap-based logic the threat-wave builder uses for Shahed waves.
 *
 * This replaces the old fixed-epoch bucket (Math.floor(ts / 7_200_000)) which
 * split events 10 min apart that straddled a wall-clock boundary into separate
 * markers, and fused unrelated events that happened to land in the same 2h slot.
 *
 * Confidence tiers (same as before):
 *   confirmed   — ≥ 2 distinct source families present
 *   unverified  — sole family is 'telegram'
 *   reported    — everything else
 */
export function clusterEvents(raw: ConflictEvent[]): ConflictEvent[] {
  const TWO_HOURS = 2 * 60 * 60 * 1_000;

  // Step 1: group by spatial cell (0.3° grid).
  const spatialGroups = new Map<string, ConflictEvent[]>();
  for (const ev of raw) {
    const spatialKey = `${Math.round(ev.lat / 0.3)}|${Math.round(ev.lng / 0.3)}`;
    const group = spatialGroups.get(spatialKey) ?? [];
    group.push(ev);
    spatialGroups.set(spatialKey, group);
  }

  const merged: ConflictEvent[] = [];

  const mergeCluster = (spatialKey: string, cluster: ConflictEvent[]) => {
    if (cluster.length === 0) return;

    let latSum = 0, lngSum = 0, totalDeaths = 0;
    let longestName = '';
    let earliestTs = Infinity;
    let firstUrl: string | undefined;
    let firstHtml: string | undefined;
    const firstEventType = cluster[0].eventType;
    const familySet = new Set<string>();
    const sourceSet = new Set<string>();

    for (const e of cluster) {
      latSum += e.lat;
      lngSum += e.lng;
      totalDeaths += e.deaths ?? 0;
      if (e.name.length > longestName.length) longestName = e.name;
      if (e.published) {
        const t = new Date(e.published).getTime();
        if (!Number.isNaN(t) && t < earliestTs) earliestTs = t;
      }
      if (!firstUrl && e.url) firstUrl = e.url;
      if (!firstHtml && e.html) firstHtml = e.html;
      for (const s of e.sources) {
        sourceSet.add(s);
        familySet.add(SOURCE_FAMILY[s] ?? s);
      }
    }

    const allSources = Array.from(sourceSet);
    const earliestPublished = isFinite(earliestTs) ? new Date(earliestTs).toISOString() : undefined;

    let confidence: Confidence;
    if (familySet.size >= 2) confidence = 'confirmed';
    else if (familySet.size === 1 && familySet.has('telegram')) confidence = 'unverified';
    else confidence = 'reported';

    // Stable ID: spatial cell + hour-floored earliest timestamp. Flooring to the
    // hour gives the same ID across consecutive API calls for the same cluster.
    const hourBucket = isFinite(earliestTs) ? Math.floor(earliestTs / 3_600_000) : Math.floor(Date.now() / 3_600_000);
    const key = `${spatialKey}|${hourBucket}`;

    merged.push({
      id: bucketId(key),
      lat: latSum / cluster.length,
      lng: lngSum / cluster.length,
      name: longestName || 'Conflict event',
      url: firstUrl,
      html: firstHtml,
      eventType: firstEventType,
      sources: allSources,
      confidence,
      published: earliestPublished,
      deaths: totalDeaths > 0 ? totalDeaths : undefined,
    });
  };

  // Step 2: within each spatial cell, sort by time then split on gaps > 2h.
  for (const [spatialKey, group] of spatialGroups) {
    group.sort((a, b) => {
      const ta = a.published ? new Date(a.published).getTime() : Date.now();
      const tb = b.published ? new Date(b.published).getTime() : Date.now();
      return ta - tb;
    });

    let currentCluster: ConflictEvent[] = [];
    for (const ev of group) {
      const ts = ev.published ? new Date(ev.published).getTime() : Date.now();
      if (currentCluster.length === 0) {
        currentCluster.push(ev);
      } else {
        const lastEv = currentCluster[currentCluster.length - 1];
        const lastTs = lastEv.published ? new Date(lastEv.published).getTime() : Date.now();
        if (ts - lastTs > TWO_HOURS) {
          mergeCluster(spatialKey, currentCluster);
          currentCluster = [ev];
        } else {
          currentCluster.push(ev);
        }
      }
    }
    mergeCluster(spatialKey, currentCluster);
  }

  return merged;
}

// ── Place geoparsing exports (used by conflict-events + telegram-threats) ─────
//
// PLACE_COORDS and the helpers below are copied from src/app/api/news/route.ts.
// Tuples are [lat, lng] — OPPOSITE of GEO_DICT which is [lng, lat].
// Do NOT modify news/route.ts — both files intentionally keep independent copies.

export const PLACE_COORDS: Record<string, [number, number]> = {
  'ukraine': [49.487, 31.272], 'kyiv': [50.450, 30.523], 'russia': [61.524, 105.318],
  'moscow': [55.755, 37.617], 'israel': [31.046, 34.851], 'gaza': [31.416, 34.333],
  'iran': [32.427, 53.688], 'lebanon': [33.854, 35.862], 'syria': [34.802, 38.996],
  'yemen': [15.552, 48.516], 'china': [35.861, 104.195], 'taiwan': [23.697, 120.960],
  'united states': [38.907, -77.036], 'europe': [48.800, 2.300], 'middle east': [31.500, 34.800],
  // Frontline cities
  'bakhmut': [48.596, 38.000], 'avdiivka': [47.967, 37.750], 'toretsk': [48.415, 37.820],
  'chasiv yar': [48.577, 37.859], 'chuhuiv': [49.836, 36.686], 'kupiansk': [49.709, 37.617],
  'vovchansk': [50.291, 36.940], 'lyman': [48.984, 37.802], 'kostiantynivka': [48.528, 37.700],
  'pokrovsk': [48.279, 37.176], 'kurakhove': [47.988, 37.272], 'velyka novosilka': [47.844, 36.797],
  'orikhiv': [47.568, 35.784], 'hulyaipole': [47.662, 36.264], 'robotyne': [47.455, 35.843],
  // Occupied/strategic
  'donetsk': [48.000, 37.800], 'luhansk': [48.566, 39.300], 'mariupol': [47.097, 37.549],
  'melitopol': [46.847, 35.363], 'berdyansk': [46.756, 36.790], 'tokmak': [47.255, 35.706],
  'nova kakhovka': [46.759, 33.388], 'energodar': [47.500, 34.655],
  'kramatorsk': [48.731, 37.556], 'sloviansk': [48.865, 37.616],
  'kherson': [46.635, 32.601], 'zaporizhzhia': [47.838, 35.139], 'sumy': [50.910, 34.800],
  'mykolaiv': [46.975, 31.994], 'odesa': [46.482, 30.723], 'dnipro': [48.465, 35.046],
  'kharkiv': [49.990, 36.230], 'kremenchuk': [49.066, 33.420], 'poltava': [49.588, 34.551],
  'cherkasy': [49.445, 32.060],
  // Russian border oblasts
  'belgorod': [50.595, 36.587], 'kursk': [51.730, 36.193], 'bryansk': [53.243, 34.364],
  'voronezh': [51.672, 39.184], 'rostov': [47.222, 39.719],
  // Crimea
  'crimea': [44.952, 34.102], 'sevastopol': [44.587, 33.522], 'kerch': [45.354, 36.470],
  'simferopol': [44.952, 34.102],
  // Moldova/Transnistria
  'chisinau': [47.010, 28.864], 'transnistria': [47.200, 29.400], 'tiraspol': [46.843, 29.643],
  // Belarus
  'minsk': [53.904, 27.561], 'grodno': [53.678, 23.829], 'brest': [52.097, 23.734],
  // Other Ukrainian oblast capitals / large cities
  'lviv': [49.840, 24.030], 'vinnytsia': [49.233, 28.468], 'zhytomyr': [50.255, 28.659],
  'rivne': [50.619, 26.252], 'ternopil': [49.554, 25.595], 'ivano-frankivsk': [48.923, 24.711],
  'uzhhorod': [48.621, 22.288], 'chernihiv': [51.494, 31.294], 'chernivtsi': [48.292, 25.935],
  'khmelnytskyi': [49.423, 26.987], 'lutsk': [50.747, 25.325], 'kropyvnytskyi': [48.508, 32.262],
  'kryvyi rih': [47.910, 33.391], 'nikopol': [47.567, 34.392], 'pavlohrad': [48.520, 35.870],
  'izyum': [49.212, 37.249], 'okhtyrka': [50.310, 34.899],
  // Wider hotspots
  'tel aviv': [32.085, 34.781], 'jerusalem': [31.769, 35.214], 'beirut': [33.888, 35.495],
  'damascus': [33.513, 36.292], 'tehran': [35.689, 51.389], 'sanaa': [15.369, 44.191],
  'red sea': [20.284, 38.512], 'saint petersburg': [59.931, 30.361], 'novorossiysk': [44.724, 37.768],
  // Russian cities, border oblasts and military airfields
  'krasnodar': [45.035, 38.975], 'taganrog': [47.236, 38.897], 'volgograd': [48.708, 44.513],
  'saratov': [51.533, 46.034], 'engels': [51.484, 46.209], 'morozovsk': [48.315, 41.791],
  'millerovo': [48.922, 40.396], 'yeysk': [46.710, 38.277], 'ryazan': [54.627, 39.692],
  'tula': [54.193, 37.617], 'smolensk': [54.782, 32.040], 'lipetsk': [52.603, 39.571],
  'murmansk': [68.958, 33.083], 'kazan': [55.796, 49.109], 'samara': [53.196, 50.100],
  'dzhankoi': [45.709, 34.393], 'saky': [45.134, 33.599],
  'kronstadt': [59.990, 29.760], 'кронштадт': [59.990, 29.760],
  // Ukrainian / slang spellings of Russian cities
  'пітер': [59.931, 30.361],
  'пітєр': [59.931, 30.361],
  'новоросійськ': [44.724, 37.768],
  // Russian cities absent from gazetteer (new UA strike targets)
  'кизилюрт': [43.209, 46.868],
  'чебоксар': [56.144, 47.249],
  'самар': [53.196, 50.100],
  'владімірськ': [56.130, 40.411],
  'владимирск': [56.130, 40.411],
  'ust-labinsk': [45.220, 39.710], 'усть-лабинск': [45.220, 39.710], 'усть-лабінськ': [45.220, 39.710],
  'zugres': [48.010, 38.510], 'зугрес': [48.010, 38.510], 'зугрэс': [48.010, 38.510],
  'зуївська тес': [48.010, 38.510],
  // Cyrillic -- broad (country/peninsula)
  'россия': [61.524, 105.318], 'украина': [49.487, 31.272], 'крым': [44.952, 34.102],
  // Cyrillic -- Russia
  'москва': [55.756, 37.617], 'петербург': [59.931, 30.361], 'белгород': [50.596, 36.587],
  'курск': [51.730, 36.193], 'брянск': [53.244, 34.364], 'воронеж': [51.672, 39.184],
  'ростов': [47.236, 39.702], 'краснодар': [45.035, 38.975], 'новороссийск': [44.724, 37.768],
  'таганрог': [47.236, 38.897], 'волгоград': [48.708, 44.513], 'саратов': [51.533, 46.034],
  'энгельс': [51.484, 46.209], 'морозовск': [48.315, 41.791], 'миллерово': [48.922, 40.396],
  'ейск': [46.710, 38.277], 'рязань': [54.627, 39.692], 'дягилево': [54.643, 39.570],
  'тула': [54.193, 37.617], 'смоленск': [54.782, 32.040], 'липецк': [52.603, 39.571],
  'мурманск': [68.958, 33.083], 'оленегорск': [68.152, 33.464], 'казань': [55.796, 49.109],
  'севастополь': [44.587, 33.522], 'джанкой': [45.709, 34.393], 'саки': [45.134, 33.599],
  // Cyrillic -- Ukraine / occupied
  'київ': [50.450, 30.523], 'киев': [50.450, 30.523], 'харків': [49.990, 36.230],
  'харьков': [49.990, 36.230], 'покровськ': [48.279, 37.176], 'покровск': [48.279, 37.176],
  'красноармейск': [48.279, 37.176], 'бахмут': [48.596, 38.000], 'артёмовск': [48.596, 38.000],
  'артемовск': [48.596, 38.000], 'авдіївка': [47.967, 37.750], 'авдеевка': [47.967, 37.750],
  'торецьк': [48.415, 37.820], 'торецк': [48.415, 37.820], 'купянск': [49.709, 37.617],
  'вовчанськ': [50.291, 36.940], 'вовчанск': [50.291, 36.940], 'запоріжжя': [47.838, 35.139],
  'запорожье': [47.838, 35.139], 'херсон': [46.635, 32.601], 'миколаїв': [46.975, 31.994],
  'николаев': [46.975, 31.994], 'одеса': [46.482, 30.723], 'одесса': [46.482, 30.723],
  'дніпро': [48.465, 35.046], 'днепр': [48.465, 35.046], 'суми': [50.910, 34.800],
  'сумы': [50.910, 34.800], 'маріуполь': [47.097, 37.549], 'мариуполь': [47.097, 37.549],
  'вугледар': [47.779, 37.250], 'угледар': [47.779, 37.250],
  'львів': [49.840, 24.030], 'львов': [49.840, 24.030], 'полтава': [49.588, 34.551],
  'черкаси': [49.445, 32.060], 'чернігів': [51.494, 31.294], 'чернигов': [51.494, 31.294],
  'краматорськ': [48.731, 37.556], 'краматорск': [48.731, 37.556], 'словянськ': [48.865, 37.616],
  'славянск': [48.865, 37.616], 'ізюм': [49.212, 37.249], 'изюм': [49.212, 37.249],
  'нікополь': [47.567, 34.392], 'никополь': [47.567, 34.392], 'кременчук': [49.066, 33.420],
  // Ukrainian oblique-case stems
  'києв': [50.450, 30.523], 'харков': [49.990, 36.230], 'чернігов': [51.494, 31.294],
  'дніпр': [48.465, 35.046], 'миколаєв': [46.975, 31.994],
  // Gazetteer refinement (2026): front-line towns + RU strike targets
  'часів яр': [48.577, 37.859], 'часов яр': [48.577, 37.859],
  'костянтинівк': [48.528, 37.700], 'константиновк': [48.528, 37.700],
  'курахов': [47.988, 37.272], 'новосілк': [47.844, 36.797], 'новоселк': [47.844, 36.797],
  'оріхів': [47.568, 35.784], 'гуляйпол': [47.662, 36.264],
  'роботин': [47.455, 35.843], 'работин': [47.455, 35.843],
  'енергодар': [47.500, 34.655], 'энергодар': [47.500, 34.655],
  'каховк': [46.759, 33.388], 'токмак': [47.255, 35.706],
  'бердянськ': [46.756, 36.790], 'бердянск': [46.756, 36.790],
  'чугуїв': [49.836, 36.686], 'чугуев': [49.836, 36.686],
  "куп'янськ": [49.709, 37.617], 'павлоград': [48.520, 35.870],
  'охтирк': [50.310, 34.899], 'ахтырк': [50.310, 34.899],
  // Active hotspots
  'sudzha': [51.198, 35.273], 'судж': [51.198, 35.273],
  'selydove': [48.146, 37.295], 'селидов': [48.146, 37.295],
  'myrnohrad': [48.308, 37.265], 'мирноград': [48.308, 37.265],
  'novohrodivka': [48.200, 37.353], 'новогродівк': [48.200, 37.353], 'новогродовк': [48.200, 37.353],
  'hrodivka': [48.279, 37.380], 'гродівк': [48.279, 37.380], 'гродовк': [48.279, 37.380],
  'krasnohorivka': [48.011, 37.500], 'красногорівк': [48.011, 37.500], 'красногоровк': [48.011, 37.500],
  'marinka': [47.948, 37.500], "мар'їнк": [47.948, 37.500], 'марьинк': [47.948, 37.500],
  'krynky': [46.700, 33.000], 'кринки': [46.700, 33.000],
  'vremivka': [47.770, 36.660], 'времівк': [47.770, 36.660], 'времевк': [47.770, 36.660],
  // RU strike targets
  'tuapse': [44.104, 39.080], 'туапсе': [44.104, 39.080],
  'syzran': [53.159, 48.474], 'сызран': [53.159, 48.474],
  'kstovo': [56.149, 44.197], 'кстов': [56.149, 44.197],
  'ust-luga': [59.668, 28.270], 'усть-луга': [59.668, 28.270],
  'feodosia': [45.040, 35.380], 'феодос': [45.040, 35.380],
  'novoshakhtinsk': [47.776, 39.934], 'новошахтинск': [47.776, 39.934],
  'primorsko-akhtarsk': [46.046, 38.150], 'приморско-ахтарск': [46.046, 38.150],
  'akhtubinsk': [48.285, 46.193], 'ахтубинск': [48.285, 46.193],
  'toropets': [56.500, 31.633], 'торопец': [56.500, 31.633], 'торопц': [56.500, 31.633],
  'tikhoretsk': [45.856, 40.126], 'тихорецк': [45.856, 40.126],
  'dyagilevo': [54.643, 39.570], 'olenya': [68.152, 33.464],
  // Krasnodar Krai refineries
  'poltavskaya': [45.26, 38.13], 'полтавська': [45.26, 38.13], 'полтавская': [45.26, 38.13],
  'slavyansk-na-kubani': [45.26, 38.13], 'славянськ': [45.26, 38.13], 'славянск-на-кубани': [45.26, 38.13],
  'taman': [45.201, 36.728], 'таман': [45.201, 36.728],
  'tamanneftegaz': [45.201, 36.728], 'таманнефтегаз': [45.201, 36.728], 'таманэфтегаз': [45.201, 36.728],
  // Nizhnekamsk industrial cluster
  'nizhnekamsk': [55.64, 51.83], 'нижнекамск': [55.64, 51.83], 'нижнєкамськ': [55.64, 51.83],
  'taneco': [55.77, 51.88], 'танеко': [55.77, 51.88],
  'taif-nk': [55.64, 51.82], 'таіф-нк': [55.64, 51.82], 'taif': [55.64, 51.82], 'таіф': [55.64, 51.82],
  // Maritime / sea areas
  'black sea': [43.300, 33.800], 'чорне море': [43.300, 33.800], 'чёрное море': [43.300, 33.800],
  'azov sea': [46.200, 37.500], 'azov': [46.200, 37.500],
  'азовське море': [46.200, 37.500], 'азовское море': [46.200, 37.500],
  // Romanian port
  'constanta': [44.175, 28.638], 'констанц': [44.175, 28.638],
  // Occupied ports
  'berdiansk': [46.756, 36.790], 'бердіянськ': [46.756, 36.790],
  // Active frontline towns -- Latin variants
  'vuhledar': [47.779, 37.250],
  // Active frontline towns -- Cyrillic variants
  'велика новосілка': [47.844, 36.797], 'велика новоселка': [47.844, 36.797],
  'ліпці': [50.16, 36.49], 'lyptsi': [50.16, 36.49],
  'білогорівка': [47.91, 38.09], 'bilohorivka': [47.91, 38.09],
  'урожайне': [47.51, 36.98], 'urozhaine': [47.51, 36.98],
};

// Country / sea area centroids -- only used as a last resort.
export const BROAD_PLACE_KEYS = new Set<string>([
  'ukraine', 'russia', 'israel', 'iran', 'lebanon', 'syria', 'yemen', 'china',
  'taiwan', 'united states', 'europe', 'middle east', 'crimea', 'transnistria',
  'россия', 'украина', 'крым',
  'black sea', 'azov sea', 'azov', 'чорне море', 'чёрное море', 'азовське море', 'азовское море',
]);

// Build a whole-word matcher for one gazetteer key.
// Unicode-aware boundaries; Cyrillic keys allow a short trailing case-suffix.
function placeKeywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isCyrillic = /[Ѐ-ӿ]/.test(keyword);
  const tail = isCyrillic ? '\\p{L}{0,6}(?![\\p{L}\\p{N}])' : '(?![\\p{L}\\p{N}])';
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${tail}`, 'iu');
}

// Compiled once at module load -- same shape as COMPILED_GAZETTEER in news/route.ts.
export const COMPILED_PLACE_GAZETTEER: Array<{
  re: RegExp;
  coords: [number, number];
  rank: number;
  keyword: string;
}> = Object.entries(PLACE_COORDS).map(([keyword, coords]) => ({
  re: placeKeywordRegex(keyword),
  coords,
  rank: BROAD_PLACE_KEYS.has(keyword) ? 1 : 2, // named city beats country
  keyword,
}));

/**
 * Resolve the most specific place a text is about.
 * Prefers city/town over country centroid; among equally specific matches
 * picks the one mentioned first.
 *
 * Returns [lat, lng] -- NOT GeoJSON order. Callers must not swap.
 */
export function findPlaceCoords(text: string): [number, number] | null {
  const lower = text.toLowerCase();
  let best: { coords: [number, number]; rank: number; pos: number } | null = null;
  for (const { re, coords, rank } of COMPILED_PLACE_GAZETTEER) {
    const m = re.exec(lower);
    if (!m) continue;
    const pos = m.index;
    if (!best || rank > best.rank || (rank === best.rank && pos < best.pos)) {
      best = { coords, rank, pos };
    }
  }
  return best ? best.coords : null;
}

/**
 * Returns every distinct specific place named in text (rank=2 city/town matches only;
 * broad country/sea centroids excluded).
 *
 * Coords are [lat, lng] -- same as PLACE_COORDS tuples.
 */
export function findAllNamedPlaces(text: string): { coords: [number, number]; name: string }[] {
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  const out: { coords: [number, number]; name: string }[] = [];
  for (const { re, coords, rank, keyword } of COMPILED_PLACE_GAZETTEER) {
    if (rank < 2) continue;
    const key = `${coords[0]},${coords[1]}`;
    if (!seen.has(key) && re.test(lower)) {
      seen.add(key);
      out.push({ coords, name: keyword });
    }
  }
  return out;
}
