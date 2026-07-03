import { NextResponse } from 'next/server';
import { getThreatCorpus, getStrikeReportCorpus, matchOblasts, type TgMessage } from '@/lib/telegram-threats';
import { promises as fs } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

// ── Hit history persistence ─────────────────────────────────────────────────
// Rolls a 48-hour log of fire-confirmed site hits to disk so analysts can
// see what burned overnight after the FIRMS 12-hour active-fire window expires.

const DATA_DIR = path.join(process.env.HOME ?? '/root', '.osiris-data');
const HITS_FILE = path.join(DATA_DIR, 'thermal-hits.json');
const THERMAL_RESPONSE_FILE = path.join(DATA_DIR, 'thermal-response.json');
const HITS_TTL_MS = 48 * 60 * 60 * 1000;

// ── Response cache + inflight coalescing ────────────────────────────────────
type ThermalResponse = { aois: unknown[]; counts: Record<string, number>; timestamp: string };
const THERMAL_TTL_MS = 60_000;
let cached: ThermalResponse | null = null;
let cachedAt = 0;
let inflight: Promise<ThermalResponse> | null = null;

// Seed in-memory cache from last persisted response so the layer renders
// immediately on cold start without waiting for a full pipeline re-run.
fs.mkdir(DATA_DIR, { recursive: true })
  .then(() => fs.readFile(THERMAL_RESPONSE_FILE, 'utf8'))
  .then((txt) => {
    const { response, savedAt } = JSON.parse(txt) as { response: ThermalResponse; savedAt: number };
    if (!cached && response?.aois) {
      cached = response;
      cachedAt = savedAt;
      console.log(`[OSIRIS] thermal-aoi: seeded ${response.aois.length} AOIs from disk (age ${Math.round((Date.now() - savedAt) / 1000)}s)`);
    }
  })
  .catch(() => { /* no prior snapshot — first request runs the full pipeline */ });

function persistThermalResponse(r: ThermalResponse) {
  fs.mkdir(DATA_DIR, { recursive: true })
    .then(() => fs.writeFile(THERMAL_RESPONSE_FILE, JSON.stringify({ response: r, savedAt: Date.now() })))
    .catch(() => { /* best-effort — losing this only costs one cold-start delay */ });
}

interface StoredHit {
  id: string; name: string; category: string;
  lat: number; lng: number;
  confidence: string; maxFrp: number; fireCount: number;
  latest: string | null; weapon?: string;
  ts: number; // epoch ms of first detection in this window
}

async function loadStoredHits(): Promise<StoredHit[]> {
  try {
    return JSON.parse(await fs.readFile(HITS_FILE, 'utf8')) as StoredHit[];
  } catch { return []; }
}

async function mergeAndSaveHits(incoming: StoredHit[]): Promise<StoredHit[]> {
  if (!incoming.length) return await loadStoredHits();
  const cutoff = Date.now() - HITS_TTL_MS;
  const existing = (await loadStoredHits()).filter(h => h.ts > cutoff);
  const byId = new Map(existing.map(h => [h.id, h]));
  for (const hit of incoming) byId.set(hit.id, hit);
  const merged = [...byId.values()];
  try { await fs.writeFile(HITS_FILE, JSON.stringify(merged)); } catch { /* ignore */ }
  return merged;
}

/**
 * OSIRIS — Strategic Thermal AOIs.
 *
 * Cross-references NASA FIRMS active-fire detections (keyless 24h global CSV,
 * same source as /api/fires) against points of interest, surfacing fires that
 * coincide with something we care about — a possible strike/incident signal:
 *   1. Curated RU strategic AIRFIELDS (strategic-aviation + frontline-relevant).
 *   2. RU / occupied RAIL & LOGISTICS hubs.
 *   3. OIL DEPOTS / REFINERIES (frequent strike targets).
 *   4. Locations NAMED IN NEWS (geolocated by /api/news), corroborated by a fire.
 *
 * Sites are always returned (monitored markers, `hit` flips true when a fire is
 * within range); news entries are returned ONLY when a fire corroborates them.
 * This is a heuristic — a thermal hit is not proof of a strike (wildfires, flares,
 * industrial heat all trip FIRMS). Treat as a lead, verify before acting.
 */

type Category = 'airfield' | 'rail' | 'logistics' | 'oil' | 'naval' | 'power' | 'ammo' | 'news';
interface Site { id: string; name: string; category: Exclude<Category, 'news'>; lat: number; lng: number; }

// Theater bounding box — western RU + Ukraine + occupied + Crimea + Kola (Olenya).
const BBOX = { latMin: 43, latMax: 71, lngMin: 19, lngMax: 66 };
const SITE_RADIUS_KM = 12;   // airfields/yards sprawl; be inclusive
const NEWS_RADIUS_KM = 15;   // news coords are city-level (and jittered)
// Low-FRP fires below this threshold are suppressed unless a news article or
// Telegram strike message corroborates the detection within the site radius.
// Agriculture burns and industrial flares rarely exceed 50 MW; a struck
// refinery or ammo depot burns significantly hotter.
const NEWS_GATE_FRP_MW = 50;
const FIRE_ACTIVE_MS = 12 * 60 * 60 * 1000;  // fires older than 12h don't sustain a "hit"

