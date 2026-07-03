/**
 * OSIRIS Intelligence Layer — osiris-intel
 *
 * Centralized ontology engine that ingests, indexes, and correlates entities
 * across open-source intelligence feeds. All other services query this one
 * brain via GET /resolve.
 *
 * Data sources:
 *   - OpenSanctions (OFAC SDN) — bulk CSV, refreshed every 24h
 *   - Wikidata SPARQL — on-demand with aggressive LRU cache
 *
 * Security:
 *   - Outbound requests only to allowlisted domains
 *   - SPARQL inputs sanitized against injection
 *   - Rate-limited per client IP
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.INTEL_PORT || 4000;

// ════════════════════════════════════════════════════
// §1 — CONFIGURATION
// ════════════════════════════════════════════════════

const SANCTIONS_SOURCES = [
  { url: 'https://data.opensanctions.org/datasets/latest/us_ofac_sdn/targets.simple.csv',      label: 'OFAC SDN'   },
  { url: 'https://data.opensanctions.org/datasets/latest/eu_fsf/targets.simple.csv',           label: 'EU FSF'     },
  { url: 'https://data.opensanctions.org/datasets/latest/un_sc_sanctions/targets.simple.csv',  label: 'UN SC'      },
  { url: 'https://data.opensanctions.org/datasets/latest/ua_war_sanctions/targets.simple.csv', label: 'UA WAR'     },
  { url: 'https://data.opensanctions.org/datasets/latest/au_dfat_sanctions/targets.simple.csv',label: 'AU DFAT'    },
  { url: 'https://data.opensanctions.org/datasets/latest/ch_seco_sanctions/targets.simple.csv',label: 'CH SECO'    },
  { url: 'https://data.opensanctions.org/datasets/latest/ca_sema_sema/targets.simple.csv',     label: 'CA SEMA'    },
  { url: 'https://data.opensanctions.org/datasets/latest/gb_hmt_sanctions/targets.simple.csv', label: 'UK HMT'     },
  // gb_hmt_sanctions simple CSV was empty in 2025; keeping it in case the dataset is populated later
];
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const WIKIDATA_UA = 'OSIRIS-Intel/1.0 (https://osirisai.live; ontology engine)';
const SDN_REFRESH_MS = 24 * 60 * 60 * 1000; // 24h
const WIKIDATA_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
const WIKIDATA_CACHE_MAX = 10_000;

const SHODAN_API_KEY         = process.env.SHODAN_API_KEY         || '';
const ABUSEIPDB_KEY          = process.env.ABUSEIPDB_KEY          || '';
const OPENSANCTIONS_API_KEY  = process.env.OPENSANCTIONS_API_KEY  || '';
const GFW_API_KEY            = process.env.GFW_API_KEY            || '';
const FLEETMON_API_USER      = process.env.FLEETMON_API_USER      || '';
const FLEETMON_API_KEY       = process.env.FLEETMON_API_KEY       || '';
const COMPANIES_HOUSE_KEY    = process.env.COMPANIES_HOUSE_KEY    || '';

// Persist resolved entities across restarts so rate-limited API calls aren't re-made.
// /data is a volume mount in production; falls back to a local dir in dev.
const DISK_CACHE_DIR  = process.env.INTEL_CACHE_DIR || '/data/intel';
const DISK_CACHE_FILE = path.join(DISK_CACHE_DIR, 'resolve-cache.json');
const DISK_CACHE_SAVE_DEBOUNCE_MS = 30_000; // write at most once per 30s
let diskCacheSaveTimer = null;

// ISO 3166-1 alpha-2 → full country name (covers all codes seen in sanctions/AIS/OSINT data)
const CC = {
  af:'Afghanistan',al:'Albania',dz:'Algeria',ao:'Angola',ag:'Antigua and Barbuda',
  ar:'Argentina',am:'Armenia',au:'Australia',at:'Austria',az:'Azerbaijan',
  bs:'Bahamas',bh:'Bahrain',bd:'Bangladesh',bb:'Barbados',by:'Belarus',
  be:'Belgium',bz:'Belize',bj:'Benin',bo:'Bolivia',ba:'Bosnia and Herzegovina',
  bw:'Botswana',br:'Brazil',bn:'Brunei',bg:'Bulgaria',bf:'Burkina Faso',
  bi:'Burundi',cv:'Cape Verde',kh:'Cambodia',cm:'Cameroon',ca:'Canada',
  cf:'Central African Republic',td:'Chad',cl:'Chile',cn:'China',co:'Colombia',
  cd:'DR Congo',cg:'Congo',cr:'Costa Rica',hr:'Croatia',cu:'Cuba',cw:'Curaçao',
  cy:'Cyprus',cz:'Czech Republic',dk:'Denmark',dj:'Djibouti',do:'Dominican Republic',
  ec:'Ecuador',eg:'Egypt',sv:'El Salvador',gq:'Equatorial Guinea',er:'Eritrea',
  ee:'Estonia',et:'Ethiopia',fj:'Fiji',fi:'Finland',fr:'France',
  ga:'Gabon',gm:'Gambia',ge:'Georgia',de:'Germany',gh:'Ghana',
  gr:'Greece',gt:'Guatemala',gn:'Guinea',gw:'Guinea-Bissau',gy:'Guyana',
  ht:'Haiti',hn:'Honduras',hk:'Hong Kong',hu:'Hungary',
  is:'Iceland',in:'India',id:'Indonesia',ir:'Iran',iq:'Iraq',
  ie:'Ireland',il:'Israel',it:'Italy',jm:'Jamaica',jp:'Japan',
  jo:'Jordan',kz:'Kazakhstan',ke:'Kenya',kp:'North Korea',kr:'South Korea',
  kw:'Kuwait',kg:'Kyrgyzstan',la:'Laos',lv:'Latvia',lb:'Lebanon',
  ly:'Libya',lt:'Lithuania',lu:'Luxembourg',mo:'Macau',mg:'Madagascar',
  mw:'Malawi',my:'Malaysia',mv:'Maldives',ml:'Mali',mt:'Malta',
  mr:'Mauritania',mu:'Mauritius',mx:'Mexico',md:'Moldova',mn:'Mongolia',
  me:'Montenegro',ma:'Morocco',mz:'Mozambique',mm:'Myanmar',na:'Namibia',
  np:'Nepal',nl:'Netherlands',nz:'New Zealand',ni:'Nicaragua',ne:'Niger',
  ng:'Nigeria',mk:'North Macedonia',no:'Norway',om:'Oman',pk:'Pakistan',
  pa:'Panama',pg:'Papua New Guinea',py:'Paraguay',pe:'Peru',ph:'Philippines',
  pl:'Poland',pt:'Portugal',qa:'Qatar',ro:'Romania',ru:'Russia',
  rw:'Rwanda',sa:'Saudi Arabia',sn:'Senegal',rs:'Serbia',sl:'Sierra Leone',
  sg:'Singapore',sk:'Slovakia',si:'Slovenia',so:'Somalia',za:'South Africa',
  ss:'South Sudan',es:'Spain',lk:'Sri Lanka',sd:'Sudan',sr:'Suriname',
  se:'Sweden',ch:'Switzerland',sy:'Syria',tw:'Taiwan',tj:'Tajikistan',
  tz:'Tanzania',th:'Thailand',tl:'Timor-Leste',tg:'Togo',tt:'Trinidad and Tobago',
  tn:'Tunisia',tr:'Turkey',tm:'Turkmenistan',tc:'Turks and Caicos',
  ug:'Uganda',ua:'Ukraine',ae:'UAE',gb:'United Kingdom',us:'United States',
  uy:'Uruguay',uz:'Uzbekistan',ve:'Venezuela',vn:'Vietnam',
  eh:'Western Sahara',ye:'Yemen',zm:'Zambia',zw:'Zimbabwe',
  lr:'Liberia',mh:'Marshall Islands',sc:'Seychelles',vc:'Saint Vincent',
  kn:'Saint Kitts and Nevis',vg:'British Virgin Islands',ky:'Cayman Islands',
  gi:'Gibraltar',im:'Isle of Man',je:'Jersey',gg:'Guernsey',
  bm:'Bermuda',ai:'Anguilla',ms:'Montserrat',tc2:'Turks and Caicos',
  ax:'Åland Islands',fo:'Faroe Islands',gl:'Greenland',nc:'New Caledonia',
  pf:'French Polynesia',ws:'Samoa',to:'Tonga',vu:'Vanuatu',sb:'Solomon Islands',
  ki:'Kiribati',fm:'Micronesia',pw:'Palau',nr:'Nauru',tv:'Tuvalu',
};

// MMSI Maritime Identification Digits (first 3 digits → country name)
const MID = {
  201:'Albania',202:'Andorra',203:'Austria',204:'Portugal',205:'Belgium',206:'Belarus',
  207:'Bulgaria',208:'Vatican City',209:'Cyprus',210:'Cyprus',211:'Germany',212:'Cyprus',
  213:'Georgia',214:'Moldova',215:'Malta',216:'Armenia',219:'Denmark',220:'Denmark',
  224:'Spain',225:'Spain',226:'France',227:'France',228:'France',229:'Malta',
  230:'Finland',231:'Faroe Islands',232:'United Kingdom',233:'United Kingdom',234:'United Kingdom',235:'United Kingdom',
  236:'Gibraltar',237:'Greece',238:'Croatia',239:'Greece',240:'Greece',241:'Greece',
  242:'Morocco',243:'Hungary',244:'Netherlands',245:'Netherlands',246:'Netherlands',
  247:'Italy',248:'Malta',249:'Malta',250:'Ireland',251:'Iceland',252:'Liechtenstein',
  253:'Luxembourg',254:'Monaco',255:'Portugal',256:'Malta',257:'Norway',258:'Norway',259:'Norway',
  261:'Poland',262:'Montenegro',263:'Portugal',264:'Romania',265:'Sweden',266:'Sweden',
  267:'Slovakia',268:'San Marino',269:'Switzerland',270:'Czech Republic',271:'Turkey',
  272:'Ukraine',273:'Russia',274:'North Macedonia',275:'Latvia',276:'Estonia',277:'Lithuania',
  278:'Slovenia',279:'Serbia',281:'Bosnia-Herzegovina',301:'Antigua and Barbuda',
  303:'United States',304:'Antigua and Barbuda',305:'Antigua and Barbuda',306:'Netherlands Antilles',
  307:'Aruba',308:'Bahamas',309:'Bahamas',310:'Bermuda',311:'Bahamas',312:'Belize',
  314:'Barbados',316:'Canada',319:'Cayman Islands',321:'Costa Rica',323:'Cuba',
  325:'Dominica',327:'Dominican Republic',329:'Guadeloupe',330:'Grenada',331:'Greenland',
  332:'Guatemala',334:'Honduras',336:'Haiti',338:'United States',339:'Jamaica',
  341:'Saint Kitts and Nevis',343:'Saint Lucia',345:'Mexico',347:'Martinique',
  348:'Montserrat',350:'Nicaragua',351:'Panama',352:'Panama',353:'Panama',354:'Panama',
  355:'Panama',356:'Panama',357:'Panama',358:'Puerto Rico',359:'El Salvador',
  361:'Saint Pierre and Miquelon',362:'Trinidad and Tobago',364:'Turks and Caicos Islands',
  366:'United States',367:'United States',368:'United States',369:'United States',
  370:'Panama',371:'Panama',372:'Panama',373:'Panama',374:'Panama',
  375:'Saint Vincent and the Grenadines',376:'Saint Vincent and the Grenadines',377:'Saint Vincent and the Grenadines',
  378:'British Virgin Islands',379:'US Virgin Islands',
  401:'Afghanistan',403:'Saudi Arabia',405:'Bangladesh',408:'Bahrain',410:'Bhutan',
  412:'China',413:'China',414:'China',416:'Taiwan',422:'Iran',423:'Azerbaijan',
  425:'Iraq',428:'Israel',431:'Japan',432:'Japan',434:'Turkmenistan',436:'Kazakhstan',
  437:'Uzbekistan',438:'Jordan',440:'South Korea',441:'South Korea',443:'Palestine',
  445:'North Korea',447:'Kuwait',450:'Lebanon',451:'Kyrgyzstan',453:'Macau',
  455:'Maldives',457:'Mongolia',459:'Nepal',461:'Oman',463:'Pakistan',466:'Qatar',
  468:'Syria',470:'UAE',472:'Tajikistan',477:'Hong Kong',478:'Bosnia-Herzegovina',
  503:'Australia',506:'Myanmar',508:'Brunei',510:'Micronesia',511:'Palau',
  512:'New Zealand',514:'Cambodia',515:'Cambodia',516:'Christmas Island',518:'Cook Islands',
  520:'Fiji',523:'Cocos Islands',525:'Indonesia',529:'Kiribati',531:'Laos',
  533:'Malaysia',536:'Northern Mariana Islands',538:'Marshall Islands',540:'New Caledonia',
  542:'Niue',544:'Nauru',546:'French Polynesia',548:'Philippines',553:'Papua New Guinea',
  555:'Pitcairn Island',557:'Solomon Islands',559:'American Samoa',561:'Samoa',
  563:'Singapore',564:'Singapore',565:'Singapore',566:'Singapore',567:'Thailand',
  570:'Tonga',572:'Tuvalu',574:'Vietnam',576:'Vanuatu',578:'Wallis and Futuna',
  601:'South Africa',603:'Angola',605:'Algeria',608:'Ascension Island',609:'Burundi',
  610:'Benin',611:'Botswana',612:'Central African Republic',613:'Cameroon',615:'Congo',
  616:'Comoros',617:'Cape Verde',619:'Ivory Coast',621:'Djibouti',622:'Egypt',
  624:'Ethiopia',625:'Eritrea',626:'Gabon',627:'Ghana',629:'Gambia',630:'Guinea-Bissau',
  631:'Equatorial Guinea',632:'Guinea',633:'Burkina Faso',634:'Kenya',636:'Liberia',637:'Liberia',
  638:'South Sudan',642:'Libya',644:'Lesotho',645:'Mauritius',647:'Madagascar',
  649:'Mali',650:'Mozambique',654:'Mauritania',655:'Malawi',656:'Niger',657:'Nigeria',
  659:'Namibia',660:'Reunion',661:'Rwanda',662:'Sudan',663:'Senegal',664:'Seychelles',
  665:'Saint Helena',666:'Somalia',667:'Sierra Leone',668:'Sao Tome and Principe',
  669:'Swaziland',670:'Chad',671:'Togo',672:'Tunisia',674:'Tanzania',675:'Uganda',
  676:'Mozambique',677:'Tanzania',678:'Zimbabwe',679:'Zambia',
  701:'Argentina',710:'Brazil',720:'Bolivia',725:'Chile',730:'Colombia',735:'Ecuador',
  740:'Falkland Islands',745:'French Guiana',748:'Guyana',750:'Paraguay',755:'Peru',
  760:'Suriname',765:'Uruguay',770:'Venezuela',
};
function mmsiToCountry(mmsi) {
  if (!mmsi || mmsi.length < 3) return null;
  return MID[parseInt(mmsi.substring(0, 3), 10)] || null;
}

const ALLOWED_DOMAINS = new Set([
  'query.wikidata.org', 'data.opensanctions.org', 'www.wikidata.org',
  'ip-api.com', 'stat.ripe.net', 'api.opencorporates.com',
  'api.shodan.io', 'api.abuseipdb.com', 'registry.faa.gov',
  'en.wikipedia.org',                   // article summaries — vessels, companies, persons
  'api.adsb.lol',                       // ADS-B live state + registration by ICAO24
  'api.hackertarget.com',               // reverse IP → co-hosted domains
  ...(OPENSANCTIONS_API_KEY ? ['api.opensanctions.org'] : []),
  ...(GFW_API_KEY            ? ['gateway.api.globalfishingwatch.org'] : []),
  ...(FLEETMON_API_USER      ? ['www.fleetmon.com'] : []),
  'api.gleif.org',                      // LEI → parent company + country (keyless)
  ...(COMPANIES_HOUSE_KEY    ? ['api.company-information.service.gov.uk'] : []),
]);

// ════════════════════════════════════════════════════
// §2 — SANCTIONS INDEX (in-memory graph)
// ════════════════════════════════════════════════════

let sanctionsIndex = {
  entries: [],
  byNorm: new Map(),   // normalised name/alias → [entry]
  fetchedAt: 0,
};

function normName(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseSanctionsRows(rows, label) {
  const headers = rows[0];
  const idx = (col) => headers.indexOf(col);
  const i = {
    id: idx('id'), schema: idx('schema'), name: idx('name'),
    aliases: idx('aliases'), countries: idx('countries'),
    programs: idx('program_ids'), sanctions: idx('sanctions'),
    first_seen: idx('first_seen'),
  };
  const entries = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row[i.name]) continue;
    entries.push({
      id: row[i.id] || '',
      schema: row[i.schema] || 'LegalEntity',
      name: row[i.name],
      aliases: (row[i.aliases] || '').split(';').map(s => s.trim()).filter(Boolean),
      countries: (row[i.countries] || '').split(';').map(s => s.trim()).filter(Boolean),
      programs: (row[i.programs] || '').split(';').map(s => s.trim()).filter(Boolean),
      sanctions: row[i.sanctions] || '',
      first_seen: i.first_seen >= 0 ? row[i.first_seen] : undefined,
      sanctionsList: label,
    });
  }
  return entries;
}

async function loadSanctions() {
  console.log(`[INTEL] Loading sanctions lists (${SANCTIONS_SOURCES.map(s => s.label).join(', ')})...`);
  const results = await Promise.allSettled(
    SANCTIONS_SOURCES.map(async ({ url, label }) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { Accept: 'text/csv' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const rows = parseCsv(text);
      if (rows.length < 2) throw new Error('CSV empty');
      const entries = parseSanctionsRows(rows, label);
      console.log(`[INTEL] ${label}: ${entries.length} entities`);
      return entries;
    })
  );

  const allEntries = [];
  const byNorm = new Map();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const entry of r.value) {
        allEntries.push(entry);
        const keys = new Set([entry.name, ...entry.aliases].map(normName));
        for (const key of keys) {
          if (!key) continue;
          if (!byNorm.has(key)) byNorm.set(key, []);
          byNorm.get(key).push(entry);
        }
      }
    } else {
      console.error('[INTEL] Sanctions source failed:', r.reason?.message);
    }
  }

  if (allEntries.length === 0 && sanctionsIndex.entries.length > 0) {
    console.log('[INTEL] All sources failed — keeping stale index');
    return;
  }
  sanctionsIndex = { entries: allEntries, byNorm, fetchedAt: Date.now() };
  console.log(`[INTEL] Sanctions index: ${allEntries.length} entities across ${SANCTIONS_SOURCES.length} lists, ${byNorm.size} name keys`);
}

// ════════════════════════════════════════════════════
// §2b — OpenSanctions FtM relationship index
//
// Streams entities.ftm.json (NDJSON, no API key, no rate limit).
// Provides structured ownership/directorship chains for vessels
// in the ua_war_sanctions dataset — fully offline once loaded.
// ════════════════════════════════════════════════════

const ftmById             = new Map(); // entity id → entity
const ftmVesselByImo      = new Map(); // "IMO1234567" → entity
const ftmVesselByMmsi     = new Map(); // "338123456" → entity
const ftmVesselByName     = new Map(); // UPPER name → entity
const ftmOwnershipByAsset = new Map(); // asset entity id → Ownership[]
const ftmCompanyByName    = new Map(); // UPPER name → entity (LegalEntity/Company/Org)
const ftmPersonByName     = new Map(); // UPPER name → entity
const ftmDirByOrg         = new Map(); // org entity id → Directorship[]
const ftmDirByDirector    = new Map(); // director entity id → Directorship[]
const ftmUnknownBySubject = new Map(); // subject entity id → UnknownLink[]

async function loadFtmRelationships(datasetName) {
  const url = `https://data.opensanctions.org/datasets/latest/${datasetName}/entities.ftm.json`;
  if (!ALLOWED_DOMAINS.has(new URL(url).hostname)) return;
  const { createInterface } = require('readline');
  let vesselCount = 0, ownershipCount = 0, companyCount = 0, dirCount = 0;
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.get(url, { headers: { 'User-Agent': WIKIDATA_UA, 'Accept-Encoding': 'identity' } }, (res) => {
      if (res.statusCode !== 200) {
        console.warn(`[INTEL] FtM ${datasetName}: HTTP ${res.statusCode}`);
        res.resume(); return resolve();
      }
      const rl = createInterface({ input: res, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const e = JSON.parse(line);
          const { id, schema, properties: p = {} } = e;
          ftmById.set(id, e);
          if (schema === 'Vessel') {
            for (const imo  of (p.imoNumber  || [])) ftmVesselByImo.set(imo.toUpperCase(), e);
            for (const mmsi of (p.mmsi       || [])) ftmVesselByMmsi.set(mmsi, e);
            for (const name of (p.name       || [])) ftmVesselByName.set(name.toUpperCase(), e);
            vesselCount++;
          } else if (schema === 'Ownership') {
            for (const assetId of (p.asset || [])) {
              if (!ftmOwnershipByAsset.has(assetId)) ftmOwnershipByAsset.set(assetId, []);
              ftmOwnershipByAsset.get(assetId).push(e);
            }
            ownershipCount++;
          } else if (['LegalEntity', 'Company', 'Organization'].includes(schema)) {
            for (const name of (p.name || [])) ftmCompanyByName.set(name.toUpperCase(), e);
            companyCount++;
          } else if (schema === 'Person') {
            for (const name of (p.name || [])) ftmPersonByName.set(name.toUpperCase(), e);
          } else if (schema === 'Directorship') {
            for (const orgId of (p.organization || [])) {
              if (!ftmDirByOrg.has(orgId)) ftmDirByOrg.set(orgId, []);
              ftmDirByOrg.get(orgId).push(e);
            }
            for (const dirId of (p.director || [])) {
              if (!ftmDirByDirector.has(dirId)) ftmDirByDirector.set(dirId, []);
              ftmDirByDirector.get(dirId).push(e);
            }
            dirCount++;
          } else if (schema === 'UnknownLink') {
            for (const subjId of (p.subject || [])) {
              if (!ftmUnknownBySubject.has(subjId)) ftmUnknownBySubject.set(subjId, []);
              ftmUnknownBySubject.get(subjId).push(e);
            }
          }
        } catch { /* skip malformed lines */ }
      });
      rl.on('close', () => {
        console.log(`[INTEL] FtM ${datasetName}: ${vesselCount} vessels, ${companyCount} companies, ${ownershipCount} ownership, ${dirCount} directorships`);
        resolve();
      });
    });
    req.on('error', (e) => { console.warn('[INTEL] FtM load error:', e.message); resolve(); });
    req.setTimeout(90_000, () => { req.destroy(); console.warn('[INTEL] FtM load timeout'); resolve(); });
  });
}

