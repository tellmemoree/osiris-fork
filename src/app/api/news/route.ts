import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — shared by all consumers (strategic-thermal, captures, digest)
let newsCache: unknown = null;
let newsCachedAt = 0;
let newsInflight: Promise<unknown> | null = null;

const DATA_DIR = path.join(os.homedir(), '.osiris-data');
const DISK_CACHE_FILE = path.join(DATA_DIR, 'news-cache.json');
const SCRAPE_WINDOW_MS    = 3  * 60 * 60 * 1000;  // 3h back per run
const DISK_HORIZON_MS     = 24 * 60 * 60 * 1000;  // keep 24h of articles
const REFRESH_INTERVAL_MS = 90 * 60 * 1000;       // min gap between disk refreshes
let lastRefreshAt = 0;
interface DiskCache { raw: ParsedArticle[]; updatedAt: number; }

/**
 * OSIRIS — Military-Grade Intelligence API
 * Fetches Telegram OSINT feeds directly, with a failsafe fallback 
 * to traditional intelligence sources if Telegram blocks the IP.
 */

// Ukrainian / neutral war-OSINT channels. The first group is English-language
// OSINT; the second is native Ukrainian-language (Cyrillic) news/milblogger
// channels — all verified scrapeable via t.me/s/ — so the UA feed reads in its
// own language and its Cyrillic place names geolocate via the gazetteer below.
const UA_CHANNELS = [
  'OSINTtechnical', 'Faytuks', 'Liveuamap', 'CyberKnow',
  'GeneralStaffUA', 'ukraine_now', 'ua_forces',
  'UA_Insider', 'wartranslated', 'DefMonitor', 'UkraineWarReport',
  'Militaryland', 'DeepStateUA',
  // Ukrainian-language (Cyrillic)
  'suspilne_news', 'hromadske_ua', 'truexanewsua', 'serhii_flash',
  'operativnoZSU', 'butusovplus', 'Tsaplienko', 'lachentyt',
  'ssternenko', 'informnapalm', 'gruntmedia',
];

// Russian milblogger / MoD channels — monitored for the adversary picture.
// All verified scrapeable via t.me/s/ (rybar's /s/ preview is now disabled, so
// it is dropped from the scrape list and kept only as a source link elsewhere).
const RU_CHANNELS = [
  'milinfolive', 'wargonzo', 'epoddubny', 'sashakots', 'dva_majora',
  'voenkorKotenok', 'rvvoenkor', 'colonelcassad', 'mod_russia',
];

const TELEGRAM_CHANNELS = [...UA_CHANNELS, ...RU_CHANNELS];

const RU_CHANNEL_SET = new Set(RU_CHANNELS.map((c) => c.toLowerCase()));

// Russian-actor signals: MoD official voice, "liberation" framing, RU military named as subject.
// Fires even when a UA channel relays a Russian claim verbatim, so the tab split stays clean.
const RU_ACTOR_RE = /мо\s*рф|міноборони\s*рф|министерство\s*обороны|освобожд|освободил|армия\s*росси|вс\s*рф\s+(?:заняли|взяли|продвин|штурм|наступ)|russian\s+(?:forces?|army|troops?)\s+(?:advance|captur|seiz|storm|enter|take|occup)/i;

// Ukrainian-actor signals: official ZSU/GenStaff voice, recapture framing.
const UA_ACTOR_RE = /зсу\s+(?:відбил|звільнил|знищил|вдарил|атакувал)|сили\s+оборони|генштаб(?:\s+зсу)?|ukrainian\s+(?:forces?|army|troops?)\s+(?:liberat|recaptur|repel|strike|destroy|advance)/i;