const SITES: Site[] = [
  // ── Strategic / frontline airfields ──
  { id: 'af-engels', name: 'Engels-2 (bomber base)', category: 'airfield', lat: 51.48, lng: 46.19 },
  { id: 'af-dyagilevo', name: 'Dyagilevo (Ryazan)', category: 'airfield', lat: 54.64, lng: 39.57 },
  { id: 'af-morozovsk', name: 'Morozovsk', category: 'airfield', lat: 48.31, lng: 41.79 },
  { id: 'af-millerovo', name: 'Millerovo', category: 'airfield', lat: 48.95, lng: 40.30 },
  { id: 'af-yeysk', name: 'Yeysk', category: 'airfield', lat: 46.68, lng: 38.21 },
  { id: 'af-primorsko', name: 'Primorsko-Akhtarsk', category: 'airfield', lat: 46.05, lng: 38.15 },
  { id: 'af-akhtubinsk', name: 'Akhtubinsk', category: 'airfield', lat: 48.18, lng: 46.27 },
  { id: 'af-olenya', name: 'Olenya (Murmansk)', category: 'airfield', lat: 68.15, lng: 33.46 },
  { id: 'af-saky', name: 'Saky (Crimea)', category: 'airfield', lat: 45.09, lng: 33.60 },
  { id: 'af-belbek', name: 'Belbek (Sevastopol)', category: 'airfield', lat: 44.69, lng: 33.57 },
  { id: 'af-taganrog', name: 'Taganrog', category: 'airfield', lat: 47.20, lng: 38.85 },
  { id: 'af-kursk', name: 'Kursk-Vostochny', category: 'airfield', lat: 51.75, lng: 36.30 },
  { id: 'af-berdyansk', name: 'Berdyansk (occupied)', category: 'airfield', lat: 46.82, lng: 36.75 },
  { id: 'af-shaykovka', name: 'Shaykovka (Tu-22M3 base, Kaluga)', category: 'airfield', lat: 54.23, lng: 34.37 },
  { id: 'af-pskov', name: 'Pskov/Kresty (Il-76 transport base)', category: 'airfield', lat: 57.78, lng: 28.40 },
  { id: 'af-marinovka', name: 'Marinovka (Su-34/Su-24 base, Volgograd)', category: 'airfield', lat: 48.64, lng: 43.79 },
  { id: 'af-lipetsk', name: 'Lipetsk-2 (Su-27/Su-30 combat training)', category: 'airfield', lat: 52.63, lng: 39.44 },
  { id: 'af-kazan-kapo', name: 'Kazan KAPO (Tu-160/Tu-22M3 production & repair)', category: 'airfield', lat: 55.86, lng: 49.12 },
  { id: 'af-seshcha', name: 'Seshcha (An-124 heavy-lift transport, Bryansk)', category: 'airfield', lat: 53.72, lng: 33.34 },
  // ── Rail hubs / marshalling yards ──
  { id: 'rl-rostov', name: 'Rostov-on-Don (rail hub)', category: 'rail', lat: 47.24, lng: 39.71 },
  { id: 'rl-bataysk', name: 'Bataysk marshalling yard', category: 'rail', lat: 47.14, lng: 39.75 },
  { id: 'rl-likhaya', name: 'Likhaya junction', category: 'rail', lat: 48.12, lng: 40.18 },
  { id: 'rl-voronezh', name: 'Voronezh (rail)', category: 'rail', lat: 51.66, lng: 39.20 },
  { id: 'rl-bryansk', name: 'Bryansk (rail)', category: 'rail', lat: 53.24, lng: 34.36 },
  { id: 'rl-tikhoretsk', name: 'Tikhoretsk junction', category: 'rail', lat: 45.86, lng: 40.13 },
  { id: 'rl-dzhankoi', name: 'Dzhankoi rail hub (Crimea)', category: 'rail', lat: 45.71, lng: 34.39 },
  { id: 'rl-armyansk', name: 'Armyansk (Crimea N. rail)', category: 'rail', lat: 46.11, lng: 33.69 },
  // ── Occupied logistics nodes ──
  { id: 'lg-melitopol', name: 'Melitopol (logistics hub)', category: 'logistics', lat: 46.84, lng: 35.37 },
  { id: 'lg-tokmak', name: 'Tokmak (occupied)', category: 'logistics', lat: 47.25, lng: 35.71 },
  { id: 'lg-volnovakha', name: 'Volnovakha (rail/logistics)', category: 'logistics', lat: 47.60, lng: 37.50 },
  { id: 'lg-mariupol', name: 'Mariupol (port/rail)', category: 'logistics', lat: 47.10, lng: 37.55 },
  { id: 'lg-belgorod', name: 'Belgorod (staging)', category: 'logistics', lat: 50.60, lng: 36.59 },
  // ── Oil depots / refineries (frequent strike targets) ──
  { id: 'oil-novorossiysk', name: 'Novorossiysk (Sheskharis oil terminal)', category: 'oil', lat: 44.70, lng: 37.80 },
  { id: 'oil-tuapse', name: 'Tuapse refinery', category: 'oil', lat: 44.10, lng: 39.08 },
  { id: 'oil-ustluga', name: 'Ust-Luga oil terminal (Baltic)', category: 'oil', lat: 59.67, lng: 28.27 },
  { id: 'oil-ryazan', name: 'Ryazan refinery', category: 'oil', lat: 54.61, lng: 39.69 },
  { id: 'oil-volgograd', name: 'Volgograd (Lukoil) refinery', category: 'oil', lat: 48.62, lng: 44.42 },
  { id: 'oil-novoshakhtinsk', name: 'Novoshakhtinsk refinery', category: 'oil', lat: 47.78, lng: 39.93 },
  { id: 'oil-gukovo', name: 'Гуково oil depot / нафтобаза (Rostov oblast)', category: 'oil', lat: 48.05, lng: 39.94 },
  { id: 'oil-slavyansk', name: 'Slavyansk-na-Kubani refinery', category: 'oil', lat: 45.26, lng: 38.13 },
  // Poltavskaya stanitsa oil depot (Krasnodar Krai) — Lukoil distribution hub between
  // refineries and regional AZS networks. Use stems (полтавськ, нафтобаз) so keyword
  // matching covers inflected Ukrainian forms (полтавській, нафтобазі).
  { id: 'oil-poltavskaya', name: 'Poltavskaya / полтавськ нафтобаз oil depot (Krasnodar/Kuban, Lukoil hub)', category: 'oil', lat: 45.33, lng: 38.17 },
  { id: 'oil-ilsky', name: 'Ilsky refinery', category: 'oil', lat: 44.84, lng: 38.58 },
  { id: 'oil-afipsky', name: 'Afipsky refinery', category: 'oil', lat: 44.90, lng: 38.84 },
  { id: 'oil-krasnodar', name: 'Krasnodar refinery', category: 'oil', lat: 45.07, lng: 39.03 },
  { id: 'oil-saratov', name: 'Saratov refinery', category: 'oil', lat: 51.50, lng: 46.10 },
  { id: 'oil-syzran', name: 'Syzran refinery', category: 'oil', lat: 53.16, lng: 48.47 },
  { id: 'oil-kstovo', name: 'Kstovo refinery (Nizhny Novgorod)', category: 'oil', lat: 56.15, lng: 44.20 },
  { id: 'oil-feodosia', name: 'Feodosia oil terminal (Crimea)', category: 'oil', lat: 45.04, lng: 35.38 },
  // ── Naval ports (occupied + Baltic) ──
  { id: 'naval-kronstadt', name: 'Kronstadt naval base (Baltic)', category: 'naval', lat: 59.99, lng: 29.76 },
  { id: 'naval-berdyansk', name: 'Berdyansk port (occupied)', category: 'naval', lat: 46.75, lng: 36.80 },
  { id: 'naval-mariupol', name: 'Mariupol port (occupied)', category: 'naval', lat: 47.10, lng: 37.57 },
  { id: 'naval-novorossiysk', name: 'Novorossiysk naval base (Black Sea Fleet HQ)', category: 'naval', lat: 44.72, lng: 37.83 },
  { id: 'naval-kerch-zaliv', name: 'Zaliv shipyard Kerch (corvette construction, Crimea)', category: 'naval', lat: 45.26, lng: 36.42 },
  // ── Power infrastructure ──
  { id: 'pwr-zugres', name: 'Zuivska TPS — Zugres (Donetsk)', category: 'power', lat: 48.01, lng: 38.51 },
  { id: 'pwr-simferopol-tes', name: 'Simferopol TES (Crimea CHP)', category: 'power', lat: 44.98, lng: 34.07 },
  // ── Oil storage (bilateral-confirmed strikes) ──
  { id: 'oil-ust-labinsk', name: 'Ust-Labinsk oil depot (Kuban)', category: 'oil', lat: 45.22, lng: 39.71 },
  { id: 'oil-semykolod', name: 'Semykolodiaznaya oil depot (Crimea)', category: 'oil', lat: 45.20, lng: 33.78 },
  // ── Ammunition / arsenal ──
  { id: 'ammo-leningrad-arsenal', name: 'Leningrad Oblast naval arsenal', category: 'ammo', lat: 59.90, lng: 29.60 },
  { id: 'ammo-tambov', name: 'Tambov gunpowder plant / Kotovsk (propellant, artillery powder)', category: 'ammo', lat: 52.58, lng: 41.52 },
  { id: 'ammo-bryansk-chem', name: 'Bryansk Chemical Plant / Seltso (rocket propellant, phosphorous)', category: 'ammo', lat: 53.37, lng: 34.10 },
  // ── Defense-industrial (direct strike targets, June 2026) ──
  { id: 'ind-arsenal-spb', name: 'Arsenal defense plant (St. Petersburg)', category: 'ammo', lat: 59.96, lng: 30.37 },
  { id: 'ind-vniir-cheboksary', name: 'VNIIR-Progress (Cheboksary — drives/hydraulics for artillery/Iskander)', category: 'ammo', lat: 56.14, lng: 47.22 },
  { id: 'ind-alabuga', name: 'Alabuga SEZ / Yelabuga (Shahed/Geran-2 drone factory, Tatarstan)', category: 'ammo', lat: 55.84, lng: 52.05 },
  { id: 'ind-kupol-izhevsk', name: 'Kupol plant Izhevsk (Tor SAM + Garpia-A1 drone production)', category: 'ammo', lat: 56.84, lng: 53.18 },
  // ── Oil / energy (new or previously unnamed targets) ──
  { id: 'oil-kuibyshev-samara', name: 'Kuibyshev refinery (Samara, Rosneft)', category: 'oil', lat: 53.21, lng: 50.15 },
  { id: 'oil-nps-vtoroye', name: 'NPS Vtoroye — Transneft pipeline (Vladimir Oblast)', category: 'oil', lat: 56.40, lng: 41.85 },
  { id: 'oil-kizlyurt-gas', name: 'Gas infrastructure (Kizlyurt, Dagestan)', category: 'oil', lat: 43.21, lng: 46.87 },
  { id: 'oil-yaroslavl', name: 'Slavneft-YANOS refinery (Yaroslavl, 15M t/yr)', category: 'oil', lat: 57.55, lng: 39.81 },
  { id: 'oil-kapotnya', name: 'Kapotnya Moscow NPZ / Московський НПЗ / Московский НПЗ (40% of region fuel)', category: 'oil', lat: 55.64, lng: 37.80 },
  { id: 'oil-ufa', name: 'Bashneft-UNPZ / Novoil refinery complex (Ufa, Bashkortostan)', category: 'oil', lat: 54.86, lng: 56.09 },
  // ── Petrochemical / military-industrial (struck June 2026) ──
  { id: 'ind-tolyattikauchuk', name: 'Tolyattikauchuk (Samara Oblast — synthetic rubber for armour/aviation)', category: 'oil', lat: 53.50, lng: 49.38 },
  { id: 'ind-nizhnekamskneftekhim', name: 'Nizhnekamskneftekhim (Tatarstan — polymers/rubber for VPK)', category: 'oil', lat: 55.64, lng: 51.55 },
  // ── Nizhnekamsk refinery complex (struck June 2026, confirmed by UA General Staff) ──
  { id: 'oil-taneco-nizhnekamsk', name: 'TANECO refinery (Nizhnekamsk, Tatarstan — 15M t/yr, TAIF Group)', category: 'oil', lat: 55.77, lng: 51.88 },
  { id: 'oil-taifnk-nizhnekamsk', name: 'TAIF-NK refinery (Nizhnekamsk, Tatarstan — naphtha/fuel oil)', category: 'oil', lat: 55.64, lng: 51.82 },
];