function sanctionsSearch(query, limit = 5) {
  if (!query || query.length < 3) return [];
  const q = normName(query);
  const exact = sanctionsIndex.byNorm.get(q) || [];
  if (exact.length > 0) return exact.slice(0, limit);

  // Fuzzy: match only at word boundaries so "SAND" doesn't hit "aleksander".
  // The query must appear at the start of a word (^word or space+word) in the
  // normalized name. Single-token queries under 5 chars skip fuzzy entirely —
  // too many false positives on short common words.
  const qWords = q.split(' ');
  const isSingleShort = qWords.length === 1 && q.length < 5;
  if (isSingleShort) return [];

  // Compile once: each query word must appear at start-of-word in the name
  const wordRegexes = qWords.map(w => new RegExp('(?:^|\\s)' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const matchesFuzzy = (name) => wordRegexes.every(re => re.test(name));

  const results = [];
  const seen = new Set();
  for (const entry of sanctionsIndex.entries) {
    if (results.length >= limit) break;
    if (seen.has(entry.id)) continue;
    const n = normName(entry.name);
    if (matchesFuzzy(n) || entry.aliases.some(a => matchesFuzzy(normName(a)))) {
      seen.add(entry.id);
      results.push(entry);
    }
  }
  return results;
}

// ════════════════════════════════════════════════════
// §3 — WIKIDATA LRU CACHE (in-memory + disk persistence)
// ════════════════════════════════════════════════════

const wdCache = new Map(); // key → { data, ts }

// Load persisted cache from disk so resolved entities survive restarts.
// Stale entries (older than WIKIDATA_CACHE_TTL) are skipped on load.
try {
  fs.mkdirSync(DISK_CACHE_DIR, { recursive: true });
  if (fs.existsSync(DISK_CACHE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DISK_CACHE_FILE, 'utf8'));
    const now = Date.now();
    let loaded = 0;
    for (const [k, v] of Object.entries(saved)) {
      if (v?.ts && now - v.ts < WIKIDATA_CACHE_TTL) {
        wdCache.set(k, v);
        loaded++;
      }
    }
    console.log(`[INTEL] Loaded ${loaded} cached entries from disk (${DISK_CACHE_FILE})`);
  }
} catch (e) { console.warn('[INTEL] Disk cache load error:', e.message); }

function saveCacheToDisk() {
  try {
    const obj = {};
    for (const [k, v] of wdCache.entries()) obj[k] = v;
    fs.writeFileSync(DISK_CACHE_FILE, JSON.stringify(obj));
  } catch (e) { console.warn('[INTEL] Disk cache save error:', e.message); }
}

function scheduleCacheSave() {
  if (diskCacheSaveTimer) return;
  diskCacheSaveTimer = setTimeout(() => {
    diskCacheSaveTimer = null;
    saveCacheToDisk();
  }, DISK_CACHE_SAVE_DEBOUNCE_MS);
}

// Flush on exit so the last batch of resolutions isn't lost
process.on('SIGTERM', () => { saveCacheToDisk(); process.exit(0); });
process.on('SIGINT',  () => { saveCacheToDisk(); process.exit(0); });

function wdCacheGet(key) {
  const entry = wdCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > WIKIDATA_CACHE_TTL) { wdCache.delete(key); return null; }
  // Move to end (LRU)
  wdCache.delete(key);
  wdCache.set(key, entry);
  return entry.data;
}

function wdCacheSet(key, data) {
  // Never cache empty results — a transient failure shouldn't poison the cache
  if (!data || (Array.isArray(data.nodes) && data.nodes.length === 0)) return;
  if (wdCache.size >= WIKIDATA_CACHE_MAX) {
    const oldest = wdCache.keys().next().value;
    wdCache.delete(oldest);
  }
  wdCache.set(key, { data, ts: Date.now() });
  scheduleCacheSave();
}

// ════════════════════════════════════════════════════
// §4 — WIKIDATA SPARQL (safe)
// ════════════════════════════════════════════════════

function sanitizeId(id) {
  return id.replace(/[^a-zA-Z0-9 \-._]/g, '').trim();
}