// Which side of the war a story comes from: 'ua' = Ukrainian/neutral war OSINT,
// 'ru' = Russian milblogger/MoD, 'world' = non-Telegram RSS fallback. Drives the
// Live-Alerts tab split so the RU feed reads separately from the UA one.
//
// Actor detection runs first on Telegram posts: if the text unambiguously names
// one actor as the subject, that overrides channel membership. Channel membership
// is the fallback for ambiguous or mixed-actor articles.
function sideForSource(source: string, text = ''): 'ua' | 'ru' | 'world' {
  const m = source.match(/^t\.me\/(.+)$/i);
  if (!m) return 'world';

  if (text) {
    const isRuActor = RU_ACTOR_RE.test(text);
    const isUaActor = UA_ACTOR_RE.test(text);
    if (isRuActor && !isUaActor) return 'ru';
    if (isUaActor && !isRuActor) return 'ua';
    // Both or neither → fall through to channel
  }

  return RU_CHANNEL_SET.has(m[1].toLowerCase()) ? 'ru' : 'ua';
}

const FALLBACK_FEEDS = {
  BBC: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  AlJazeera: 'https://www.aljazeera.com/xml/rss/all.xml',
  GDACS: 'https://www.gdacs.org/xml/rss.xml'
};

const RISK_KEYWORDS = ['war','missile','strike','attack','crisis','tension','military','conflict','defense','clash','nuclear','invasion','bomb','drone','weapon','sanctions','ceasefire','escalation', 'killed', 'destroyed', 'operation', 'casualty', 'frontline', 'threat','mobilization','counterattack','offensive','shelling','artillery','occupied','liberated','breakthrough','bridgehead','incursion','shahed','himars','kab','glide bomb'];

// Cyrillic (RU/UA) conflict stems. RISK_KEYWORDS above is English-only, so
// without these every Russian/Ukrainian-language milblogger post scores the
// baseline 1 (no risk badge, never "critical") AND would be wrongly dropped by
// the conflict filter. Substring-matched (lowercased) so inflected/declined
// forms still hit (e.g. ракета/ракети/ракетний → 'ракет').
// NOTE: bare 'наступ' is deliberately excluded — it is the stem of "наступний/
// наступного" (next), a very common non-war word; use 'наступальн' (offensive)
// and 'контрнаступ' (counter-offensive) instead.
const CONFLICT_TERMS_CYR = [
  'ракет', 'удар', 'обстрел', 'обстріл', 'дрон', 'бпла', 'фпв', 'наступальн', 'фронт',
  'зсу', 'всу', 'окуп', 'штурм', 'снаряд', 'шахед', 'герань', 'контрнаступ',
  'мобіліз', 'мобилиз', 'війн', 'войн', 'бій', 'бой', 'взрыв', 'вибух', 'пво',
  'ппо', 'хаймарс', 'авіаудар', 'авиаудар', 'оборон', 'загарбник', 'загиб',
  'поранен', 'танк', 'артилер', 'артиллер', 'бойов', 'боев', 'атак',
  'хлопк',  // Russian informal "bang" (хлопок/хлопка) — common euphemism for explosion in ru state/milblog posts
];