interface Fire { lat: number; lng: number; frp: number; brightness: number; date: string; time: string; ts: number; }
interface NewsItem { title?: string; description?: string; source?: string; side?: string; link?: string; coords?: [number, number] | null; coords_default?: boolean; places?: [number, number][]; place_names?: string[]; hasVideo?: boolean; }

// Equirectangular distance (km) — accurate enough at this scale, cheap in a hot loop.
function distKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = aLat - bLat;
  const dLng = (aLng - bLng) * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) * 111.32;
}

// FIRMS area API bbox: W,S,E,N (matches BBOX constant above)
const FIRMS_BBOX = `${BBOX.lngMin},${BBOX.latMin},${BBOX.lngMax},${BBOX.latMax}`;

// All satellite sources fetched in parallel — not first-success fallbacks.
// With key: area-API URLs (~50 KB each, 2-day window).
// Without key: full 24h global CSVs (~15–20 MB each, same CSV schema).
// NOAA-20 and NOAA-21 orbit ~50 min apart from Suomi-NPP, giving coverage
// at different times of day and doubling the chance of catching a fresh fire.
function firmsSources(): string[] {
  const key = process.env.FIRMS_MAP_KEY;
  if (key) {
    return [
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/${FIRMS_BBOX}/2`,
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_NOAA20_NRT/${FIRMS_BBOX}/2`,
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_NOAA21_NRT/${FIRMS_BBOX}/2`,
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/MODIS_NRT/${FIRMS_BBOX}/2`,
    ];
  }
  return [
    'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv',
    'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv',
    'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv',
    'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv',
  ];
}