async function sparql(query) {
  const url = `${WIKIDATA_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const parsed = new URL(url);
  if (!ALLOWED_DOMAINS.has(parsed.hostname)) {
    throw new Error(`Blocked domain: ${parsed.hostname}`);
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': WIKIDATA_UA, Accept: 'application/sparql-results+json' },
    signal: AbortSignal.timeout(18000),
  });
  if (!res.ok) return [];
  const json = await res.json();
  return json.results?.bindings || [];
}

// Search Wikidata for an entity by name, returns QID or null
async function wdSearch(query) {
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&limit=3&format=json`;
  const parsed = new URL(url);
  if (!ALLOWED_DOMAINS.has(parsed.hostname)) return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': WIKIDATA_UA },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.search?.map(r => r.id) || [];
  } catch { return []; }
}

// Query the OpenSanctions entity search API for structured data beyond what the CSV carries.
// Requires OPENSANCTIONS_API_KEY — free key at opensanctions.org/api/
// schema: 'Vessel' | 'Company' | 'Person' | 'Organization'
async function opensanctionsSearch(query, schema) {
  if (!OPENSANCTIONS_API_KEY) return null;
  const url = `https://api.opensanctions.org/search/default?q=${encodeURIComponent(query)}&schema=${schema}&limit=1`;
  if (!ALLOWED_DOMAINS.has(new URL(url).hostname)) return null;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': WIKIDATA_UA, Accept: 'application/json', Authorization: `ApiKey ${OPENSANCTIONS_API_KEY}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.results?.[0] || null;
  } catch { return null; }
}

// Search OpenSanctions by a structured property value (e.g. IMO number for vessels).
async function opensanctionsByProp(schema, prop, value) {
  if (!OPENSANCTIONS_API_KEY) return null;
  const url = `https://api.opensanctions.org/entities/?schema=${schema}&prop=${prop}&value=${encodeURIComponent(value)}&limit=1`;
  if (!ALLOWED_DOMAINS.has(new URL(url).hostname)) return null;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': WIKIDATA_UA, Accept: 'application/json', Authorization: `ApiKey ${OPENSANCTIONS_API_KEY}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.results?.[0] || null;
  } catch { return null; }
}

// ════════════════════════════════════════════════════
// §5 — RESOLVERS (the intelligence)
// ════════════════════════════════════════════════════

// Add a country node + link for an ISO-2 code attached to an entity node.
// Used by vessel adjacent entities, company OS results, person OS results.
function linkCountry(countryCode, sourceId, nodes, links, label = 'BASED IN') {
  if (!countryCode) return;
  const name = CC[countryCode.toLowerCase()] || countryCode.toUpperCase();
  const cid = `country:${name}`;
  nodes.push({ id: cid, label: name, type: 'country', properties: { code: countryCode.toLowerCase(), source: 'OpenSanctions' } });
  links.push({ source: sourceId, target: cid, label });
}

// Fetch directors/officers for a company entity from the OpenSanctions adjacent API.
// directorshipOrganization results contain inline Person objects with caption + topics + country.
async function fetchOsDirectors(entityId, companyNodeId, nodes, links) {
  if (!OPENSANCTIONS_API_KEY || !entityId) return;
  const url = `https://api.opensanctions.org/entities/${entityId}/adjacent`;
  if (!ALLOWED_DOMAINS.has(new URL(url).hostname)) return;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `ApiKey ${OPENSANCTIONS_API_KEY}`, Accept: 'application/json', 'User-Agent': WIKIDATA_UA },
    });
    if (!res.ok) return;
    const adj = (await res.json()).adjacent || {};
    for (const rel of (adj.directorshipOrganization?.results || [])) {
      for (const personObj of [rel.properties?.director].flat().filter(o => o && typeof o === 'object')) {
        const name = personObj.caption || personObj.properties?.name?.[0];
        if (!name) continue;
        const pid = `person:${name}`;
        const role = rel.properties?.role?.[0] || 'Director';
        nodes.push({ id: pid, label: name, type: 'person', properties: {
          role, source: 'OpenSanctions',
          topics: (personObj.properties?.topics || []).join(', ') || undefined,
        }});
        links.push({ source: companyNodeId, target: pid, label: role.toUpperCase() });
        for (const cc of (personObj.properties?.nationality || personObj.properties?.country || [])) {
          linkCountry(cc, pid, nodes, links, 'NATIONALITY');
        }
        addSanctionsToGraph(name, companyNodeId, nodes, links);
      }
    }
  } catch (e) { console.warn('[INTEL] OS directors fetch error:', e.message); }
}

// Wikipedia summary — ships, companies, people, aircraft types.
// Searches for the term and returns {title, description, extract}.
// Returns null when no article is found or the request fails.
async function fetchWikipedia(term) {
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&format=json&srlimit=1&srprop=snippet`;
    if (!ALLOWED_DOMAINS.has('en.wikipedia.org')) return null;
    const sr = await fetch(searchUrl, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': WIKIDATA_UA } });
    if (!sr.ok) return null;
    const sd = await sr.json();
    const title = sd?.query?.search?.[0]?.title;
    if (!title) return null;
    const summUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    const rr = await fetch(summUrl, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': WIKIDATA_UA } });
    if (!rr.ok) return null;
    const d = await rr.json();
    return { title: d.title, description: d.description || null, extract: d.extract ? d.extract.slice(0, 400) : null };
  } catch { return null; }
}

function addSanctionsToGraph(query, rootId, nodes, links) {
  const matches = sanctionsSearch(query);
  for (const m of matches) {
    const sid = `sanction:${m.id}`;
    nodes.push({
      id: sid, label: `⚠ ${m.name}`, type: 'sanction',
      properties: {
        schema: m.schema, countries: m.countries.join(', '),
        programs: m.programs.join(', '), sanctions: m.sanctions,
        aliases: m.aliases.slice(0, 5).join('; '),
        first_seen: m.first_seen, sanctioned: true,
        sanctions_list: m.sanctionsList || 'OFAC SDN',
      },
    });
    links.push({ source: rootId, target: sid, label: 'SANCTIONS MATCH' });
    // Emit country nodes for sanctioned companies/orgs — the CSV `countries` field
    // is the jurisdiction of the sanctioned entity, not the sanctioning authority.
    if (['Company', 'LegalEntity', 'Organization'].includes(m.schema)) {
      for (const cc of m.countries) {
        if (cc && cc.length <= 3) linkCountry(cc, rootId, nodes, links, 'BASED IN');
      }
    }
  }
}

function dedup(nodes, links, rootId = null) {
  // Case-insensitive ID normalization: "vessel:RIGEL" and "vessel:Rigel" are the same node.
  const normKey = id => {
    if (!id) return String(id);
    const s = String(id);
    const c = s.indexOf(':');
    if (c < 0) return s.trim().toLowerCase();
    return `${s.slice(0, c)}:${s.slice(c + 1).trim().toLowerCase()}`;
  };

  const keyToCanon = new Map(); // normKey → canonical id (first seen)
  const byKey = new Map();      // normKey → merged node

  for (const n of nodes) {
    const key = normKey(n.id);
    if (!byKey.has(key)) {
      keyToCanon.set(key, n.id);
      byKey.set(key, { ...n, properties: { ...n.properties } });
    } else {
      const existing = byKey.get(key);
      for (const [k, v] of Object.entries(n.properties || {})) {
        if (v !== undefined && v !== null && v !== '' && !existing.properties[k]) {
          existing.properties[k] = v;
        }
      }
    }
  }

  // Remap link endpoints to canonical IDs, then dedup links.
  const resolveId = id => keyToCanon.get(normKey(String(id))) || String(id);
  const lSeen = new Set();
  const uLinks = [];
  for (const l of links) {
    const src = resolveId(l.source);
    const tgt = resolveId(l.target);
    const k = `${src}→${tgt}→${l.label}`;
    if (!lSeen.has(k)) { lSeen.add(k); uLinks.push({ ...l, source: src, target: tgt }); }
  }

  // Filter orphan nodes: any node with no link endpoints referencing it is noise.
  // Always keep the root entity node; if there are no links yet, keep everything.
  if (uLinks.length > 0) {
    const linked = new Set(uLinks.flatMap(l => [l.source, l.target]));
    const allNodes = [...byKey.values()].filter(n => linked.has(n.id) || n.id === rootId);
    return { nodes: allNodes, links: uLinks };
  }

  return { nodes: [...byKey.values()], links: uLinks };
}

async function resolveAircraft(id, properties = {}) {
  const rootId = `aircraft:${id}`;
  const nodes = [], links = [];
  const cacheKey = `aircraft:${id}:${properties.registration || ''}`;
  const cached = wdCacheGet(cacheKey);
  if (cached) return { ...cached };

  const callsign = id.toUpperCase().trim();
  const registration = (properties.registration || '').toUpperCase().trim();
  const model = properties.model || '';

  // Step 1: Decode ICAO airline prefix from callsign (e.g. TRK → Turkish Airlines)
  // The prefix is the alphabetic portion of the callsign
  const airlinePrefix = callsign.replace(/[0-9]+$/, '');
  let airlineName = null;

  if (airlinePrefix && airlinePrefix.length >= 2) {
    // Search Wikidata for the ICAO airline code
    try {
      const results = await sparql(`
        SELECT ?item ?itemLabel ?countryLabel ?ceoLabel ?parentLabel WHERE {
          ?item wdt:P230 "${airlinePrefix}" .
          OPTIONAL { ?item wdt:P17 ?country . }
          OPTIONAL { ?item wdt:P169 ?ceo . }
          OPTIONAL { ?item wdt:P749 ?parent . }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
        } LIMIT 5`);

      for (const r of results) {
        if (r.itemLabel?.value) {
          airlineName = r.itemLabel.value;
          const airId = `company:${airlineName}`;
          nodes.push({ id: airId, label: airlineName, type: 'company', properties: { icao_code: airlinePrefix, source: 'Wikidata' } });
          links.push({ source: rootId, target: airId, label: 'OPERATED BY' });

          if (r.countryLabel?.value) {
            const cid = `country:${r.countryLabel.value}`;
            nodes.push({ id: cid, label: r.countryLabel.value, type: 'country', properties: { source: 'Wikidata' } });
            links.push({ source: airId, target: cid, label: 'HEADQUARTERED' });
          }
          if (r.ceoLabel?.value) {
            const pid = `person:${r.ceoLabel.value}`;
            nodes.push({ id: pid, label: r.ceoLabel.value, type: 'person', properties: { role: 'CEO', source: 'Wikidata' } });
            links.push({ source: airId, target: pid, label: 'CEO' });
          }
          if (r.parentLabel?.value) {
            const pid = `company:${r.parentLabel.value}`;
            nodes.push({ id: pid, label: r.parentLabel.value, type: 'company', properties: { source: 'Wikidata' } });
            links.push({ source: airId, target: pid, label: 'PARENT ORG' });
          }
        }
      }
    } catch (e) { console.warn('[INTEL] Airline ICAO lookup error:', e.message); }
  }

  // Step 2: Decode registration prefix → country
  const REG_PREFIXES = {
    'N':'United States','G':'United Kingdom','F':'France','D':'Germany','I':'Italy',
    'JA':'Japan','HL':'South Korea','B':'China','VT':'India','TC':'Turkey',
    'RA':'Russia','UN':'Russia','UR':'Ukraine','A6':'UAE','A7':'Qatar','9V':'Singapore',
    'VH':'Australia','C':'Canada','PP':'Brazil','PR':'Brazil','PT':'Brazil',
    'EC':'Spain','HS':'Thailand','9M':'Malaysia','EP':'Iran','YI':'Iraq',
    'HZ':'Saudi Arabia','4X':'Israel','SX':'Greece','OE':'Austria','HB':'Switzerland',
    'SE':'Sweden','OH':'Finland','LN':'Norway','OY':'Denmark','PH':'Netherlands',
    'OO':'Belgium','CS':'Portugal','SP':'Poland','OK':'Czech Republic','HA':'Hungary',
    'YR':'Romania','LZ':'Bulgaria','EI':'Ireland','EW':'Belarus','ES':'Estonia',
    'YL':'Latvia','LY':'Lithuania','SU':'Egypt','AP':'Pakistan','CC':'Chile',
    'CN':'Morocco','CP':'Bolivia','CU':'Cuba','LV':'Argentina','LX':'Luxembourg',
    'OD':'Lebanon','P4':'Aruba','ST':'Sudan','TF':'Iceland','TJ':'Cameroon',
    'TL':'Central African Republic','TR':'Gabon','TS':'Tunisia','TT':'Chad',
    'TY':'Benin','TZ':'Mali','UK':'Uzbekistan','EK':'Armenia','EL':'Liberia',
    'EX':'Kyrgyzstan','EY':'Tajikistan','EZ':'Turkmenistan','S2':'Bangladesh',
    'XU':'Cambodia','XY':'Myanmar','ZK':'New Zealand','Z':'Zimbabwe',
    '4L':'Georgia','5A':'Libya','5N':'Nigeria','5T':'Mauritania','5X':'Uganda',
    '5Y':'Kenya','6V':'Senegal','7P':'Lesotho','7Q':'Malawi','7T':'Algeria',
    '9U':'Burundi','A2':'Botswana','9G':'Ghana','9J':'Zambia',
    'JU':'Mongolia','JY':'Jordan','OB':'Peru','RX':'Philippines','SY':'Greece',
  };

  if (registration) {
    let regCountry = null;
    if (REG_PREFIXES[registration.substring(0, 2)]) regCountry = REG_PREFIXES[registration.substring(0, 2)];
    else if (REG_PREFIXES[registration.substring(0, 1)]) regCountry = REG_PREFIXES[registration.substring(0, 1)];

    if (regCountry) {
      const cid = `country:${regCountry}`;
      nodes.push({ id: cid, label: regCountry, type: 'country', properties: { source: 'Registration prefix' } });
      links.push({ source: rootId, target: cid, label: 'REGISTERED IN' });
    }

    // FAA registry lookup for US N-number registrations
    if (registration.startsWith('N') && /^N\d/.test(registration)) {
      try {
        const faaUrl = `https://registry.faa.gov/api/1.0/aircraft/${encodeURIComponent(registration)}`;
        if (!ALLOWED_DOMAINS.has(new URL(faaUrl).hostname)) throw new Error('Blocked domain');
        const res = await fetch(faaUrl, { signal: AbortSignal.timeout(7000), headers: { Accept: 'application/json' } });
        if (res.ok) {
          const d = await res.json();
          if (d.manufacturer || d.name) {
            const ownerId = `company:${d.name || d.manufacturer}`;
            nodes.push({
              id: ownerId, label: d.name || d.manufacturer, type: 'company',
              properties: { manufacturer: d.manufacturer, model: d.model, year: d.year_mfr, engine: d.engine_type, source: 'FAA Registry' },
            });
            links.push({ source: rootId, target: ownerId, label: 'REGISTERED OWNER' });
          }
        }
      } catch (e) { console.warn('[INTEL] FAA registry error:', e.message); }
    }
  }

  // Step 3: ADSB.lol — live registration + type from ADS-B broadcast (ICAO24 hex)
  const icao24 = (properties.icao24 || '').toLowerCase();
  if (icao24) {
    try {
      const adsbUrl = `https://api.adsb.lol/v2/hex/${icao24}`;
      if (!ALLOWED_DOMAINS.has('api.adsb.lol')) throw new Error('blocked');
      const adsbRes = await fetch(adsbUrl, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': WIKIDATA_UA } });
      if (adsbRes.ok) {
        const d = await adsbRes.json();
        const ac = (d.ac || [])[0];
        if (ac) {
          const regFromAdsb = ac.r || '';
          const typecode = ac.t || '';
          if (regFromAdsb || typecode) {
            nodes.push({ id: rootId, label: id, type: 'aircraft', properties: {
              ...(regFromAdsb && !registration && { registration: regFromAdsb }),
              ...(typecode && { typecode }),
              source: 'ADSB.lol',
            }});
          }
          // Registration country from ADSB.lol ac.r prefix (fills gap if not in REG_PREFIXES)
          if (regFromAdsb && !registration) {
            const rc2 = REG_PREFIXES[regFromAdsb.substring(0, 2)] || REG_PREFIXES[regFromAdsb.substring(0, 1)];
            if (rc2 && !nodes.find(n => n.type === 'country' && n.label === rc2)) {
              const cid = `country:${rc2}`;
              nodes.push({ id: cid, label: rc2, type: 'country', properties: { source: 'ADSB.lol' } });
              links.push({ source: rootId, target: cid, label: 'REGISTERED IN' });
            }
          }
        }
      }
    } catch (e) { console.warn('[INTEL] ADSB.lol error:', e.message); }
  }

  // Step 4: Add aircraft model info
  if (model) {
    const mid = `aircraft:model:${model}`;
    nodes.push({ id: mid, label: model, type: 'aircraft', properties: { type: 'model', source: 'ADS-B' } });
    links.push({ source: rootId, target: mid, label: 'AIRCRAFT TYPE' });
  }

  // Step 5: Wikipedia — useful for airlines and notable aircraft types
  const wikiTerm = airlineName || (model ? `${model} aircraft` : null);
  if (wikiTerm) {
    try {
      const wiki = await fetchWikipedia(wikiTerm);
      if (wiki?.extract) nodes.push({ id: rootId, label: id, type: 'aircraft', properties: { intel_brief: wiki.extract, source: 'Wikipedia' } });
    } catch (e) { console.warn('[INTEL] Wikipedia aircraft error:', e.message); }
  }

  // Step 6: Cross-ref sanctions on airline name + callsign
  addSanctionsToGraph(callsign, rootId, nodes, links);
  if (airlineName) addSanctionsToGraph(airlineName, rootId, nodes, links);
  if (registration) addSanctionsToGraph(registration, rootId, nodes, links);

  const result = dedup(nodes, links, rootId);
  wdCacheSet(cacheKey, result);
  return result;
}