// NOTE: tuples are [lat, lng] here — the OPPOSITE of gdelt/route.ts's GEO_DICT.
const KEYWORD_COORDS: Record<string, [number, number]> = {
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
  // Other Ukrainian oblast capitals / large cities (kept specific so a story that
  // also says "Ukraine" still pins to the city actually named).
  'lviv': [49.840, 24.030], 'vinnytsia': [49.233, 28.468], 'zhytomyr': [50.255, 28.659],
  'rivne': [50.619, 26.252], 'ternopil': [49.554, 25.595], 'ivano-frankivsk': [48.923, 24.711],
  'uzhhorod': [48.621, 22.288], 'chernihiv': [51.494, 31.294], 'chernivtsi': [48.292, 25.935],
  'khmelnytskyi': [49.423, 26.987], 'lutsk': [50.747, 25.325], 'kropyvnytskyi': [48.508, 32.262],
  'kryvyi rih': [47.910, 33.391], 'nikopol': [47.567, 34.392], 'pavlohrad': [48.520, 35.870],
  'izyum': [49.212, 37.249], 'okhtyrka': [50.310, 34.899],
  // Wider hotspots that show up in the same feeds
  'tel aviv': [32.085, 34.781], 'jerusalem': [31.769, 35.214], 'beirut': [33.888, 35.495],
  'damascus': [33.513, 36.292], 'tehran': [35.689, 51.389], 'sanaa': [15.369, 44.191],
  'red sea': [20.284, 38.512], 'saint petersburg': [59.931, 30.361], 'novorossiysk': [44.724, 37.768],
  // Russian cities, border oblasts and military airfields (high OSINT value —
  // frequent drone-strike targets). Both Latin and Cyrillic so RU-language
  // Telegram posts geolocate as well as English RSS.
  'krasnodar': [45.035, 38.975], 'taganrog': [47.236, 38.897], 'volgograd': [48.708, 44.513],
  'saratov': [51.533, 46.034], 'engels': [51.484, 46.209], 'morozovsk': [48.315, 41.791],
  'millerovo': [48.922, 40.396], 'yeysk': [46.710, 38.277], 'ryazan': [54.627, 39.692],
  'tula': [54.193, 37.617], 'smolensk': [54.782, 32.040], 'lipetsk': [52.603, 39.571],
  'murmansk': [68.958, 33.083], 'kazan': [55.796, 49.109], 'samara': [53.196, 50.100],
  'dzhankoi': [45.709, 34.393], 'saky': [45.134, 33.599],
  'kronstadt': [59.990, 29.760], 'кронштадт': [59.990, 29.760],
  // Ukrainian / slang spellings of Russian cities seen in UA-language posts
  'пітер': [59.931, 30.361],   // Rus slang for Saint Petersburg
  'пітєр': [59.931, 30.361],   // Ukrainian є-spelling of Piter
  'новоросійськ': [44.724, 37.768], // Ukrainian spelling of Novorossiysk
  // Russian cities absent from gazetteer (new UA strike targets)
  'кизилюрт': [43.209, 46.868],  // Kizlyurt, Dagestan
  'чебоксар': [56.144, 47.249],  // Cheboksary (incl. declined Чебоксарах)
  'самар': [53.196, 50.100],     // Samara declined forms (Самарі, Самарою)
  'владімірськ': [56.130, 40.411], // Vladimir Oblast — Ukrainian adjectival stem
  'владимирск': [56.130, 40.411], // Vladimir Oblast — Russian adjectival stem
  'ust-labinsk': [45.220, 39.710], 'усть-лабинск': [45.220, 39.710], 'усть-лабінськ': [45.220, 39.710],
  'zugres': [48.010, 38.510], 'зугрес': [48.010, 38.510], 'зугрэс': [48.010, 38.510],
  'зуївська тес': [48.010, 38.510],
  // Cyrillic — broad (country/peninsula; only used when no city is named)
  'россия': [61.524, 105.318], 'украина': [49.487, 31.272], 'крым': [44.952, 34.102],
  // Cyrillic — Russia
  'москва': [55.756, 37.617], 'петербург': [59.931, 30.361], 'белгород': [50.596, 36.587],
  'курск': [51.730, 36.193], 'брянск': [53.244, 34.364], 'воронеж': [51.672, 39.184],
  'ростов': [47.236, 39.702], 'краснодар': [45.035, 38.975], 'новороссийск': [44.724, 37.768],
  'таганрог': [47.236, 38.897], 'волгоград': [48.708, 44.513], 'саратов': [51.533, 46.034],
  'энгельс': [51.484, 46.209], 'морозовск': [48.315, 41.791], 'миллерово': [48.922, 40.396],
  'ейск': [46.710, 38.277], 'рязань': [54.627, 39.692], 'дягилево': [54.643, 39.570],
  'тула': [54.193, 37.617], 'смоленск': [54.782, 32.040], 'липецк': [52.603, 39.571],
  'мурманск': [68.958, 33.083], 'оленегорск': [68.152, 33.464], 'казань': [55.796, 49.109],
  'севастополь': [44.587, 33.522], 'джанкой': [45.709, 34.393], 'саки': [45.134, 33.599],
  // Cyrillic — Ukraine / occupied (UA and RU spellings of the same place)
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
  // Ukrainian oblique-case stems (і↔о / ї↔є vowel shifts, e.g. Київ→Києва,
  // Харків→Харкова, Дніпро→Дніпра) so declined mentions still geolocate.
  'києв': [50.450, 30.523], 'харков': [49.990, 36.230], 'чернігов': [51.494, 31.294],
  'дніпр': [48.465, 35.046], 'миколаєв': [46.975, 31.994],
  // ── Gazetteer refinement (2026): front-line towns + RU strike targets ──
  // RU/UA Telegram (the bulk of capture/strike posts) is Cyrillic, so towns that were
  // Latin-only never matched those posts. Declinable -а/-ка/-е names are keyed on their
  // CONSONANT STEM because keywordRegex only APPENDS case suffixes — it can't swap the
  // nominative's final vowel (Костянтинівк-а/-и/-у; Суджа→Суджи). Deliberately NOT added,
  // as confirmed common-word collisions: bare 'лиман' (=estuary), 'украинск'/'українськ'
  // (=the adjective "Ukrainian"), 'орехов' (=Moscow's Orekhovo).
  // Cyrillic for front-line towns previously Latin-only (UA + RU spellings):
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
  // New active hotspots (Pokrovsk axis · Kursk/Sudzha incursion · Kherson left bank):
  'sudzha': [51.198, 35.273], 'судж': [51.198, 35.273],
  'selydove': [48.146, 37.295], 'селидов': [48.146, 37.295],
  'myrnohrad': [48.308, 37.265], 'мирноград': [48.308, 37.265],
  'novohrodivka': [48.200, 37.353], 'новогродівк': [48.200, 37.353], 'новогродовк': [48.200, 37.353],
  'hrodivka': [48.279, 37.380], 'гродівк': [48.279, 37.380], 'гродовк': [48.279, 37.380],
  'krasnohorivka': [48.011, 37.500], 'красногорівк': [48.011, 37.500], 'красногоровк': [48.011, 37.500],
  'marinka': [47.948, 37.500], "мар'їнк": [47.948, 37.500], 'марьинк': [47.948, 37.500],
  'krynky': [46.700, 33.000], 'кринки': [46.700, 33.000],
  'vremivka': [47.770, 36.660], 'времівк': [47.770, 36.660], 'времевк': [47.770, 36.660],
  // RU strike targets (depots / refineries / airfields) seen in strike feeds:
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
  // Krasnodar Krai refineries (Slavyansk-na-Kubani cluster, Taman Peninsula terminals) — struck June 2026
  'poltavskaya': [45.26, 38.13], 'полтавська': [45.26, 38.13], 'полтавская': [45.26, 38.13],
  'slavyansk-na-kubani': [45.26, 38.13], 'славянськ': [45.26, 38.13], 'славянск-на-кубани': [45.26, 38.13],
  'taman': [45.201, 36.728], 'таман': [45.201, 36.728],
  'tamanneftegaz': [45.201, 36.728], 'таманнефтегаз': [45.201, 36.728], 'таманэфтегаз': [45.201, 36.728],
  // Nizhnekamsk industrial cluster (TANECO + TAIF-NK + Nizhnekamskneftekhim — struck June 2026)
  'nizhnekamsk': [55.64, 51.83], 'нижнекамск': [55.64, 51.83], 'нижнєкамськ': [55.64, 51.83],
  'taneco': [55.77, 51.88], 'танеко': [55.77, 51.88],
  'taif-nk': [55.64, 51.82], 'таіф-нк': [55.64, 51.82], 'taif': [55.64, 51.82], 'таіф': [55.64, 51.82],
  // Maritime / sea areas (ships in Black/Azov Sea are frequent strike targets)
  'black sea': [43.300, 33.800], 'чорне море': [43.300, 33.800], 'чёрное море': [43.300, 33.800],
  'azov sea': [46.200, 37.500], 'azov': [46.200, 37.500],
  'азовське море': [46.200, 37.500], 'азовское море': [46.200, 37.500],
  // Romanian port — Ukrainian drone/ship incidents in Constanta area
  'constanta': [44.175, 28.638], 'констанц': [44.175, 28.638],
  // Occupied ports not yet in gazetteer
  'berdiansk': [46.756, 36.790], 'бердіянськ': [46.756, 36.790],
  // Active frontline towns — Latin variants previously missing
  'vuhledar': [47.779, 37.250],
  // Active frontline towns — Cyrillic variants previously missing
  'велика новосілка': [47.844, 36.797], 'велика новоселка': [47.844, 36.797],
  'ліпці': [50.16, 36.49], 'lyptsi': [50.16, 36.49],
  'білогорівка': [47.91, 38.09], 'bilohorivka': [47.91, 38.09],
  'урожайне': [47.51, 36.98], 'urozhaine': [47.51, 36.98],
};