// Parse a FIRMS CSV text (any satellite — schema is identical across VIIRS/MODIS/NRT).
function parseFirmsCsv(text: string): Fire[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2 || !lines[0].includes('latitude')) return [];
  const h = lines[0].split(',');
  const li = h.indexOf('latitude'), gi = h.indexOf('longitude');
  const bi = h.indexOf('bright_ti4') !== -1 ? h.indexOf('bright_ti4') : h.indexOf('brightness');
  const di = h.indexOf('acq_date'), ti = h.indexOf('acq_time'), fi = h.indexOf('frp');
  const fires: Fire[] = [];
  for (let i = 1; i < lines.length && fires.length < 8000; i++) {
    const c = lines[i].split(',');
    const lat = parseFloat(c[li]), lng = parseFloat(c[gi]);
    if (isNaN(lat) || isNaN(lng)) continue;
    if (lat < BBOX.latMin || lat > BBOX.latMax || lng < BBOX.lngMin || lng > BBOX.lngMax) continue;
    const acqTime = (c[ti] || '0000').padStart(4, '0');
    const ts = new Date(`${c[di]}T${acqTime.slice(0, 2)}:${acqTime.slice(2, 4)}:00Z`).getTime();
    fires.push({ lat, lng, frp: parseFloat(c[fi]) || 0, brightness: parseFloat(c[bi]) || 0, date: c[di] || '', time: c[ti] || '', ts: isNaN(ts) ? Date.now() : ts });
  }
  return fires;
}

async function fetchOneFirmsSource(url: string): Promise<Fire[]> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'OSIRIS-Intelligence-Platform/3.5' } });
    if (!res.ok) return [];
    return parseFirmsCsv(await res.text());
  } catch { return []; }
}

// LSA-SAF FRP from Meteosat SEVIRI — 15-minute geostationary coverage of
// Europe + western Russia. Requires free EUMETSAT account:
//   register at https://eoportal.eumetsat.int → API → Consumer Key/Secret
// Set EUMETSAT_CONSUMER_KEY + EUMETSAT_CONSUMER_SECRET to enable.
// Returns [] gracefully when credentials are absent.
async function fetchLsaSafFires(): Promise<Fire[]> {
  const ck = process.env.EUMETSAT_CONSUMER_KEY;
  const cs = process.env.EUMETSAT_CONSUMER_SECRET;
  if (!ck || !cs) return [];
  try {
    // Step 1: OAuth2 client-credentials token
    const tokenRes = await fetch('https://api.eumetsat.int/token', {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(ck)}&client_secret=${encodeURIComponent(cs)}`,
    });
    if (!tokenRes.ok) return [];
    const { access_token } = await tokenRes.json() as { access_token: string };

    // Step 2: Fetch latest FRP-PIXEL product (MSG Meteosat SEVIRI, ~15-min cadence).
    // Product collection: EO:EUM:DAT:MSG:FRP-PIXEL-IF
    const searchRes = await fetch(
      'https://api.eumetsat.int/data/search-products/1.0.0/datasets/EO:EUM:DAT:MSG:FRP-PIXEL-IF/temporal/latest?limit=1&format=json',
      { signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${access_token}` } },
    );
    if (!searchRes.ok) return [];
    const search = await searchRes.json() as any;
    const productUrl = search?.products?.[0]?.links?.data?.[0]?.href;
    if (!productUrl) return [];

    // Step 3: Download the CSV hotspot extract (EUMETSAT provides a CSV alongside HDF5)
    const dataRes = await fetch(productUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!dataRes.ok) return [];
    const text = await dataRes.text();
    // LSA-SAF CSV columns: latitude,longitude,frp,date_time (ISO8601) — map to Fire schema
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const h = lines[0].split(',').map(c => c.trim().toLowerCase());
    const li = h.indexOf('latitude'), gi = h.indexOf('longitude'), fi = h.indexOf('frp'), dti = h.indexOf('date_time');
    if (li < 0 || gi < 0) return [];
    const fires: Fire[] = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      const lat = parseFloat(c[li]), lng = parseFloat(c[gi]);
      if (isNaN(lat) || isNaN(lng)) continue;
      if (lat < BBOX.latMin || lat > BBOX.latMax || lng < BBOX.lngMin || lng > BBOX.lngMax) continue;
      const ts = dti >= 0 ? new Date(c[dti].trim()).getTime() : Date.now();
      const d = dti >= 0 ? c[dti].slice(0, 10) : '';
      fires.push({ lat, lng, frp: parseFloat(c[fi]) || 0, brightness: 0, date: d, time: '', ts: isNaN(ts) ? Date.now() : ts });
    }
    return fires;
  } catch { return []; }
}

// Merge fires from multiple satellite passes. Two satellites can detect the same
// ignition: deduplicate within 1.5 km + 4 h window, keeping the highest FRP and
// the freshest acquisition timestamp.
function mergeFires(batches: Fire[][]): Fire[] {
  // Grid-based spatial dedup: 0.015° lat cell ≈ 1.67 km covers the 1.5 km dedup radius.
  // Longitude step is cosine-corrected so the cell stays ~1.5 km at all latitudes —
  // without this, 0.015° lng ≈ 60 km at 55°N (cos(55°) ≈ 0.57), making the dedup
  // window ~4× too wide in the east-west direction at high latitudes.
  const LAT_STEP = 0.015;
  const FOUR_H_MS = 4 * 60 * 60 * 1000;
  const grid = new Map<string, Fire>();
  const result: Fire[] = [];

  for (const fire of batches.flat()) {
    const cosLat = Math.cos(fire.lat * Math.PI / 180);
    const lngStep = cosLat > 0.01 ? LAT_STEP / cosLat : LAT_STEP;
    const cLat = Math.round(fire.lat / LAT_STEP);
    const cLng = Math.round(fire.lng / lngStep);
    let dup: Fire | undefined;
    outer: for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLng = -1; dLng <= 1; dLng++) {
        const candidate = grid.get(`${cLat + dLat},${cLng + dLng}`);
        if (candidate &&
            distKm(fire.lat, fire.lng, candidate.lat, candidate.lng) < 1.5 &&
            Math.abs(fire.ts - candidate.ts) < FOUR_H_MS) {
          dup = candidate; break outer;
        }
      }
    }
    if (dup) {
      if (fire.frp > dup.frp) { dup.frp = fire.frp; dup.brightness = Math.max(dup.brightness, fire.brightness); }
      if (fire.ts > dup.ts) { dup.ts = fire.ts; dup.date = fire.date; dup.time = fire.time; }
    } else {
      const rep = { ...fire };
      result.push(rep);
      grid.set(`${cLat},${cLng}`, rep);
    }
  }
  return result;
}