// ─── GFW vessel identity lookup ────────────────────────────────────────────
// Returns the best-matching registryInfo entry for a vessel (by IMO, MMSI, or name).
// Covers shadow-fleet tankers and transshipment vessels with registeredOwner / owner.
async function fetchGFWVessel(name, imo, mmsi) {
  if (!GFW_API_KEY) return null;
  const query = imo || mmsi || name;
  if (!query) return null;
  try {
    const url = `https://gateway.api.globalfishingwatch.org/v3/vessels/search?query=${encodeURIComponent(query)}&datasets=public-global-vessel-identity:latest&limit=5`;
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${GFW_API_KEY}`, 'User-Agent': WIKIDATA_UA },
    });
    if (!r.ok) return null;
    const d = await r.json();
    for (const entry of (d.entries || [])) {
      for (const reg of (entry.registryInfo || [])) {
        if (imo  && reg.imo   === imo)                          return reg;
        if (mmsi && reg.ssvid === mmsi)                         return reg;
        if (name && reg.shipname?.toUpperCase() === name.toUpperCase()) return reg;
      }
    }
    return d.entries?.[0]?.registryInfo?.[0] || null;
  } catch { return null; }
}

// ─── FleetMon vessel API ────────────────────────────────────────────────────
// Free tier: 30 req/day per API key. Returns owner, operator, class society, dimensions.
// Register at fleetmon.com → My Account → API Access.
async function fetchFleetMon(imo) {
  if (!FLEETMON_API_USER || !FLEETMON_API_KEY || !imo) return null;
  try {
    const url = `https://www.fleetmon.com/api/p/personal-v2/vessel/${encodeURIComponent(imo)}/?format=json`;
    const creds = Buffer.from(`${FLEETMON_API_USER}:${FLEETMON_API_KEY}`).toString('base64');
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Basic ${creds}`, 'User-Agent': WIKIDATA_UA },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function resolveVessel(id, props = {}) {
  // When a vessel is clicked from the map, the id may be an IMO or MMSI number.
  // Normalize: if id is purely numeric, treat it as IMO (7 digits) or MMSI (9 digits)
  // and prefer the human-readable name from props.vesselName for text searches.
  const isNumeric = /^\d+$/.test(id);
  const hintImo  = props.imo  || (isNumeric && id.length <= 7 ? id : null);
  let   hintMmsi = props.mmsi || (isNumeric && id.length === 9 ? id : null);
  const searchName = props.vesselName || (isNumeric ? null : id);

  // Use name as display/cache key when available so the graph labels correctly
  const displayId = searchName || id;
  const rootId = `vessel:${displayId}`;
  const nodes = [], links = [];
  const cached = wdCacheGet(`vessel:${displayId}`);
  if (cached) return { ...cached };

  const sid = sanitizeId(displayId);
  let resolvedImo = hintImo || null;

  // Seed with AIS-layer data the map already carries — flag, ship type, destination.
  // These arrive instantly (no API call) and ensure every vessel shows at least its
  // known flag country even when all external lookups fail or return nothing.
  if (props.flag) {
    const flagLabel = CC[props.flag.toLowerCase()] || props.flag;
    const cid = `country:${flagLabel}`;
    nodes.push({ id: cid, label: flagLabel, type: 'country', properties: { source: 'AIS' } });
    links.push({ source: rootId, target: cid, label: 'FLAG STATE' });
  }
  // Always seed the root vessel node — later blocks may overwrite with richer data
  // but this ensures the vessel appears even when every API call fails.
  const aisProps = { source: 'AIS' };
  if (props.ship_type)   aisProps.vessel_type  = props.ship_type;
  if (props.destination) aisProps.destination  = props.destination;
  if (props.call_sign)   aisProps.call_sign    = props.call_sign;
  nodes.push({ id: rootId, label: displayId, type: 'vessel', properties: aisProps });

  try {
    // wdSearch returns up to 3 QIDs. Build a VALUES clause with all of them, but constrain to
    // ship class (Q11446) in the same SPARQL — if a QID is a city, the join fails and only
    // the label/IMO branches produce results.
    const qids = searchName ? await wdSearch(searchName) : [];
    const qidFilter = qids.length
      ? `{ VALUES ?item { ${qids.map(q => `wd:${q}`).join(' ')} } . ?item wdt:P31/wdt:P279* wd:Q11446 . } UNION `
      : '';
    // Include IMO-number branch when we have a hint so Wikidata can find the vessel by IMO
    const imoFilter = resolvedImo ? `{ ?item wdt:P458 "${resolvedImo}" . } UNION ` : '';
    const filter = `${qidFilter}${imoFilter}{ ?item wdt:P458 "${sid}" . } UNION { ?item rdfs:label "${sid}"@en . ?item wdt:P31/wdt:P279* wd:Q11446 . } UNION { ?item skos:altLabel "${sid}"@en . ?item wdt:P31/wdt:P279* wd:Q11446 . }`;

    const results = await sparql(`
      SELECT ?item ?itemLabel ?ownerLabel ?ownerCountryLabel ?countryLabel
             ?operatorLabel ?operatorCountryLabel ?flagLabel ?classSocietyLabel
             ?imoNumber ?mmsi ?grossTonnage ?builtYear ?vesselTypeLabel ?length ?beam WHERE {
        ${filter}
        OPTIONAL { ?item wdt:P127 ?owner .
                   OPTIONAL { ?owner wdt:P17 ?ownerCountry . } }
        OPTIONAL { ?item wdt:P17 ?country . }
        OPTIONAL { ?item wdt:P137 ?operator .
                   OPTIONAL { ?operator wdt:P17 ?operatorCountry . } }
        OPTIONAL { ?item wdt:P8047 ?flag . }
        OPTIONAL { ?item wdt:P3455 ?classSociety . }
        OPTIONAL { ?item wdt:P458 ?imoNumber . }
        OPTIONAL { ?item wdt:P587 ?mmsi . }
        OPTIONAL { ?item wdt:P1093 ?grossTonnage . }
        OPTIONAL { ?item wdt:P571 ?builtYear . }
        OPTIONAL { ?item wdt:P31 ?vesselType . }
        OPTIONAL { ?item wdt:P2043 ?length . }
        OPTIONAL { ?item wdt:P2049 ?beam . }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
      } LIMIT 10`);

    let vesselPropsSet = false;
    for (const r of results) {
      if (!vesselPropsSet) {
        const props = { source: 'Wikidata' };
        if (r.imoNumber?.value)       { props.imo           = r.imoNumber.value; resolvedImo = r.imoNumber.value; }
        if (r.mmsi?.value)            { props.mmsi          = r.mmsi.value; if (!hintMmsi) hintMmsi = r.mmsi.value; }
        if (r.grossTonnage?.value)      props.gross_tonnage = r.grossTonnage.value;
        if (r.builtYear?.value)         props.year_built    = r.builtYear.value.substring(0, 4);
        if (r.vesselTypeLabel?.value)   props.vessel_type   = r.vesselTypeLabel.value;
        if (r.length?.value)            props.length_m      = r.length.value;
        if (r.beam?.value)              props.beam_m        = r.beam.value;
        nodes.push({ id: rootId, label: id, type: 'vessel', properties: props });
        vesselPropsSet = true;
      }
      if (r.ownerLabel?.value) {
        const oid = `company:${r.ownerLabel.value}`;
        nodes.push({ id: oid, label: r.ownerLabel.value, type: 'company', properties: { source: 'Wikidata' } });
        links.push({ source: rootId, target: oid, label: 'OWNED BY' });
        if (r.ownerCountryLabel?.value) {
          const cid = `country:${r.ownerCountryLabel.value}`;
          nodes.push({ id: cid, label: r.ownerCountryLabel.value, type: 'country', properties: { source: 'Wikidata' } });
          links.push({ source: oid, target: cid, label: 'HQ' });
        }
      }
      const flag = r.flagLabel?.value || r.countryLabel?.value;
      if (flag) {
        const cid = `country:${flag}`;
        nodes.push({ id: cid, label: flag, type: 'country', properties: { source: 'Wikidata' } });
        links.push({ source: rootId, target: cid, label: 'FLAG STATE' });
      }
      if (r.operatorLabel?.value) {
        const oid = `company:${r.operatorLabel.value}`;
        nodes.push({ id: oid, label: r.operatorLabel.value, type: 'company', properties: { source: 'Wikidata' } });
        links.push({ source: rootId, target: oid, label: 'OPERATED BY' });
        if (r.operatorCountryLabel?.value) {
          const cid = `country:${r.operatorCountryLabel.value}`;
          nodes.push({ id: cid, label: r.operatorCountryLabel.value, type: 'country', properties: { source: 'Wikidata' } });
          links.push({ source: oid, target: cid, label: 'HQ' });
        }
      }
      if (r.classSocietyLabel?.value) {
        const csid = `company:${r.classSocietyLabel.value}`;
        nodes.push({ id: csid, label: r.classSocietyLabel.value, type: 'company', properties: { source: 'Wikidata' } });
        links.push({ source: rootId, target: csid, label: 'CLASSED BY' });
      }
    }
  } catch (e) { console.warn('[INTEL] Wikidata vessel error:', e.message); }

  // OpenSanctions entity API — structured data the bulk CSV doesn't carry.
  // Try by IMO first; always fall through to name search so Wikidata IMO mismatch
  // (different ship with same name) doesn't silently suppress the sanctioned entity.
  try {
    let osEntity = null;
    // OS stores IMO as "IMO9312884" — try prefixed form first, then bare
    if (resolvedImo) osEntity = await opensanctionsByProp('Vessel', 'imoNumber', `IMO${resolvedImo}`);
    if (!osEntity && resolvedImo) osEntity = await opensanctionsByProp('Vessel', 'imoNumber', resolvedImo);
    if (!osEntity && hintMmsi) osEntity = await opensanctionsByProp('Vessel', 'mmsi', hintMmsi);
    if (!osEntity && searchName) osEntity = await opensanctionsSearch(searchName, 'Vessel');
    if (!osEntity && !searchName) osEntity = await opensanctionsSearch(id, 'Vessel');

    if (osEntity) {
      const p = osEntity.properties || {};

      // Normalize IMO: OpenSanctions stores "IMO9312884", strip the prefix
      const osImo = (p.imoNumber?.[0] || '').replace(/^IMO/i, '');
      const mmsis = (p.mmsi || []).join(', ');
      const callSigns = (p.callSign || []).join(', ');
      const vesselType = (p.type || []).find(t => !t.includes('|')) || p.type?.[0];
      const builtYear = p.buildDate?.[0];
      const tonnage = p.tonnage?.[0];
      const dwt = p.deadweightTonnage?.[0];
      const prevNames = (p.previousName || []).join('; ');
      const description = p.description?.[0]?.slice(0, 300);
      const programs = (p.programId || []).join(', ');
      const topics = (p.topics || []).join(', ');

      // Enrich root vessel node with OS structured properties
      nodes.push({
        id: rootId, label: id, type: 'vessel',
        properties: {
          ...(osImo      && { imo: osImo }),
          ...(mmsis      && { mmsi: mmsis }),
          ...(callSigns  && { call_sign: callSigns }),
          ...(vesselType && { vessel_type: vesselType }),
          ...(builtYear  && { year_built: builtYear }),
          ...(tonnage    && { gross_tonnage: tonnage }),
          ...(dwt        && { dwt }),
          ...(prevNames  && { previous_names: prevNames }),
          ...(programs   && { sanction_programs: programs }),
          ...(topics     && { topics }),
          ...(description && { description }),
          source: 'OpenSanctions',
        },
      });

      // Flag states (current + past) — resolve ISO code to full name via module-level CC map
      for (const code of [...new Set(p.flag || [])]) {
        const label = CC[code] || code.toUpperCase();
        const cid = `country:${label}`;
        nodes.push({ id: cid, label, type: 'country', properties: { code, source: 'OpenSanctions' } });
        links.push({ source: rootId, target: cid, label: 'FLAG STATE' });
      }
      for (const code of [...new Set(p.pastFlags || [])]) {
        const label = CC[code] || code.toUpperCase();
        const cid = `country:${label}`;
        nodes.push({ id: cid, label, type: 'country', properties: { code, source: 'OpenSanctions' } });
        links.push({ source: rootId, target: cid, label: 'PAST FLAG' });
      }

      // Owner / operator
      for (const owner of (p.owner || [])) {
        const oid = `company:${owner}`;
        nodes.push({ id: oid, label: owner, type: 'company', properties: { source: 'OpenSanctions' } });
        links.push({ source: rootId, target: oid, label: 'OWNED BY' });
      }
      for (const op of (p.operator || [])) {
        const oid = `company:${op}`;
        nodes.push({ id: oid, label: op, type: 'company', properties: { source: 'OpenSanctions' } });
        links.push({ source: rootId, target: oid, label: 'OPERATED BY' });
      }

      // Datasets the entity appears in
      const datasetList = (osEntity.datasets || []).join(', ');
      if (datasetList) {
        nodes.push({ id: rootId, label: id, type: 'vessel', properties: { sanctions_datasets: datasetList, source: 'OpenSanctions' } });
      }

      // Fetch adjacent entities to get structured owner/operator relationships.
      // The adjacent API expands inline entity objects (owner → Company with caption + topics).
      if (OPENSANCTIONS_API_KEY && osEntity.id) {
        try {
          const adjUrl = `https://api.opensanctions.org/entities/${osEntity.id}/adjacent`;
          if (ALLOWED_DOMAINS.has(new URL(adjUrl).hostname)) {
            const adjRes = await fetch(adjUrl, {
              signal: AbortSignal.timeout(8000),
              headers: { Authorization: `ApiKey ${OPENSANCTIONS_API_KEY}`, Accept: 'application/json', 'User-Agent': WIKIDATA_UA },
            });
            if (adjRes.ok) {
              const adj = await adjRes.json();
              const adjacent = adj.adjacent || {};
              // ownershipAsset: inline 'owner' entity objects
              for (const rel of (adjacent.ownershipAsset?.results || [])) {
                for (const ownerObj of [rel.properties?.owner].flat().filter(o => o && typeof o === 'object')) {
                  const name = ownerObj.caption || ownerObj.properties?.name?.[0];
                  if (!name) continue;
                  const type = ownerObj.schema === 'Person' ? 'person' : 'company';
                  const eid = `${type}:${name}`;
                  const role = rel.properties?.role?.[0] || 'owner';
                  nodes.push({ id: eid, label: name, type, properties: { source: 'OpenSanctions', topics: (ownerObj.properties?.topics || []).join(', ') || undefined } });
                  links.push({ source: rootId, target: eid, label: role === 'owner' ? 'OWNED BY' : role.toUpperCase() });
                  for (const cc of (ownerObj.properties?.country || [])) linkCountry(cc, eid, nodes, links);
                  addSanctionsToGraph(name, rootId, nodes, links);
                  if (type === 'company') await fetchOsDirectors(ownerObj.id, eid, nodes, links);
                }
              }
              for (const rel of (adjacent.operationalRelationshipAsset?.results || [])) {
                for (const opObj of [rel.properties?.operator].flat().filter(o => o && typeof o === 'object')) {
                  const name = opObj.caption || opObj.properties?.name?.[0];
                  if (!name) continue;
                  const type = opObj.schema === 'Person' ? 'person' : 'company';
                  const eid = `${type}:${name}`;
                  nodes.push({ id: eid, label: name, type, properties: { source: 'OpenSanctions', topics: (opObj.properties?.topics || []).join(', ') || undefined } });
                  links.push({ source: rootId, target: eid, label: 'OPERATED BY' });
                  for (const cc of (opObj.properties?.country || [])) linkCountry(cc, eid, nodes, links);
                  addSanctionsToGraph(name, rootId, nodes, links);
                }
              }
            }
          }
        } catch (e) { console.warn('[INTEL] OpenSanctions adjacent error:', e.message); }
      }
    }
  } catch (e) { console.warn('[INTEL] OpenSanctions vessel error:', e.message); }

  // FtM offline graph — structured ownership chains from ua_war_sanctions
  // (works without API key, no rate limit, runs in background at startup)
  const ftmKey = resolvedImo ? `IMO${resolvedImo}` : null;
  const ftmVessel = (ftmKey && ftmVesselByImo.get(ftmKey))
    || (hintMmsi && ftmVesselByMmsi.get(hintMmsi))
    || (searchName && ftmVesselByName.get(searchName.toUpperCase()));
  if (ftmVessel) {
    const fp = ftmVessel.properties || {};
    // Include first 2 sentences of the UA-WAR intelligence brief as a node property
    const desc = (fp.description || [])[0] || '';
    const brief = desc.replace(/\s+/g, ' ').split(/(?<=\.)\s+/).slice(0, 2).join(' ');
    if (brief) nodes.push({ id: rootId, label: displayId, type: 'vessel', properties: { intel_brief: brief.slice(0, 400), source: 'UA-WAR-SANCTIONS' } });
    // Flag states from FtM
    for (const code of [...new Set([...(fp.flag || []), ...(fp.pastFlags || [])])]) {
      const label = CC[code.toLowerCase()] || code.toUpperCase();
      const cid = `country:${label}`;
      nodes.push({ id: cid, label, type: 'country', properties: { code, source: 'UA-WAR-SANCTIONS' } });
      links.push({ source: rootId, target: cid, label: (fp.flag || []).includes(code) ? 'FLAG STATE' : 'PAST FLAG' });
    }
    // Structured Ownership edges
    const ownerships = ftmOwnershipByAsset.get(ftmVessel.id) || [];
    for (const own of ownerships) {
      const op = own.properties || {};
      for (const ownerId of (op.owner || [])) {
        const ownerEnt = ftmById.get(ownerId);
        if (!ownerEnt) continue;
        const oName = (ownerEnt.properties?.name || [])[0];
        if (!oName) continue;
        const isOrg = ownerEnt.schema !== 'Person';
        const eid  = isOrg ? `company:${oName}` : `person:${oName}`;
        const etype = isOrg ? 'company' : 'person';
        const country = (ownerEnt.properties?.country || [])[0];
        nodes.push({ id: eid, label: oName, type: etype, properties: { source: 'UA-WAR-SANCTIONS', ...(country && { country }) } });
        links.push({ source: rootId, target: eid, label: (op.role || [])[0]?.toUpperCase() || 'OWNED BY' });
        if (country) linkCountry(country, eid, nodes, links, isOrg ? 'BASED IN' : 'NATIONALITY');
        addSanctionsToGraph(oName, eid, nodes, links);
      }
    }
  }

  // MMSI prefix → registration country (offline MID table — works for any MMSI vessel)
  if (hintMmsi) {
    const mmsiCountry = mmsiToCountry(hintMmsi);
    if (mmsiCountry) {
      const cid = `country:${mmsiCountry}`;
      nodes.push({ id: cid, label: mmsiCountry, type: 'country', properties: { source: 'MMSI MID' } });
      links.push({ source: rootId, target: cid, label: 'MMSI REGISTRY' });
    }
  }

  // Wikipedia — notable ships (naval vessels, cruise ships, famous commercial ships).
  // Strict title check: the returned article title must contain at least the first word
  // of the vessel name (≥4 chars) to avoid false positives like "Chinese treasure ship"
  // appearing for a search of "XIN XIA MEN ship".
  if (searchName) {
    try {
      const wiki = await fetchWikipedia(`${searchName} ship`);
      if (wiki?.extract) {
        const firstWord = searchName.toLowerCase().split(/\s+/)[0];
        const titleLower = wiki.title.toLowerCase();
        const titleMatch = firstWord.length >= 4 && titleLower.includes(firstWord);
        if (titleMatch) {
          nodes.push({ id: rootId, label: displayId, type: 'vessel', properties: { intel_brief: wiki.extract, source: 'Wikipedia' } });
        }
      }
    } catch (e) { console.warn('[INTEL] Wikipedia vessel error:', e.message); }
  }

  // Global Fishing Watch — vessel identity with registeredOwner / owner.
  // Best coverage for shadow-fleet tankers, transshipment, and fishing vessels.
  // Set GFW_API_KEY env var (free at globalfishingwatch.org/data-download/).
  try {
    const gfw = await fetchGFWVessel(searchName, resolvedImo, hintMmsi);
    if (gfw) {
      // Prefer registeredOwner; fall back to owner; skip if identical to an existing node
      const ownerName = gfw.registeredOwner?.trim() || gfw.owner?.trim();
      if (ownerName) {
        const oid = `company:${ownerName}`;
        nodes.push({ id: oid, label: ownerName, type: 'company', properties: { source: 'GFW' } });
        links.push({ source: rootId, target: oid, label: gfw.registeredOwner ? 'REGISTERED OWNER' : 'OPERATED BY' });
      }
      // Fill in identifiers not yet known from AIS
      if (!resolvedImo && gfw.imo)   resolvedImo = gfw.imo;
      if (!hintMmsi  && gfw.ssvid)   hintMmsi    = gfw.ssvid;
      if (!hintMmsi  && gfw.mmsi)    hintMmsi    = gfw.mmsi;
      // Physical dimensions if not already set by Wikidata
      const dimProps = {};
      if (gfw.lengthM    && !nodes.find(n => n.id === rootId && n.properties?.length_m))  dimProps.length_m      = Math.round(gfw.lengthM);
      if (gfw.tonnageGt  && !nodes.find(n => n.id === rootId && n.properties?.gross_tonnage)) dimProps.gross_tonnage = Math.round(gfw.tonnageGt);
      if (gfw.callsign)  dimProps.call_sign = gfw.callsign;
      if (Object.keys(dimProps).length) nodes.push({ id: rootId, label: displayId, type: 'vessel', properties: { ...dimProps, source: 'GFW' } });
    }
  } catch (e) { console.warn('[INTEL] GFW vessel error:', e.message); }

  // FleetMon — commercial vessel details by IMO (free 30 req/day).
  // Set FLEETMON_API_USER + FLEETMON_API_KEY env vars (register at fleetmon.com).
  if (resolvedImo) {
    try {
      const fm = await fetchFleetMon(resolvedImo);
      if (fm) {
        for (const [field, label] of [['owner', 'OWNED BY'], ['operator', 'OPERATED BY']]) {
          const name = fm[field]?.trim();
          if (name) {
            const oid = `company:${name}`;
            nodes.push({ id: oid, label: name, type: 'company', properties: { source: 'FleetMon' } });
            links.push({ source: rootId, target: oid, label });
          }
        }
        if (fm.class_society?.trim()) {
          const csid = `company:${fm.class_society}`;
          nodes.push({ id: csid, label: fm.class_society, type: 'company', properties: { source: 'FleetMon' } });
          links.push({ source: rootId, target: csid, label: 'CLASSED BY' });
        }
        const fmProps = {};
        if (fm.gross_tonnage)   fmProps.gross_tonnage = fm.gross_tonnage;
        if (fm.year_of_build)   fmProps.year_built    = fm.year_of_build;
        if (fm.length)          fmProps.length_m      = fm.length;
        if (fm.beam)            fmProps.beam_m        = fm.beam;
        if (fm.type_of_vessel)  fmProps.vessel_type   = fm.type_of_vessel;
        if (Object.keys(fmProps).length) nodes.push({ id: rootId, label: displayId, type: 'vessel', properties: { ...fmProps, source: 'FleetMon' } });
      }
    } catch (e) { console.warn('[INTEL] FleetMon vessel error:', e.message); }
  }

  if (searchName) addSanctionsToGraph(searchName, rootId, nodes, links);
  addSanctionsToGraph(displayId, rootId, nodes, links);
  const result = dedup(nodes, links, rootId);
  wdCacheSet(`vessel:${displayId}`, result);
  return result;
}