function scoreRisk(text: string): number {
  const lower = text.toLowerCase();
  let score = 1;
  // English keywords AND Cyrillic conflict stems both count — otherwise every
  // RU/UA-language post floors at 1 and never earns a risk badge / "critical".
  for (const kw of RISK_KEYWORDS) {
    if (lower.includes(kw)) score += 2;
  }
  for (const kw of CONFLICT_TERMS_CYR) {
    if (lower.includes(kw)) score += 2;
  }
  return Math.min(10, score);
}

// Country / continent-level keys. Only used as a last resort: an article that
// names both a country and a city pins to the city, never the country centroid
// (which is what made every "Ukraine ..." story pile up in the middle of the map).
const BROAD_KEYS = new Set<string>([
  'ukraine', 'russia', 'israel', 'iran', 'lebanon', 'syria', 'yemen', 'china',
  'taiwan', 'united states', 'europe', 'middle east', 'crimea', 'transnistria',
  'россия', 'украина', 'крым',
  'black sea', 'azov sea', 'azov', 'чорне море', 'чёрное море', 'азовське море', 'азовское море',
]);

// A post counts as war/conflict news if it carries any English risk keyword OR
// any Cyrillic conflict stem. Keeps ALL conflicts (UA-RU, Middle East, …) and
// drops non-war noise (channel ads, promos, sport, weather) in either language.
function isConflict(text: string): boolean {
  const lower = text.toLowerCase();
  return RISK_KEYWORDS.some((kw) => lower.includes(kw)) ||
    CONFLICT_TERMS_CYR.some((kw) => lower.includes(kw));
}