async function fetchTheaterFires(): Promise<Fire[]> {
  const [firmsBatches, lsaSafFires] = await Promise.all([
    Promise.allSettled(firmsSources().map(fetchOneFirmsSource)),
    fetchLsaSafFires(),
  ]);
  const batches = firmsBatches
    .filter((r): r is PromiseFulfilledResult<Fire[]> => r.status === 'fulfilled')
    .map(r => r.value);
  if (lsaSafFires.length) batches.push(lsaSafFires);

  const cutoff = Date.now() - FIRE_ACTIVE_MS;
  return mergeFires(batches).filter(f => f.ts >= cutoff);
}

async function fetchNews(req: Request): Promise<NewsItem[]> {
  try {
    const res = await fetch(new URL('/api/news', req.url), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const d = await res.json();
    return Array.isArray(d.news) ? d.news : [];
  } catch { return []; }
}

// A news→fire match only counts as a thermal lead when the article is actually about a
// strike/fire/explosion — the main false-positive filter (a sports story geolocated near
// a wildfire shouldn't read as a strike). Multilingual EN/UA/RU stems.
const STRIKE_TERMS = [
  'strike', 'struck', 'explos', 'blast', 'drone', 'missile', 'shahed', 'uav', 'destroyed',
  'burn', 'ablaze', 'depot', 'refiner', 'ammunition', 'shelling', 'detonat', 'підрив',
  'shipyard', 'naval base', 'naval facilit', 'arsenal', 'power station', 'power plant', 'oil terminal',
  'удар', 'вибух', 'дрон', 'ракет', 'шахед', 'бпла', 'знищ', 'пожеж', 'горить', 'склад',
  'нпз', 'нафтоба', 'нафтосховищ', 'обстріл', 'влучан', 'детонац', 'приліт', 'прилетіло',
  'теплоелектростанц', 'електростанц', 'арсенал', 'атаковано', 'підпален',
  'взрыв', 'уничтож', 'пожар', 'горит', 'нефтеба', 'обстрел', 'прилет',
  'корвет', 'фрегат', 'корабл', 'верф', 'атакован',
  'теплоэлектростанц', 'электростанц',
  'хлопк',  // Russian informal "bang" — euphemism used by RU state/milblogs for explosions
];

const DIGEST_TITLE_RE = /^(главное за|сводка|зведення|дайджест|итоги дня|підсумки|обзор за|за сутки|за добу|вчора та у ніч|вчора і в ніч|за минулу добу|за минулу ніч|morning brief|evening brief|daily (round|update|brief|wrap))/i;
const HISTORICAL_YEAR_RE = /\b(201[4-9]|202[0-4])\b/;

function isStrikeRelated(item: NewsItem): boolean {
  const title = (item.title || '').toLowerCase();
  if (DIGEST_TITLE_RE.test(title)) return false;
  if (HISTORICAL_YEAR_RE.test(title)) return false;
  const t = `${title} ${(item.description || '').toLowerCase()}`;
  return STRIKE_TERMS.some(w => t.includes(w));
}

// Territorial-control / capture-advance reports ("Russia liberated X", "took
// control of Y") sit in ambient front-line FIRMS heat AND carry combat verbs, so
// they slip past isStrikeRelated as false positives — yet they are NOT strikes on
// strategic targets. Exclude them. PRECISE capture/liberation/control-change stems
// only: deliberately omit bare "occupied"/"наступ" (the latter collides with
// "наступний"/next — see ARCHITECTURE.md) so genuine strike reports ("...depot in
// the occupied Donetsk region") are NOT dropped.
const ADVANCE_TERMS = [
  'liberat', 'recaptur', 'took control', 'under control', 'gained control', 'overran',
  'overrun', 'fallen to', 'fell to', 'seized by', 'stormed',
  'освобод', 'под контроль', 'захват', 'продвин', 'штурм', 'прорвали', 'наступают',
  'звільн', 'під контроль', 'захопл', 'просун',
  'встановив контрол', 'встановлено контрол', 'зайняли', 'зайняв', 'штурмують',
  'відійшли', 'залишили', 'ворог увійшов',
];
function isTerritorialAdvance(item: NewsItem): boolean {
  const t = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  return ADVANCE_TERMS.some(w => t.includes(w));
}

// Air-defense / interception reports ("326 UAVs shot down by ПВО") pass
// isStrikeRelated because they contain drone/UAV terms, yet they report a
// DEFENSIVE interception, not a ground impact on a strategic target. Exclude
// them UNLESS the article also contains ground-impact evidence (explosion, fire,
// hit, damage) that suggests at least one munition got through.
const INTERCEPT_STEMS = [
  'shot down', 'were shot', 'intercept', 'downed', 'knocked down',
  'дежурными средствами', 'средствами пво',
  'збили', 'знищили засоба', 'перехват', 'перехоплен',
  'сбит', 'сбиты', 'сбито', 'сбили', 'збит', 'збиті', 'збито',
];
const GROUND_IMPACT_STEMS = [
  'вибух', 'взрыв', 'пожеж', 'пожар', 'горит', 'горить',
  'приліт', 'прилет', 'влучан', 'детонац', 'хлопк',
  'explos', 'blast', 'ablaze', 'burn', 'detonat', 'impact', 'hit',
];
function isInterceptionOnly(item: NewsItem): boolean {
  const t = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  if (!INTERCEPT_STEMS.some(w => t.includes(w))) return false;
  return !GROUND_IMPACT_STEMS.some(w => t.includes(w));
}


// For unconfirmed (no-fire) markers, the article must name a specific infrastructure
// type — not just mention drones/missiles in passing. This filters civilian-incident
// articles and military-exhibition pieces (e.g. "FPV drones at Patriot Park") from
// generating unverified markers without any satellite corroboration.
const STRATEGIC_TARGET_TERMS = [
  // EN
  'refinery', 'oil depot', 'fuel depot', 'ammo depot', 'ammunition depot', 'arms depot',
  'arsenal', 'airfield', 'airbase', 'air base', 'naval facilit', 'shipyard',
  'oil terminal', 'fuel terminal', 'power plant', 'power station', 'substation',
  'marshalling yard', 'rail yard', 'rail hub', 'pipeline', 'storage facility',
  // UA
  'нпз', 'нафтоба', 'нафтосховищ', 'нафтопереробн', 'паливн',
  'аеродром', 'авіабаза', 'авіазавод', 'залізничн вузол', 'сортувальн',
  'електростанц', 'теплоелектростанц', 'підстанц', 'трансформаторн',
  'склад боєприпасів', 'арсенал', 'сховищ пально', 'нафтопровід',
  // RU
  'нефтеба', 'нефтехран', 'нефтезавод',
  'аэродром', 'авиабаза', 'судоремонтн', 'верфь', 'судостроит',
  'сортировочн', 'электростанц', 'теплоэлектростанц', 'подстанц',
  'склад боеприпасов', 'нефтепровод', 'хранилищ топлив',
];
function hasStrategicTarget(item: NewsItem): boolean {
  const t = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  return STRATEGIC_TARGET_TERMS.some(w => t.includes(w));
}

// Weapon type inferred from article text. Priority: specific systems → generic class.
// Returns a short display label or null when nothing matches.
const WEAPON_PATTERNS: [string, string[]][] = [
  ['SHAHED', ['shahed', 'шахед', 'geranium', 'герань', 'lancet', 'ланцет', 'fpv', 'фпв', 'бпла', 'uav', 'drone', 'дрон']],
  ['MISSILE', ['kalibr', 'калибр', 'калібр', 'iskander', 'іскандер', 'искандер', 'kh-10', 'х-10', 'kinzhal', 'кинжал', 'neptune', 'нептун', 'storm shadow', 'scalp', 'atacms', 'cruise missile', 'балістичн', 'ballistic', 'missile', 'ракет']],
  ['GLIDE BOMB', ['kab', 'fab-', 'фаб-', 'glide bomb']],
  ['ARTILLERY', ['обстріл', 'обстрел', 'shelling', 'артилер', 'артиллер', 'снаряд']],
];
function detectWeapon(text: string): string | null {
  const t = text.toLowerCase();
  for (const [label, terms] of WEAPON_PATTERNS) {
    if (terms.some(w => t.includes(w))) return label;
  }
  return null;
}

// Confidence from fire intensity + count. FRP (fire radiative power, MW) is the best single
// discriminator: a struck depot/refinery burns hot (high FRP); a faint farm hotspot is low.
// 'news' = no fire detected — shows as an unverified dim marker (no glow).
function confidenceOf(fireCount: number, maxFrp: number): 'low' | 'med' | 'high' {
  if (maxFrp >= 20 || fireCount >= 4) return 'high';
  if (maxFrp >= 5 || fireCount >= 2) return 'med';
  return 'low';
}
type Confidence = 'low' | 'med' | 'high' | 'news';

// Fires within `radiusKm` of (lat,lng) → aggregate hit stats.
function fireHit(fires: Fire[], lat: number, lng: number, radiusKm: number) {
  let count = 0, maxFrp = 0, latest = '';
  for (const f of fires) {
    if (distKm(lat, lng, f.lat, f.lng) <= radiusKm) {
      count++;
      if (f.frp > maxFrp) maxFrp = f.frp;
      const stamp = `${f.date} ${f.time}`;
      if (stamp > latest) latest = stamp;
    }
  }
  return count > 0 ? { count, maxFrp: Math.round(maxFrp * 10) / 10, latest: latest.trim() } : null;
}

// Generic words to strip when extracting site-name keywords for Telegram matching.
// Only location-specific words (city/river/person names) are used for matching.
const GENERIC_SITE_WORDS = new Set([
  'base', 'hub', 'yard', 'rail', 'naval', 'terminal', 'refinery', 'depot',
  'logistics', 'facility', 'junction', 'station', 'plant', 'occupied',
  'marshalling', 'airfield', 'bomber', 'transport', 'combat', 'training',
  'production', 'repair', 'heavy', 'strategic', 'airbase',
]);

function siteKeywords(name: string): string[] {
  return name
    .replace(/\(.*?\)/g, '')
    .split(/[\s,\/\-]+/)
    .map(w => w.toLowerCase().trim())
    .filter(w => w.length > 3 && !GENERIC_SITE_WORDS.has(w));
}

// Convert a TgMessage to a NewsItem for the existing news pipeline.
// Uses oblast matching for coordinates — oblast centroid level, deduplicated by cell.
// Returns null when no oblast can be inferred (message stays useful for site augmentation only).
function tgToNewsItem(msg: TgMessage): NewsItem | null {
  const oblasts = matchOblasts(msg.text);
  if (!oblasts.length) return null;
  const places: [number, number][] = oblasts.map(o => [o.coords[1], o.coords[0]]); // [lat, lng]
  return {
    title: msg.text.slice(0, 120).replace(/\n/g, ' '),
    description: msg.text,
    source: `t.me/${msg.channel}`,
    side: 'ua',
    coords: places[0],
    coords_default: false,
    places: places.length > 1 ? places : undefined,
    hasVideo: false,
  };
}

// Score a sentence by how informative it is about a strike on a strategic target.
function scoreSentence(s: string): number {
  const lower = s.toLowerCase();
  let score = 0;
  if (STRATEGIC_TARGET_TERMS.some(w => lower.includes(w))) score += 4;
  if (STRIKE_TERMS.some(w => lower.includes(w))) score += 2;
  for (const [, terms] of WEAPON_PATTERNS) {
    if (terms.some(w => lower.includes(w))) { score += 2; break; }
  }
  return score;
}

// Extract the most informative sentence from a Telegram post about a strike.
// When `placeName` is provided (the gazetteer keyword that matched this coord),
// prefer sentences that mention that place — so a Belgorod-coord marker shows
// the sentence about Belgorod, not the Kuibyshev-refinery sentence from the
// same multi-location article.
function extractBestSnippet(title: string, desc: string, placeName?: string): string {
  const sentences = `${title}\n${desc}`.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 12);
  let best = title.slice(0, 140);
  let bestScore = -1;
  const nameLower = placeName?.toLowerCase();
  for (const s of sentences) {
    const lower = s.toLowerCase();
    let score = scoreSentence(s);
    // Strongly prefer sentences that mention this specific place.
    if (nameLower && lower.includes(nameLower)) score += 6;
    if (score > bestScore) { bestScore = score; best = s.slice(0, 140); }
  }
  return best;
}