// ─── GLEIF LEI lookup ───────────────────────────────────────────────────────
// Returns { lei, legalName, country, parentLei, parentName, parentCountry } or null.
// Truly keyless. Useful for finding a company's incorporation country and parent chain.
// The old fuzzycompanySearch endpoint was deprecated; this uses the current filter API.
async function fetchGLEIF(companyName) {
  try {
    const url = `https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=${encodeURIComponent(companyName)}&page[size]=1`;
    if (!ALLOWED_DOMAINS.has('api.gleif.org')) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': WIKIDATA_UA } });
    if (!r.ok) return null;
    const d = await r.json();
    const rec = d.data?.[0];
    if (!rec) return null;
    const ent = rec.attributes?.entity || {};
    const result = {
      lei:     rec.id,
      legalName: ent.legalName?.name,
      country: ent.legalAddress?.country,
      status:  ent.status,
    };
    // Follow the direct-parent relationship link when present
    const parentLink = d.data?.[0]?.relationships?.['direct-parent']?.links?.related;
    if (parentLink && ALLOWED_DOMAINS.has(new URL(parentLink).hostname)) {
      try {
        const pr = await fetch(parentLink, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': WIKIDATA_UA } });
        if (pr.ok) {
          const pd = await pr.json();
          const pRec = pd.data?.[0];
          if (pRec) {
            result.parentLei     = pRec.id;
            result.parentName    = pRec.attributes?.entity?.legalName?.name;
            result.parentCountry = pRec.attributes?.entity?.legalAddress?.country;
          }
        }
      } catch { /* parent fetch is best-effort */ }
    }
    return result;
  } catch { return null; }
}

// ─── Companies House UK officers ────────────────────────────────────────────
// Free API key (register at developer.company-information.service.gov.uk).
// Returns active officers for a UK company number.
async function fetchCompaniesHouseOfficers(companyNumber) {
  if (!COMPANIES_HOUSE_KEY) return null;
  try {
    const url = `https://api.company-information.service.gov.uk/company/${encodeURIComponent(companyNumber)}/officers`;
    if (!ALLOWED_DOMAINS.has(new URL(url).hostname)) return null;
    const creds = Buffer.from(`${COMPANIES_HOUSE_KEY}:`).toString('base64');
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Basic ${creds}`, 'User-Agent': WIKIDATA_UA },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function resolveCompany(id) {
  const rootId = `company:${id}`;
  const nodes = [], links = [];
  const cached = wdCacheGet(`company:${id}`);
  if (cached) return { ...cached };

  const cSid = sanitizeId(id);
  try {
    const qids = await wdSearch(id);
    // When we have QIDs from the search API, query by VALUES — no type filter needed
    // (the API already matched the label). Only fall back to the slow transitive type
    // constraint when the search API returns nothing.
    const filter = qids.length
      ? `VALUES ?item { ${qids.map(q => `wd:${q}`).join(' ')} }`
      : `{ ?item rdfs:label "${cSid}"@en . ?item wdt:P31 ?t . FILTER(?t IN (wd:Q4830453, wd:Q43229, wd:Q891723, wd:Q6881511)) }`;
    const results = await sparql(`
      SELECT ?item ?itemLabel ?countryLabel ?parentLabel ?ceoLabel ?chairLabel
             ?boardMemberLabel ?directorLabel ?founderLabel ?ownerLabel WHERE {
        ${filter}
        OPTIONAL { ?item wdt:P17  ?country . }
        OPTIONAL { ?item wdt:P749 ?parent . }
        OPTIONAL { ?item wdt:P169 ?ceo . }
        OPTIONAL { ?item wdt:P488 ?chair . }
        OPTIONAL { ?item wdt:P3320 ?boardMember . }
        OPTIONAL { ?item wdt:P1037 ?director . }
        OPTIONAL { ?item wdt:P112  ?founder . }
        OPTIONAL { ?item wdt:P127 ?owner . }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
      } LIMIT 12`);
    const seenPeople = new Set();
    for (const r of results) {
      if (r.countryLabel?.value) {
        const cid = `country:${r.countryLabel.value}`;
        nodes.push({ id: cid, label: r.countryLabel.value, type: 'country', properties: { source: 'Wikidata' } });
        links.push({ source: rootId, target: cid, label: 'HEADQUARTERED' });
      }
      if (r.parentLabel?.value) {
        const pid = `company:${r.parentLabel.value}`;
        nodes.push({ id: pid, label: r.parentLabel.value, type: 'company', properties: { source: 'Wikidata' } });
        links.push({ source: rootId, target: pid, label: 'PARENT ORG' });
      }
      if (r.ownerLabel?.value) {
        const pid = `company:${r.ownerLabel.value}`;
        nodes.push({ id: pid, label: r.ownerLabel.value, type: 'company', properties: { source: 'Wikidata' } });
        links.push({ source: rootId, target: pid, label: 'OWNED BY' });
      }
      for (const [roleKey, roleLabel] of [
        ['ceoLabel','CEO'], ['chairLabel','CHAIRPERSON'],
        ['boardMemberLabel','BOARD MEMBER'], ['directorLabel','DIRECTOR'], ['founderLabel','FOUNDER'],
      ]) {
        const name = r[roleKey]?.value;
        if (name && !seenPeople.has(name)) {
          seenPeople.add(name);
          const pid = `person:${name}`;
          nodes.push({ id: pid, label: name, type: 'person', properties: { role: roleLabel, source: 'Wikidata' } });
          links.push({ source: rootId, target: pid, label: roleLabel });
        }
      }
    }

    // Reverse P108 lookup: find Wikidata persons whose employer is this company.
    // Uses the same QIDs we already found — only runs when the company is in Wikidata.
    if (qids.length > 0) {
      try {
        const empResults = await sparql(`
          SELECT DISTINCT ?personLabel WHERE {
            VALUES ?co { ${qids.map(q => `wd:${q}`).join(' ')} }
            ?person wdt:P108 ?co .
            ?person wdt:P31 wd:Q5 .
            SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
          } LIMIT 8`);
        for (const r of empResults) {
          const name = r.personLabel?.value;
          if (name && !seenPeople.has(name)) {
            seenPeople.add(name);
            const pid = `person:${name}`;
            nodes.push({ id: pid, label: name, type: 'person', properties: { role: 'employee', source: 'Wikidata' } });
            links.push({ source: rootId, target: pid, label: 'EMPLOYEE' });
          }
        }
      } catch { /* silent — reverse lookup is best-effort */ }
    }
  } catch (e) { console.warn('[INTEL] Wikidata company error:', e.message); }

  // OpenSanctions entity search — structured data including registration numbers, addresses,
  // incorporation dates, and sanctions designations not in the simple CSV
  try {
    const osEntity = await opensanctionsSearch(id, 'Company');
    if (osEntity) {
      const props = osEntity.properties || {};
      const country = props.country?.[0] || props.jurisdiction?.[0];
      const regNum = props.registrationNumber?.[0];
      const addr = props.address?.[0];
      if (country || regNum || addr) {
        nodes.push({ id: rootId, label: id, type: 'company', properties: {
          ...(regNum  && { registration_number: regNum }),
          ...(addr    && { registered_address: addr.slice(0, 150) }),
          source: 'OpenSanctions',
        }});
      }
      if (country) linkCountry(country, rootId, nodes, links, 'BASED IN');
      for (const name of (osEntity.properties?.name || []).slice(1, 4)) {
        nodes.push({ id: `company:${name}`, label: name, type: 'company', properties: { source: 'OpenSanctions' } });
        links.push({ source: rootId, target: `company:${name}`, label: 'AKA' });
      }
      await fetchOsDirectors(osEntity.id, rootId, nodes, links);
    }
  } catch (e) { console.warn('[INTEL] OpenSanctions company error:', e.message); }

  // OpenCorporates — search returns basic info; officers require a separate detail fetch.
  // Free tier: 500 req/day. We use 2 requests per company (search + detail).
  try {
    const ocUrl = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(id)}&format=json&per_page=1`;
    if (!ALLOWED_DOMAINS.has(new URL(ocUrl).hostname)) throw new Error('Blocked domain');
    const res = await fetch(ocUrl, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': WIKIDATA_UA } });
    if (res.ok) {
      const json = await res.json();
      const co = json.results?.companies?.[0]?.company;
      if (co) {
        const jur = co.jurisdiction_code || '';
        const num = co.company_number || '';
        nodes.push({
          id: rootId, label: id, type: 'company',
          properties: {
            jurisdiction: jur,
            company_number: num,
            company_type: co.company_type,
            status: co.current_status,
            incorporation_date: co.incorporation_date,
            registered_address: co.registered_address_in_full,
            source: 'OpenCorporates',
          },
        });
        // Country from jurisdiction code (e.g. "ru" → Russia, "gb" → United Kingdom)
        if (jur) {
          const jurCountry = jur.split('_')[0]; // "gb_england-wales" → "gb"
          linkCountry(jurCountry, rootId, nodes, links, 'BASED IN');
        }
        // Officers are NOT in search results — fetch company detail endpoint
        if (jur && num) {
          const detailUrl = `https://api.opencorporates.com/v0.4/companies/${jur}/${num}`;
          const dRes = await fetch(detailUrl, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': WIKIDATA_UA } });
          if (dRes.ok) {
            const dJson = await dRes.json();
            for (const o of (dJson.results?.company?.officers || []).slice(0, 8)) {
              const off = o.officer;
              if (!off?.name) continue;
              const pid = `person:${off.name}`;
              const role = off.position || 'Officer';
              nodes.push({ id: pid, label: off.name, type: 'person', properties: { role, source: 'OpenCorporates', ...(off.nationality && { nationality: off.nationality }) } });
              links.push({ source: rootId, target: pid, label: role.toUpperCase() });
              if (off.nationality) linkCountry(off.nationality.slice(0, 2).toLowerCase(), pid, nodes, links, 'NATIONALITY');
            }
          }
          // Companies House — UK-only, free API key, more complete/current than OpenCorporates
          if (jur.startsWith('gb')) {
            const chData = await fetchCompaniesHouseOfficers(num);
            for (const item of (chData?.items || []).filter(i => !i.resigned_on).slice(0, 10)) {
              if (!item.name) continue;
              const pid = `person:${item.name}`;
              const role = item.officer_role || 'Officer';
              nodes.push({ id: pid, label: item.name, type: 'person', properties: { role, source: 'Companies House' } });
              links.push({ source: rootId, target: pid, label: role.replace(/_/g, ' ').toUpperCase() });
              if (item.nationality) linkCountry(item.nationality.slice(0, 2).toLowerCase(), pid, nodes, links, 'NATIONALITY');
            }
          }
        }
      }
    }
  } catch (e) { console.warn('[INTEL] OpenCorporates error:', e.message); }

  // GLEIF LEI — incorporation country + direct parent company chain (keyless).
  // Most useful for shell companies and holding structures in the shadow fleet.
  try {
    const gleif = await fetchGLEIF(id);
    if (gleif?.lei) {
      const gleifProps = { lei: gleif.lei, source: 'GLEIF' };
      if (gleif.status) gleifProps.status = gleif.status;
      nodes.push({ id: rootId, label: id, type: 'company', properties: gleifProps });
      if (gleif.country) {
        const cname = CC[gleif.country.toLowerCase()] || gleif.country;
        const cid = `country:${cname}`;
        nodes.push({ id: cid, label: cname, type: 'country', properties: { source: 'GLEIF' } });
        links.push({ source: rootId, target: cid, label: 'INCORPORATED IN' });
      }
      if (gleif.parentName) {
        const pid = `company:${gleif.parentName}`;
        nodes.push({ id: pid, label: gleif.parentName, type: 'company', properties: { source: 'GLEIF', lei: gleif.parentLei } });
        links.push({ source: rootId, target: pid, label: 'PARENT ORG' });
        if (gleif.parentCountry) {
          const cname = CC[gleif.parentCountry.toLowerCase()] || gleif.parentCountry;
          const cid = `country:${cname}`;
          nodes.push({ id: cid, label: cname, type: 'country', properties: { source: 'GLEIF' } });
          links.push({ source: pid, target: cid, label: 'INCORPORATED IN' });
        }
      }
    }
  } catch (e) { console.warn('[INTEL] GLEIF error:', e.message); }

  // FtM offline lookup — ua_war_sanctions has structured company → country + director edges
  const ftmCo = ftmCompanyByName.get(id.toUpperCase());
  if (ftmCo) {
    const fp = ftmCo.properties || {};
    const country = (fp.country || fp.jurisdiction || [])[0];
    if (country) linkCountry(country, rootId, nodes, links, 'BASED IN');
    const regNum = (fp.registrationNumber || fp.innCode || fp.taxNumber || [])[0];
    const addr   = (fp.address || [])[0];
    if (regNum || addr) {
      nodes.push({ id: rootId, label: id, type: 'company', properties: {
        ...(regNum && { registration_number: regNum }),
        ...(addr   && { registered_address: addr.slice(0, 150) }),
        source: 'UA-WAR-SANCTIONS',
      }});
    }
    for (const dir of (ftmDirByOrg.get(ftmCo.id) || [])) {
      const dp   = dir.properties || {};
      const role = (dp.role || [])[0] || 'Director';
      for (const personId of (dp.director || [])) {
        const pEnt  = ftmById.get(personId);
        if (!pEnt) continue;
        const pName = (pEnt.properties?.name || [])[0];
        if (!pName) continue;
        const pid = `person:${pName}`;
        nodes.push({ id: pid, label: pName, type: 'person', properties: { role, source: 'UA-WAR-SANCTIONS' } });
        links.push({ source: rootId, target: pid, label: role.toUpperCase() });
        // ua_war_sanctions uses `citizenship` not `nationality`
        const pcc = (pEnt.properties?.citizenship || pEnt.properties?.nationality || pEnt.properties?.country || [])[0];
        if (pcc) linkCountry(pcc, pid, nodes, links, 'NATIONALITY');
        addSanctionsToGraph(pName, pid, nodes, links);
      }
    }
    // UnknownLink: company → vessel (shows what vessels this company operates)
    for (const lnk of (ftmUnknownBySubject.get(ftmCo.id) || [])) {
      for (const objId of (lnk.properties?.object || [])) {
        const objEnt = ftmById.get(objId);
        if (!objEnt || objEnt.schema !== 'Vessel') continue;
        const vName = (objEnt.properties?.name || [])[0];
        if (!vName) continue;
        const vid = `vessel:${vName}`;
        const imo  = (objEnt.properties?.imoNumber || [])[0];
        nodes.push({ id: vid, label: vName, type: 'vessel', properties: { source: 'UA-WAR-SANCTIONS', ...(imo && { imo }) } });
        links.push({ source: rootId, target: vid, label: 'OPERATES' });
      }
    }
  }

  // Wikipedia — description + extract for companies not in Wikidata or missing descriptions
  try {
    const wiki = await fetchWikipedia(id);
    if (wiki?.extract) nodes.push({ id: rootId, label: id, type: 'company', properties: { description: wiki.extract, source: 'Wikipedia' } });
  } catch (e) { console.warn('[INTEL] Wikipedia company error:', e.message); }

  addSanctionsToGraph(id, rootId, nodes, links);
  const result = dedup(nodes, links, rootId);
  wdCacheSet(`company:${id}`, result);
  return result;
}

async function resolvePerson(id) {
  const rootId = `person:${id}`;
  const nodes = [], links = [];
  const cached = wdCacheGet(`person:${id}`);
  if (cached) return { ...cached };

  const pSid = sanitizeId(id);
  try {
    const qids = await wdSearch(id);
    // Constrain QID branch to Q5 (human) — rejects same-named places, ships, companies
    const qidFilter = qids.length
      ? `{ VALUES ?item { ${qids.map(q => `wd:${q}`).join(' ')} } . ?item wdt:P31 wd:Q5 . } UNION `
      : '';
    const filter = `${qidFilter}{ ?item rdfs:label "${pSid}"@en . ?item wdt:P31 wd:Q5 . }`;
    const results = await sparql(`
      SELECT ?item ?itemLabel ?nationalityLabel ?employerLabel ?positionLabel ?birthLabel WHERE {
        ${filter}
        OPTIONAL { ?item wdt:P27 ?nationality . }
        OPTIONAL { ?item wdt:P108 ?employer . }
        OPTIONAL { ?item wdt:P39 ?position . }
        OPTIONAL { ?item wdt:P569 ?birth . }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
      } LIMIT 10`);
    for (const r of results) {
      if (r.nationalityLabel?.value) {
        const cid = `country:${r.nationalityLabel.value}`;
        nodes.push({ id: cid, label: r.nationalityLabel.value, type: 'country', properties: { source: 'Wikidata' } });
        links.push({ source: rootId, target: cid, label: 'NATIONALITY' });
      }
      if (r.employerLabel?.value) {
        const eid = `company:${r.employerLabel.value}`;
        nodes.push({ id: eid, label: r.employerLabel.value, type: 'company', properties: { source: 'Wikidata' } });
        links.push({ source: rootId, target: eid, label: 'EMPLOYER' });
      }
      if (r.positionLabel?.value) {
        const pid = `event:${r.positionLabel.value}`;
        nodes.push({ id: pid, label: r.positionLabel.value, type: 'event', properties: { source: 'Wikidata' } });
        links.push({ source: rootId, target: pid, label: 'POSITION HELD' });
      }
      if (r.birthLabel?.value) {
        nodes.push({ id: rootId, label: id, type: 'person', properties: { birth_date: r.birthLabel.value.substring(0, 10), source: 'Wikidata' } });
      }
    }
  } catch (e) { console.warn('[INTEL] Wikidata person error:', e.message); }

  // OpenSanctions entity search — birth date, nationality, aliases, designation date
  try {
    const osEntity = await opensanctionsSearch(id, 'Person');
    if (osEntity) {
      const props = osEntity.properties || {};
      const birthDate = props.birthDate?.[0];
      const nationality = props.nationality?.[0] || props.country?.[0];
      const passportNum = props.passportNumber?.[0];
      if (birthDate || passportNum) {
        nodes.push({ id: rootId, label: id, type: 'person', properties: {
          ...(birthDate    && { birth_date: birthDate }),
          ...(passportNum  && { passport_number: passportNum }),
          source: 'OpenSanctions',
        }});
      }
      if (nationality) linkCountry(nationality, rootId, nodes, links, 'NATIONALITY');
      for (const alias of (props.alias || []).slice(0, 4)) {
        nodes.push({ id: `person:${alias}`, label: alias, type: 'person', properties: { source: 'OpenSanctions' } });
        links.push({ source: rootId, target: `person:${alias}`, label: 'ALIAS' });
      }
    }
  } catch (e) { console.warn('[INTEL] OpenSanctions person error:', e.message); }

  // FtM offline lookup — Person entities from OFAC SDN (nationality/citizenship, position)
  // plus reverse Directorship edges to show which companies this person leads
  const ftmPerson = ftmPersonByName.get(id.toUpperCase());
  if (ftmPerson) {
    const fp = ftmPerson.properties || {};
    const cc = (fp.nationality || fp.citizenship || fp.country || [])[0];
    if (cc) linkCountry(cc, rootId, nodes, links, 'NATIONALITY');
    const position = (fp.position || [])[0];
    const birthDate = (fp.birthDate || [])[0];
    if (position || birthDate) {
      nodes.push({ id: rootId, label: id, type: 'person', properties: {
        ...(position  && { position }),
        ...(birthDate && { birth_date: birthDate }),
        source: 'OFAC/UA-WAR-SANCTIONS',
      }});
    }
    // Reverse Directorship lookup: find all organizations this person leads
    for (const dir of (ftmDirByDirector.get(ftmPerson.id) || [])) {
      const orgId = (dir.properties?.organization || [])[0];
      if (!orgId) continue;
      const orgEnt = ftmById.get(orgId);
      if (!orgEnt) continue;
      const orgName = (orgEnt.properties?.name || [])[0];
      if (!orgName) continue;
      const role = (dir.properties?.role || [])[0] || 'Director';
      const cid = `company:${orgName}`;
      nodes.push({ id: cid, label: orgName, type: 'company', properties: { source: 'OFAC/UA-WAR-SANCTIONS' } });
      links.push({ source: rootId, target: cid, label: role.toUpperCase() });
      addSanctionsToGraph(orgName, cid, nodes, links);
    }
  }

  // Wikipedia — biography for politicians, oligarchs, military commanders not in Wikidata
  try {
    const wiki = await fetchWikipedia(id);
    if (wiki?.description || wiki?.extract) {
      nodes.push({ id: rootId, label: id, type: 'person', properties: {
        ...(wiki.description && { role: wiki.description }),
        ...(wiki.extract    && { intel_brief: wiki.extract }),
        source: 'Wikipedia',
      }});
    }
  } catch (e) { console.warn('[INTEL] Wikipedia person error:', e.message); }

  addSanctionsToGraph(id, rootId, nodes, links);
  const result = dedup(nodes, links, rootId);
  wdCacheSet(`person:${id}`, result);
  return result;
}

async function resolveIP(id) {
  const rootId = `ip:${id}`;
  const nodes = [], links = [];
  const cached = wdCacheGet(`ip:${id}`);
  if (cached) return { ...cached };

  // Step 1: ip-api.com — geolocation, ISP, ASN, proxy/hosting detection
  try {
    const ipApiUrl = `http://ip-api.com/json/${encodeURIComponent(id)}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,mobile,proxy,hosting`;
    const parsed = new URL(ipApiUrl);
    if (!ALLOWED_DOMAINS.has(parsed.hostname)) throw new Error(`Blocked domain: ${parsed.hostname}`);
    const res = await fetch(ipApiUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      if (data.status === 'success') {
        // ISP node
        if (data.isp) {
          const ispId = `company:${data.isp}`;
          nodes.push({ id: ispId, label: data.isp, type: 'company', properties: { role: 'ISP', org: data.org || '', source: 'ip-api.com' } });
          links.push({ source: rootId, target: ispId, label: 'HOSTED_BY' });
          addSanctionsToGraph(data.isp, rootId, nodes, links);
        }

        // ASN node
        if (data.as) {
          const asLabel = data.asname || data.as;
          const asId = `company:${data.as}`;
          nodes.push({ id: asId, label: asLabel, type: 'company', properties: { as_number: data.as, source: 'ip-api.com' } });
          links.push({ source: rootId, target: asId, label: 'ASN' });
        }

        // Country node
        if (data.country) {
          const cid = `country:${data.country}`;
          nodes.push({ id: cid, label: data.country, type: 'country', properties: { code: data.countryCode || '', source: 'ip-api.com' } });
          links.push({ source: rootId, target: cid, label: 'LOCATED_IN' });
          addSanctionsToGraph(data.country, rootId, nodes, links);
        }

        // City node (as event type with lat/lng)
        if (data.city) {
          const cityId = `event:${data.city}`;
          nodes.push({
            id: cityId, label: data.city, type: 'event',
            properties: {
              lat: data.lat, lon: data.lon, region: data.regionName || '',
              zip: data.zip || '', timezone: data.timezone || '', source: 'ip-api.com',
            },
          });
          links.push({ source: rootId, target: cityId, label: 'GEOLOCATED' });
        }

        // Tag proxy/hosting/mobile flags on the root IP node
        nodes.push({
          id: rootId, label: id, type: 'ip',
          properties: {
            proxy: !!data.proxy, hosting: !!data.hosting, mobile: !!data.mobile,
            source: 'ip-api.com',
          },
        });
      }
    }
  } catch (e) { console.warn('[INTEL] ip-api.com error:', e.message); }

  // Step 2: RIPEstat WHOIS
  try {
    const whoisUrl = `https://stat.ripe.net/data/whois/data.json?resource=${encodeURIComponent(id)}`;
    const parsed = new URL(whoisUrl);
    if (!ALLOWED_DOMAINS.has(parsed.hostname)) throw new Error(`Blocked domain: ${parsed.hostname}`);
    const res = await fetch(whoisUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json();
      const records = json.data?.records || [];
      for (const record of records) {
        for (const field of record) {
          if (field.key === 'netname' || field.key === 'NetName') {
            const netId = `company:${field.value}`;
            nodes.push({ id: netId, label: field.value, type: 'company', properties: { role: 'Network', source: 'RIPEstat WHOIS' } });
            links.push({ source: rootId, target: netId, label: 'HOSTED_BY' });
          }
        }
      }
    }
  } catch (e) { console.warn('[INTEL] RIPEstat WHOIS error:', e.message); }

  // Step 3: RIPEstat Abuse Contact
  try {
    const abuseUrl = `https://stat.ripe.net/data/abuse-contact-finder/data.json?resource=${encodeURIComponent(id)}`;
    const parsed = new URL(abuseUrl);
    if (!ALLOWED_DOMAINS.has(parsed.hostname)) throw new Error(`Blocked domain: ${parsed.hostname}`);
    const res = await fetch(abuseUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json();
      const contacts = json.data?.abuse_contacts || [];
      for (const email of contacts) {
        if (email) {
          const eid = `person:${email}`;
          nodes.push({ id: eid, label: email, type: 'person', properties: { role: 'Abuse Contact', source: 'RIPEstat' } });
          links.push({ source: rootId, target: eid, label: 'ABUSE CONTACT' });
        }
      }
    }
  } catch (e) { console.warn('[INTEL] RIPEstat abuse-contact error:', e.message); }

  // Step 4: RIPEstat Network Info
  try {
    const netUrl = `https://stat.ripe.net/data/network-info/data.json?resource=${encodeURIComponent(id)}`;
    const parsed = new URL(netUrl);
    if (!ALLOWED_DOMAINS.has(parsed.hostname)) throw new Error(`Blocked domain: ${parsed.hostname}`);
    const res = await fetch(netUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json();
      const prefix = json.data?.prefix;
      const asns = json.data?.asns || [];
      if (prefix) {
        const prefId = `ip:${prefix}`;
        nodes.push({ id: prefId, label: prefix, type: 'ip', properties: { role: 'Prefix', source: 'RIPEstat' } });
        links.push({ source: rootId, target: prefId, label: 'PREFIX' });
      }
      for (const asn of asns) {
        const asnId = `company:AS${asn}`;
        nodes.push({ id: asnId, label: `AS${asn}`, type: 'company', properties: { as_number: `AS${asn}`, source: 'RIPEstat' } });
        links.push({ source: rootId, target: asnId, label: 'ASN' });
      }
    }
  } catch (e) { console.warn('[INTEL] RIPEstat network-info error:', e.message); }

  // Step 5: HackerTarget reverse IP — find co-hosted domains (shared servers / C2 clustering)
  try {
    const htUrl = `https://api.hackertarget.com/reverseiplookup/?q=${encodeURIComponent(id)}`;
    if (!ALLOWED_DOMAINS.has('api.hackertarget.com')) throw new Error('blocked');
    const htRes = await fetch(htUrl, { signal: AbortSignal.timeout(7000), headers: { 'User-Agent': WIKIDATA_UA } });
    if (htRes.ok) {
      const text = await htRes.text();
      const domains = text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('error') && !s.includes('API count') && s.includes('.'));
      if (domains.length > 0 && domains.length <= 100) {
        const htId = `event:cohosted:${id}`;
        nodes.push({ id: htId, label: `Co-hosted: ${domains.slice(0, 4).join(', ')}${domains.length > 4 ? ` +${domains.length - 4} more` : ''}`,
          type: 'event', properties: { domains: domains.slice(0, 30).join(', '), count: domains.length, source: 'HackerTarget' } });
        links.push({ source: rootId, target: htId, label: `CO-HOSTED DOMAINS (${domains.length})` });
      }
    }
  } catch (e) { console.warn('[INTEL] HackerTarget error:', e.message); }

  // Step 6: Shodan host intelligence
  if (SHODAN_API_KEY) {
    try {
      const shodanUrl = `https://api.shodan.io/shodan/host/${encodeURIComponent(id)}?key=${SHODAN_API_KEY}`;
      if (!ALLOWED_DOMAINS.has(new URL(shodanUrl).hostname)) throw new Error('Blocked domain');
      const res = await fetch(shodanUrl, { signal: AbortSignal.timeout(9000) });
      if (res.ok) {
        const d = await res.json();
        if (d.ports?.length > 0) {
          const services = [...new Set((d.data || []).map(b => b.product).filter(Boolean))].slice(0, 6).join(', ');
          const portId = `event:ports:${id}`;
          nodes.push({
            id: portId, label: `Open ports: ${d.ports.slice(0, 8).join(', ')}${d.ports.length > 8 ? '…' : ''}`,
            type: 'event',
            properties: { ports: d.ports.join(', '), services: services || undefined, hostnames: (d.hostnames || []).join(', ') || undefined, source: 'Shodan' },
          });
          links.push({ source: rootId, target: portId, label: 'OPEN PORTS' });
        }
        if (d.vulns && Object.keys(d.vulns).length > 0) {
          const topVuln = Object.entries(d.vulns).sort((a, b) => (b[1].cvss || 0) - (a[1].cvss || 0))[0];
          const vulnId = `event:vuln:${topVuln[0]}`;
          nodes.push({
            id: vulnId, label: topVuln[0], type: 'event',
            properties: { cvss: topVuln[1].cvss, description: (topVuln[1].summary || '').slice(0, 120), source: 'Shodan' },
          });
          links.push({ source: rootId, target: vulnId, label: `VULNERABLE (${Object.keys(d.vulns).length} CVEs)` });
        }
        if (d.tags?.length > 0) {
          nodes.push({ id: rootId, label: id, type: 'ip', properties: { shodan_tags: d.tags.join(', '), source: 'Shodan' } });
        }
      }
    } catch (e) { console.warn('[INTEL] Shodan error:', e.message); }
  }

  // Step 7: AbuseIPDB reputation
  if (ABUSEIPDB_KEY) {
    try {
      const abuseUrl = `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(id)}&maxAgeInDays=90`;
      if (!ALLOWED_DOMAINS.has(new URL(abuseUrl).hostname)) throw new Error('Blocked domain');
      const res = await fetch(abuseUrl, {
        signal: AbortSignal.timeout(6000),
        headers: { Key: ABUSEIPDB_KEY, Accept: 'application/json' },
      });
      if (res.ok) {
        const json = await res.json();
        const d = json.data;
        if (d?.abuseConfidenceScore > 0) {
          const abuseId = `event:abuse:${id}`;
          nodes.push({
            id: abuseId, label: `Abuse score: ${d.abuseConfidenceScore}%`, type: 'event',
            properties: { score: d.abuseConfidenceScore, reports: d.totalReports, last_reported: d.lastReportedAt, usage_type: d.usageType, source: 'AbuseIPDB' },
          });
          links.push({ source: rootId, target: abuseId, label: d.abuseConfidenceScore >= 50 ? 'HIGH ABUSE RISK' : 'ABUSE REPORTS' });
        }
      }
    } catch (e) { console.warn('[INTEL] AbuseIPDB error:', e.message); }
  }

  const result = dedup(nodes, links, rootId);
  wdCacheSet(`ip:${id}`, result);
  return result;
}

async function resolveCountry(id) {
  const rootId = `country:${id}`;
  const nodes = [], links = [];
  const cached = wdCacheGet(`country:${id}`);
  if (cached) return { ...cached };

  try {
    const qids = await wdSearch(id);
    // Constrain QID branch to sovereign state / country types to avoid same-named entities
    const ctQidFilter = qids.length
      ? `{ VALUES ?item { ${qids.map(q => `wd:${q}`).join(' ')} } . { ?item wdt:P31/wdt:P279* wd:Q6256 . } UNION { ?item wdt:P31/wdt:P279* wd:Q3624078 . } } UNION `
      : '';
    const filter = `${ctQidFilter}{ ?item rdfs:label "${sanitizeId(id)}"@en . { ?item wdt:P31/wdt:P279* wd:Q6256 . } UNION { ?item wdt:P31/wdt:P279* wd:Q3624078 . } }`;
    const results = await sparql(`
      SELECT ?item ?itemLabel ?headLabel ?capitalLabel ?population ?gdp
             ?tld ?callingCode ?memberOfLabel ?neighborLabel WHERE {
        ${filter}
        OPTIONAL { ?item wdt:P35 ?head . }
        OPTIONAL { ?item wdt:P36 ?capital . }
        OPTIONAL { ?item wdt:P1082 ?population . }
        OPTIONAL { ?item wdt:P2131 ?gdp . }
        OPTIONAL { ?item wdt:P78 ?tld . }
        OPTIONAL { ?item wdt:P474 ?callingCode . }
        OPTIONAL { ?item wdt:P463 ?memberOf . }
        OPTIONAL { ?item wdt:P47 ?neighbor . }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
      } LIMIT 50`);

    const seenHeads = new Set();
    const seenMembers = new Set();
    const seenNeighbors = new Set();
    let propsSet = false;

    for (const r of results) {
      // Head of state/government
      if (r.headLabel?.value && !seenHeads.has(r.headLabel.value)) {
        seenHeads.add(r.headLabel.value);
        const hid = `person:${r.headLabel.value}`;
        nodes.push({ id: hid, label: r.headLabel.value, type: 'person', properties: { role: 'Head of State', source: 'Wikidata' } });
        links.push({ source: rootId, target: hid, label: 'HEAD OF STATE' });
      }

      // Capital city
      if (r.capitalLabel?.value && !propsSet) {
        const capId = `event:${r.capitalLabel.value}`;
        nodes.push({ id: capId, label: r.capitalLabel.value, type: 'event', properties: { role: 'Capital', source: 'Wikidata' } });
        links.push({ source: rootId, target: capId, label: 'CAPITAL' });
      }

      // Country properties (population, GDP, TLD, calling code)
      if (!propsSet) {
        const props = { source: 'Wikidata' };
        if (r.population?.value) props.population = r.population.value;
        if (r.gdp?.value) props.gdp = r.gdp.value;
        if (r.tld?.value) props.tld = r.tld.value;
        if (r.callingCode?.value) props.calling_code = r.callingCode.value;
        nodes.push({ id: rootId, label: id, type: 'country', properties: props });
        propsSet = true;
      }

      // Member of (UN, NATO, EU, etc.)
      if (r.memberOfLabel?.value && !seenMembers.has(r.memberOfLabel.value)) {
        seenMembers.add(r.memberOfLabel.value);
        const mid = `company:${r.memberOfLabel.value}`;
        nodes.push({ id: mid, label: r.memberOfLabel.value, type: 'company', properties: { role: 'Organization', source: 'Wikidata' } });
        links.push({ source: rootId, target: mid, label: 'MEMBER OF' });
      }

      // Neighboring countries
      if (r.neighborLabel?.value && !seenNeighbors.has(r.neighborLabel.value)) {
        seenNeighbors.add(r.neighborLabel.value);
        const nid = `country:${r.neighborLabel.value}`;
        nodes.push({ id: nid, label: r.neighborLabel.value, type: 'country', properties: { source: 'Wikidata' } });
        links.push({ source: rootId, target: nid, label: 'NEIGHBOR' });
      }
    }
  } catch (e) { console.warn('[INTEL] Wikidata country error:', e.message); }

  addSanctionsToGraph(id, rootId, nodes, links);
  const result = dedup(nodes, links, rootId);
  wdCacheSet(`country:${id}`, result);
  return result;
}

const RESOLVERS = { aircraft: resolveAircraft, vessel: resolveVessel, company: resolveCompany, person: resolvePerson, ip: resolveIP, country: resolveCountry };
const ALLOWED_TYPES = new Set(Object.keys(RESOLVERS));

// ════════════════════════════════════════════════════
// §6 — RATE LIMITER
// ════════════════════════════════════════════════════

const rateMap = new Map();

function isRateLimited(ip, limit = 30, windowMs = 60000) {
  const now = Date.now();
  for (const [k, v] of rateMap) { if (now > v.resetAt) rateMap.delete(k); }
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) { rateMap.set(ip, { count: 1, resetAt: now + windowMs }); return false; }
  entry.count++;
  return entry.count > limit;
}

// ════════════════════════════════════════════════════
// §7 — EXPRESS ROUTES
// ════════════════════════════════════════════════════

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    sanctions_entries: sanctionsIndex.entries.length,
    sanctions_loaded_at: sanctionsIndex.fetchedAt ? new Date(sanctionsIndex.fetchedAt).toISOString() : null,
    wikidata_cache_size: wdCache.size,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

app.get('/resolve', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Rate limit exceeded' });

  const type = (req.query.type || '').toLowerCase().trim();
  const rawId = (req.query.id || '').trim();

  if (!type || !ALLOWED_TYPES.has(type)) {
    return res.status(400).json({ error: `Invalid type. Allowed: ${[...ALLOWED_TYPES].join(', ')}` });
  }
  if (!rawId || rawId.length < 2 || rawId.length > 200) {
    return res.status(400).json({ error: 'Invalid id (2-200 chars)' });
  }

  const id = sanitizeId(rawId);
  if (id.length < 2) return res.status(400).json({ error: 'ID contains too many invalid characters' });

  try {
    const resolver = RESOLVERS[type];
    // Pass extra properties for aircraft resolution (registration, model, etc.)
    const props = {};
    if (req.query.registration) props.registration = sanitizeId(req.query.registration);
    if (req.query.model)        props.model        = sanitizeId(req.query.model);
    if (req.query.icao24)       props.icao24       = sanitizeId(req.query.icao24);
    if (req.query.imo)          props.imo          = req.query.imo.replace(/[^0-9]/g, '').slice(0, 10);
    if (req.query.mmsi)         props.mmsi         = req.query.mmsi.replace(/[^0-9]/g, '').slice(0, 9);
    if (req.query.vesselName)   props.vesselName   = sanitizeId(req.query.vesselName);
    if (req.query.flag)         props.flag         = sanitizeId(req.query.flag);
    if (req.query.ship_type)    props.ship_type    = sanitizeId(req.query.ship_type);
    if (req.query.destination)  props.destination  = sanitizeId(req.query.destination);
    if (req.query.call_sign)    props.call_sign    = sanitizeId(req.query.call_sign);
    const result = await resolver(id, props);
    res.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
    res.json({
      nodes: result.nodes,
      links: result.links,
      entity: { type, id },
      source: 'OSIRIS Intelligence Layer',
      sanctions_index_size: sanctionsIndex.entries.length,
      wikidata_cache_hits: wdCache.size,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[INTEL] Resolve error:', e);
    res.status(500).json({ error: 'Resolution failed', nodes: [], links: [] });
  }
});

// ════════════════════════════════════════════════════
// §8 — STARTUP
// ════════════════════════════════════════════════════

async function boot() {
  console.log('[INTEL] OSIRIS Intelligence Layer starting...');
  // Load FtM datasets in parallel with sanctions CSVs. Both stream in background so the
  // server becomes available as soon as the CSV load completes (~10s).
  // ua_war_sanctions: 1,400 shadow fleet vessels + 8,600 companies + ownership edges
  // us_ofac_sdn:      1,500 vessels + 9,600 orgs + 422 Directorship edges (people connections)
  const ftmPromise = Promise.all([
    loadFtmRelationships('ua_war_sanctions'),
    loadFtmRelationships('us_ofac_sdn'),
  ]);
  await loadSanctions();
  setInterval(() => loadSanctions(), SDN_REFRESH_MS);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[INTEL] Intelligence Layer ready on port ${PORT}`);
    console.log(`[INTEL] Sanctions: ${sanctionsIndex.entries.length} entities indexed`);
    console.log(`[INTEL] Resolve endpoint: GET /resolve?type=<type>&id=<id>`);
    ftmPromise.then(() => console.log(`[INTEL] FtM index ready: ${ftmVesselByImo.size} vessels, ${ftmDirByOrg.size} company-director maps, ${ftmCompanyByName.size} companies indexed`));
  });
}

boot().catch(e => { console.error('[INTEL] Fatal:', e); process.exit(1); });