// Build a whole-word matcher for one gazetteer key. Unicode-aware boundaries so
// we don't match "iran" inside another word, and multi-word keys ("nova
// kakhovka", "red sea") match verbatim. Russian/Ukrainian place names inflect by
// case (Белгород→Белгороду→Белгородской), so Cyrillic keys allow a short trailing
// case-suffix; Latin keys stay strict so "Iranian" still doesn't match "Iran".
function keywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isCyrillic = /[Ѐ-ӿ]/.test(keyword);
  // Ukrainian/Russian place adjectives can have 4–6 char endings: -ський/-ської/-ського.
  // Latin stays strict (no case-suffix scanning needed).
  const tail = isCyrillic ? '\\p{L}{0,6}(?![\\p{L}\\p{N}])' : '(?![\\p{L}\\p{N}])';
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${tail}`, 'iu');
}

// Compile every gazetteer entry once at module load — findCoords runs this over
// hundreds of articles per request, so the regexes must not be rebuilt per call.
// `keyword` is kept so consumers can do location-aware text extraction.
const COMPILED_GAZETTEER = Object.entries(KEYWORD_COORDS).map(([keyword, coords]) => ({
  re: keywordRegex(keyword),
  coords,
  rank: BROAD_KEYS.has(keyword) ? 1 : 2, // a named city beats a country
  keyword,
}));

/**
 * Resolve the place a story is actually about. Prefers the most specific
 * location named (city/town over country) and, among equally specific matches,
 * the one mentioned first. Returns null when the gazetteer names nothing.
 */
function findCoords(text: string): [number, number] | null {
  const lower = text.toLowerCase();
  let best: { coords: [number, number]; rank: number; pos: number } | null = null;
  for (const { re, coords, rank } of COMPILED_GAZETTEER) {
    const m = re.exec(lower);
    if (!m) continue;
    const pos = m.index;
    if (!best || rank > best.rank || (rank === best.rank && pos < best.pos)) {
      best = { coords, rank, pos };
    }
  }
  return best ? best.coords : null;
}

// Every distinct SPECIFIC place a story names (raw gazetteer centroids, un-jittered).
// Returns both coords and the matched keyword so callers can do location-aware text
// extraction (e.g. find the sentence that mentions "belgorod" specifically).
// Deliberately excludes broad country/sea centroids (rank=1).
function findAllPlaces(text: string): { coords: [number, number]; name: string }[] {
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  const out: { coords: [number, number]; name: string }[] = [];
  for (const { re, coords, rank, keyword } of COMPILED_GAZETTEER) {
    if (rank < 2) continue;
    const key = `${coords[0]},${coords[1]}`;
    if (!seen.has(key) && re.test(lower)) { seen.add(key); out.push({ coords, name: keyword }); }
  }
  return out;
}
function findAllCoords(text: string): [number, number][] {
  return findAllPlaces(text).map(p => p.coords);
}

// Spread several stories about the same place into a small (~0–8 km) cluster
// around it, deterministically per story id, so dots don't stack into a single
// unreadable blob over the city centre.
function jitterAround([lat, lng]: [number, number], seed: string): [number, number] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  }
  const angle = (h % 360) * (Math.PI / 180);
  const radius = ((h >>> 9) % 70) / 1000; // up to ~0.07° ≈ 6–8 km
  // Divide the longitude offset by cos(lat) so the spread is a true circle on
  // the ground rather than an east-west-compressed ellipse at high latitudes.
  const cosLat = Math.max(0.05, Math.cos(lat * Math.PI / 180));
  return [lat + radius * Math.cos(angle), lng + (radius * Math.sin(angle)) / cosLat];
}

// Decode HTML entities that survive tag-stripping. Telegram/RSS payloads carry
// numeric (&#33;), hex (&#x21;), and named entities; without this they render
// literally (e.g. "летят&#33;"). &amp; is decoded last so we never double-decode
// a pre-escaped "&amp;#33;" into "!".
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return _; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return _; } })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// A parsed feed item, before risk-scoring/geo-mapping in GET().
interface ParsedArticle {
  title: string;
  description: string;
  link: string;
  pubDate: string;
  source: string;
  hasVideo: boolean;
}

function parseTelegramHTML(html: string, channel: string): ParsedArticle[] {
  const items: ParsedArticle[] = [];
  // Split on the per-message wrapper so each chunk contains the message body
  // AND its footer (where the <time datetime> date link lives). The previous
  // block regex stopped before the footer, so every item fell back to now().
  const blocks = html.split('tgme_widget_message_wrap').slice(1);

  for (const blockHtml of blocks) {
    const textRegex = /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i;
    const textMatch = blockHtml.match(textRegex);
    if (!textMatch) continue;

    const text = decodeEntities(textMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
    if (!text || text.length < 10) continue;

    // [\s\S]*? handles attributes/newlines between the date link and <time>.
    const dateRegex = /<a class="tgme_widget_message_date" href="(https:\/\/t\.me\/[^"]+)"[\s\S]*?<time[^>]*datetime="([^"]+)"/i;
    const dateMatch = blockHtml.match(dateRegex);
    const link = dateMatch ? dateMatch[1] : `https://t.me/${channel}`;
    const pubDate = dateMatch ? dateMatch[2] : new Date().toISOString();

    const title = text.split('\n')[0].substring(0, 100);
    const hasVideo = /tgme_widget_message_video|tgme_widget_message_roundvideo|<video[\s>]/i.test(blockHtml);

    items.push({ title, description: text, link, pubDate, source: `t.me/${channel}`, hasVideo });
  }
  return items;
}