async function computeThermal(req: Request): Promise<ThermalResponse> {
  try {
    const [fires, news, tgCorpus, tgReportCorpus] = await Promise.all([
      fetchTheaterFires(),
      fetchNews(req),
      getThreatCorpus(),
      getStrikeReportCorpus(),
    ]);
    // Merge threat corpus + strike-report corpus before filtering.
    // tgReportCorpus comes from STRIKE_REPORT_CHANNELS (e.g. ssternenko) —
    // after-action summaries kept out of drone/missile route builders.
    const tgCorpusMerged: TgMessage[] = [...tgCorpus, ...tgReportCorpus];

    // Pre-filter Telegram corpus: keep only strike-related messages that are not
    // territorial-advance or interception-only reports (same gates as RSS news).
    const tgStrike = tgCorpusMerged.filter(msg => {
      const fake: NewsItem = { title: msg.text.slice(0, 120), description: msg.text };
      return isStrikeRelated(fake) && !isTerritorialAdvance(fake) && !isInterceptionOnly(fake);
    });

    const aois = [];

    // Sites: always emitted; `hit` flips when a fire is within range.
    // Telegram strike messages are matched against site keywords and surfaced as
    // additional sources in the popup — adding fast-twitch Telegram intel to site markers.
    for (const s of SITES) {
      const h = fireHit(fires, s.lat, s.lng, SITE_RADIUS_KM);
      const keywords = siteKeywords(s.name);
      const tgSources = keywords.length > 0
        ? tgStrike
            .filter(msg => keywords.some(k => msg.text.toLowerCase().includes(k)))
            .slice(0, 4)
            .map(msg => ({
              source: `t.me/${msg.channel}`,
              side: 'ua',
              title: msg.text.slice(0, 120).replace(/\n/g, ' '),
              snippet: msg.text.slice(0, 200).replace(/\n/g, ' '),
            }))
        : [];

      const tgText = tgSources.map(s => s.snippet).join(' ');
      aois.push({
        id: s.id, category: s.category, name: s.name, lat: s.lat, lng: s.lng,
        hit: !!h, fireCount: h?.count ?? 0, maxFrp: h?.maxFrp ?? 0, latest: h?.latest ?? null,
        confidence: h ? confidenceOf(h.count, h.maxFrp) : null,
        sources: tgSources,
        videoConfirmed: false,
        bilateral: false,
        weapon: tgText ? (detectWeapon(tgText) ?? undefined) : undefined,
      });
    }

    // Merge Telegram strike messages (with oblast-level coords) into the news pipeline.
    // Each TgMessage that names a UA oblast becomes a NewsItem at that centroid;
    // the same isStrikeRelated / deduplication / fire-crossref logic applies.
    const tgNewsItems: NewsItem[] = tgStrike
      .map(tgToNewsItem)
      .filter((item): item is NewsItem => item !== null);
    const allNews = [...news, ...tgNewsItems];

    type Contributor = { source?: string; side?: string; link?: string; title?: string; description?: string; hasVideo?: boolean; weapon?: string; snippet?: string };
    type NewsAoi = {
      id: string; category: 'news'; name: string; source?: string; side?: string; link?: string;
      lat: number; lng: number; hit: boolean; fireCount: number; maxFrp: number; latest: string | null;
      confidence: Confidence; sources: Contributor[]; bilateral: boolean; videoConfirmed: boolean; weapon?: string;
    };
    const newsByCell = new Map<string, NewsAoi>();
    for (const n of allNews) {
      if (!isStrikeRelated(n) || isTerritorialAdvance(n) || isInterceptionOnly(n)) continue;
      // n.places = ALL cities the article names (gazetteer scan of full body) — often
      // includes incidental context cities, not just the actual strike location.
      // n.coords = primary / most-specific location (single best match).
      const isFromPlaces = !!(n.places && n.places.length);
      // Pair each place coord with its gazetteer keyword (if available) so the
      // snippet extractor can prefer sentences that mention this specific location.
      type Candidate = { lat: number; lng: number; name?: string };
      const candidates: Candidate[] = isFromPlaces
        ? (n.places as [number, number][]).map((c, i) => ({ lat: c[0], lng: c[1], name: n.place_names?.[i] }))
        : (n.coords && !n.coords_default ? [{ lat: n.coords[0], lng: n.coords[1] }] : []);
      const seenThisArticle = new Set<string>();
      for (const { lat, lng, name: placeName } of candidates) {
        if (lat < BBOX.latMin || lat > BBOX.latMax || lng < BBOX.lngMin || lng > BBOX.lngMax) continue;
        const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
        if (seenThisArticle.has(key)) continue; // one article contributes one marker per place
        seenThisArticle.add(key);
        const h = fireHit(fires, lat, lng, NEWS_RADIUS_KM);
        // FRP floor for fire-confirmed news markers. Background fires (agriculture,
        // industrial flare, stubble burn) typically run < 1.5 MW — too weak to confirm
        // a strike. Only fires above this floor count as corroboration.
        const meaningfulHit = h && h.maxFrp >= 1.5 ? h : null;
        // Gate logic differs by coord source:
        //   n.places coords: ALL cities named in the article body, including incidental
        //     context cities. hasStrategicTarget fires on the whole article, not this
        //     specific location, so it cannot disambiguate. Require a meaningful fire
        //     hit. The curated-site proximity merge above already handles the real target
        //     (e.g. "Samara" in a Kuibyshev-refinery article → merges into the site dot).
        //   n.coords (primary location): unconfirmed-strategic markers still allowed for
        //     single-location articles that name a specific strategic infrastructure type.
        if (isFromPlaces) {
          if (!meaningfulHit) continue;
        } else {
          if (!meaningfulHit && !hasStrategicTarget(n)) continue;
        }
        const articleText = `${n.title || ''} ${n.description || ''}`;
        const snippet = extractBestSnippet(n.title || '', n.description || '', placeName);
        const contributor: Contributor = { source: n.source, side: n.side, link: n.link, title: n.title?.slice(0, 120), description: n.description?.slice(0, 220), hasVideo: n.hasVideo, weapon: detectWeapon(articleText) ?? undefined, snippet };

        // Corroboration: if this coord falls within a curated site's radius, merge the
        // article into the site AOI instead of creating a separate news dot on top of it.
        const siteAoi = (aois as any[]).find(a => a.category !== 'news' && distKm(lat, lng, a.lat, a.lng) <= SITE_RADIUS_KM);
        if (siteAoi) {
          if (!siteAoi.sources.some((s: any) => s.source === contributor.source && s.title === contributor.title)) {
            siteAoi.sources.push(contributor);
          }
          if (h && !siteAoi.hit) {
            siteAoi.hit = true; siteAoi.fireCount = h.count; siteAoi.maxFrp = h.maxFrp;
            siteAoi.latest = h.latest; siteAoi.confidence = confidenceOf(h.count, h.maxFrp);
          }
          if (contributor.weapon && !siteAoi.weapon) siteAoi.weapon = contributor.weapon;
          if (contributor.hasVideo && !siteAoi.videoConfirmed) siteAoi.videoConfirmed = true;
          const bil = siteAoi.sources.some((s: any) => s.side === 'ua') && siteAoi.sources.some((s: any) => s.side === 'ru');
          if (bil && !siteAoi.bilateral) {
            siteAoi.bilateral = true;
            if (siteAoi.hit && siteAoi.confidence && siteAoi.confidence !== 'news')
              siteAoi.confidence = siteAoi.confidence === 'low' ? 'med' : 'high';
          }
          continue;
        }

        const existing = newsByCell.get(key);
        if (existing) {
          // Upgrade news-only → fire-confirmed only on a meaningful fire hit
          if (meaningfulHit && !existing.hit) {
            existing.hit = true;
            existing.fireCount = meaningfulHit.count;
            existing.maxFrp = meaningfulHit.maxFrp;
            existing.latest = meaningfulHit.latest;
            existing.confidence = confidenceOf(meaningfulHit.count, meaningfulHit.maxFrp);
          }
          if (!existing.sources.some(s => s.source === contributor.source && s.title === contributor.title)) {
            existing.sources.push(contributor);
          }
          if (contributor.weapon && !existing.weapon) existing.weapon = contributor.weapon;
          if (contributor.hasVideo && !existing.videoConfirmed) {
            existing.videoConfirmed = true;
            // Video is corroborating evidence — upgrade unverified 'news' to 'low'
            if (existing.confidence === 'news') existing.confidence = 'low';
          }
          // Bilateral: both sides present in sources after adding this contributor
          const bilateral = existing.sources.some(s => s.side === 'ua') && existing.sources.some(s => s.side === 'ru');
          if (bilateral) {
            existing.bilateral = true;
            // Bump confidence one tier when both sides corroborate a fire
            if (existing.hit && existing.confidence !== 'news') {
              existing.confidence = existing.confidence === 'low' ? 'med' : 'high';
            }
          }
          continue;
        }
        const initVideo = !!n.hasVideo;
        const initConf: Confidence = meaningfulHit ? confidenceOf(meaningfulHit.count, meaningfulHit.maxFrp) : (initVideo ? 'low' : 'news');
        newsByCell.set(key, {
          id: `news-${newsByCell.size + 1}`, category: 'news', name: contributor.snippet || contributor.title || 'News report',
          source: n.source, side: n.side, link: n.link, lat, lng,
          hit: !!meaningfulHit, fireCount: meaningfulHit?.count ?? 0, maxFrp: meaningfulHit?.maxFrp ?? 0, latest: meaningfulHit?.latest ?? null,
          confidence: initConf,
          sources: [contributor], bilateral: false, videoConfirmed: initVideo, weapon: contributor.weapon,
        });
      }
    }
    for (const a of newsByCell.values()) aois.push(a);
    const newsHits = newsByCell.size;

    // ── False-positive gate ───────────────────────────────────────────────────
    // Runs AFTER the news loop so videoConfirmed, sources (TG + news), and
    // bilateral are all final. A site fire passes if ANY of:
    //   • maxFrp ≥ NEWS_GATE_FRP_MW  (hot enough — struck refinery/depot)
    //   • videoConfirmed              (video is strong independent evidence)
    //   • sources.length > 0          (at least one TG or news corroboration)
    // Low-FRP detections with zero corroboration are suppressed — agriculture
    // burns, gas flares, and industrial heat sources rarely exceed ~20 MW and
    // never generate strike reports.
    for (const aoi of aois as any[]) {
      if (aoi.category === 'news' || !aoi.hit) continue;
      if (aoi.maxFrp >= NEWS_GATE_FRP_MW) continue;
      if (aoi.videoConfirmed || aoi.sources.length > 0) continue;
      aoi.hit = false; aoi.fireCount = 0; aoi.maxFrp = 0; aoi.latest = null; aoi.confidence = null;
    }

    // ── Persist confirmed hits + annotate lastHit fields ─────────────────────
    // Runs after the gate so only evidence-backed detections enter the 48-hour
    // rolling log. Annotations let the popup show "Last hit: Xh ago" after the
    // 12-hour FIRMS active-fire window expires.
    const currentHits: StoredHit[] = aois
      .filter((a: any) => a.category !== 'news' && a.hit)
      .map((a: any) => ({
        id: a.id, name: a.name, category: a.category,
        lat: a.lat, lng: a.lng,
        confidence: a.confidence, maxFrp: a.maxFrp, fireCount: a.fireCount,
        latest: a.latest, weapon: a.weapon,
        ts: Date.now(),
      }));
    const allHits = await mergeAndSaveHits(currentHits);
    const hitById = new Map(allHits.map((h: StoredHit) => [h.id, h]));
    for (const aoi of aois as any[]) {
      if (aoi.category === 'news') continue;
      const h = hitById.get(aoi.id);
      if (h && !aoi.hit) {
        aoi.lastHitTs     = h.ts;
        aoi.lastHitConf   = h.confidence;
        aoi.lastHitFrp    = h.maxFrp;
        aoi.lastHitWeapon = h.weapon;
      } else if (aoi.hit) {
        const prev = hitById.get(aoi.id);
        aoi.lastHitTs     = prev?.ts ?? Date.now();
        aoi.lastHitConf   = aoi.confidence;
        aoi.lastHitFrp    = aoi.maxFrp;
        aoi.lastHitWeapon = aoi.weapon;
      }
    }

    const siteHits = aois.filter(a => a.category !== 'news' && a.hit).length;
    const highConf = aois.filter(a => a.hit && a.confidence === 'high').length;
    return { aois, counts: { sites: SITES.length, site_hits: siteHits, news_hits: newsHits, high_confidence: highConf, fires_in_theater: fires.length }, timestamp: new Date().toISOString() };
  } catch (error) {
    console.error('Strategic-thermal error:', error);
    throw error;
  }
}

const THERMAL_HEADERS = { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' };

export async function GET(req: Request) {
  const now = Date.now();
  if (cached && now - cachedAt < THERMAL_TTL_MS) {
    return NextResponse.json(cached, { headers: THERMAL_HEADERS });
  }
  // Coalesce concurrent cache-misses onto a single computation.
  if (!inflight) {
    inflight = computeThermal(req)
      .then(r => { cached = r; cachedAt = Date.now(); persistThermalResponse(r); return r; })
      .finally(() => { inflight = null; });
  }
  // Serve stale cache immediately (stale-while-revalidate in-process) — the
  // recompute runs in the background and the next request gets fresh data.
  // Only block when there's truly nothing to serve (first ever request).
  if (cached) return NextResponse.json(cached, { headers: THERMAL_HEADERS });
  try {
    return NextResponse.json(await inflight, { headers: THERMAL_HEADERS });
  } catch {
    return NextResponse.json({ aois: [], error: 'Failed to compute thermal AOIs' }, { status: 500 });
  }
}