async function fetchChannelWithPagination(channel: string, cutoffMs: number): Promise<ParsedArticle[]> {
  const all: ParsedArticle[] = [];
  let beforeId: number | null = null;
  for (let page = 0; page < 5; page++) {
    const url = beforeId
      ? `https://t.me/s/${channel}?before=${beforeId}`
      : `https://t.me/s/${channel}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      });
      if (!res.ok) break;
      const html = await res.text();
      const posts = parseTelegramHTML(html, channel);
      if (!posts.length) break;
      all.push(...posts.filter(p => new Date(p.pubDate).getTime() > cutoffMs));
      const oldestMs = Math.min(...posts.map(p => new Date(p.pubDate).getTime()));
      if (oldestMs <= cutoffMs) break;
      const ids = posts.flatMap(p => { const m = p.link.match(/\/(\d+)$/); return m ? [parseInt(m[1], 10)] : []; });
      if (!ids.length) break;
      beforeId = Math.min(...ids);
    } catch { break; }
  }
  return all;
}

async function readDiskCache(): Promise<DiskCache | null> {
  try {
    const txt = await fs.readFile(DISK_CACHE_FILE, 'utf8');
    const d = JSON.parse(txt);
    return Array.isArray(d.raw) && typeof d.updatedAt === 'number' ? d as DiskCache : null;
  } catch { return null; }
}

async function writeDiskCache(raw: ParsedArticle[]): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DISK_CACHE_FILE, JSON.stringify({ raw, updatedAt: Date.now() }), 'utf8');
  } catch (e) {
    console.warn('[OSIRIS] news: disk cache write failed', e instanceof Error ? e.message : e);
  }
}

function parseRSSItems(xml: string, sourceName: string): ParsedArticle[] {
  const items: ParsedArticle[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const getTag = (tag: string) => {
      const m = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return (m?.[1] || m?.[2] || '').trim();
    };

    const title = decodeEntities(getTag('title').replace(/<[^>]+>/g, ''));
    const desc = decodeEntities(getTag('description').replace(/<[^>]+>/g, ''));
    
    items.push({
      title: title.length > 100 ? title.substring(0, 100) + '...' : title,
      description: desc,
      link: getTag('link'),
      pubDate: getTag('pubDate') || new Date().toISOString(),
      source: sourceName,
      hasVideo: false,
    });
  }
  return items;
}

async function buildNews(): Promise<unknown> {
  try {
    // --- Disk cache layer ---
    const disk = await readDiskCache();
    const now = Date.now();
    let rawArticles: ParsedArticle[];

    if (disk && now - disk.updatedAt < REFRESH_INTERVAL_MS) {
      // Cache is fresh — use it directly
      rawArticles = disk.raw.filter(a => new Date(a.pubDate).getTime() > now - DISK_HORIZON_MS);
      // Kick off a background refresh when cache is getting stale (> 45 min) so next request sees fresh data
      if (now - disk.updatedAt > 45 * 60 * 1000 && now - lastRefreshAt > REFRESH_INTERVAL_MS) {
        lastRefreshAt = now;
        (async () => {
          try {
            const cutoff = Date.now() - SCRAPE_WINDOW_MS;
            const fresh: ParsedArticle[] = (await Promise.allSettled(
              TELEGRAM_CHANNELS.map(ch => fetchChannelWithPagination(ch, cutoff))
            )).flatMap(r => r.status === 'fulfilled' ? r.value : []);
            const horizon = Date.now() - DISK_HORIZON_MS;
            const byLink = new Map<string, ParsedArticle>();
            for (const a of [...disk.raw, ...fresh]) {
              const key = a.link || `${a.source}:${a.pubDate}`;
              if (!byLink.has(key) && new Date(a.pubDate).getTime() > horizon) byLink.set(key, a);
            }
            await writeDiskCache(Array.from(byLink.values()));
          } catch { /* background — swallow */ }
        })();
      }
    } else {
      // Cache is missing or stale — full synchronous refresh
      lastRefreshAt = now;
      const cutoff = now - SCRAPE_WINDOW_MS;
      const fresh: ParsedArticle[] = (await Promise.allSettled(
        TELEGRAM_CHANNELS.map(ch => fetchChannelWithPagination(ch, cutoff))
      )).flatMap(r => r.status === 'fulfilled' ? r.value : []);
      const horizon = now - DISK_HORIZON_MS;
      const byLink = new Map<string, ParsedArticle>();
      const existing = disk?.raw ?? [];
      for (const a of [...existing, ...fresh]) {
        const key = a.link || `${a.source}:${a.pubDate}`;
        if (!byLink.has(key) && new Date(a.pubDate).getTime() > horizon) byLink.set(key, a);
      }
      rawArticles = Array.from(byLink.values());
      await writeDiskCache(rawArticles);
    }

    // Always fetch the curated RSS feeds in parallel — they are the source of
    // WORLD-tab articles. Previously these were only fetched when Telegram
    // completely failed, which meant the WORLD tab was always empty in normal
    // operation. We limit to 8 items per source to keep the feed balanced.
    const rssPromises = Object.entries(FALLBACK_FEEDS).map(async ([source, url]) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return [];
        const xml = await res.text();
        return parseRSSItems(xml, source).slice(0, 8);
      } catch { return []; }
    });
    const rssResults = await Promise.allSettled(rssPromises);
    const rssArticles: ParsedArticle[] = rssResults.flatMap(r => r.status === 'fulfilled' ? r.value : []);

    const allArticles: ParsedArticle[] = rawArticles;

    // FAILSAFE: If Telegram completely blocks the IP, add extra RSS items so
    // the feed is never fully empty.
    if (allArticles.length === 0) {
      allArticles.push(...rssArticles);
    }

    // Keep only war/conflict items from Telegram (bilingual). Drops channel ads,
    // promos, sport, weather, and other off-topic posts. RSS/world articles are
    // from curated news sources, so they pass through without the conflict filter
    // — they always show up in the WORLD tab.
    const rssSourceSet = new Set(rssArticles.map(a => a.source));
    const conflictArticles = [
      ...allArticles.filter(a => !rssSourceSet.has(a.source) && isConflict(`${a.title} ${a.description}`)),
      ...rssArticles,
    ];

    const newsItems = conflictArticles.map(article => {
      // Concatenate title + description so place names appearing only in the
      // headline are not missed when description is present.
      const searchText = `${article.title} ${article.description || ''}`;
      const riskScore = scoreRisk(searchText);
      const id = crypto.createHash('md5').update((article.link || '') + (article.pubDate || '')).digest('hex');
      const coords = findCoords(searchText);
      const allPlaces = findAllPlaces(searchText); // specific places only (no country centroids)
      const placed = coords ? jitterAround(coords, id) : null;
      // coords_default = true when there are no SPECIFIC place matches. A country/sea
      // centroid as the only match is too imprecise to use as a thermal fire candidate —
      // it just means "this story is about Russia/Ukraine" not "strike happened here".
      const coordsDefault = !coords || allPlaces.length === 0;

      return {
        id,
        title: article.title,
        description: article.description,
        link: article.link,
        published: article.pubDate,
        source: article.source,
        side: sideForSource(article.source, `${article.title ?? ''} ${article.description ?? ''}`),
        risk_score: riskScore,
        coords: placed,
        coords_default: coordsDefault,
        places: allPlaces.map(p => p.coords),
        place_names: allPlaces.map(p => p.name),
        hasVideo: article.hasVideo,
      };
    });

    newsItems.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());

    return { news: newsItems, total: newsItems.length, timestamp: new Date().toISOString() };
  } catch {
    return { news: [], error: 'Failed to fetch intel', total: 0, timestamp: new Date().toISOString() };
  }
}

export async function GET() {
  const now = Date.now();
  if (newsCache && now - newsCachedAt < CACHE_TTL_MS) {
    return NextResponse.json(newsCache, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } });
  }
  if (newsInflight) {
    const data = await newsInflight;
    return NextResponse.json(data, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } });
  }
  newsInflight = buildNews();
  try {
    const data = await newsInflight;
    newsCache = data;
    newsCachedAt = Date.now();
    return NextResponse.json(data, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } });
  } catch {
    return NextResponse.json({ news: [], error: 'Failed to fetch intel' }, { status: 500 });
  } finally {
    newsInflight = null;
  }
}
