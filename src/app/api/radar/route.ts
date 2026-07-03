import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Internet Outage Detection (IODA)
 * Source: Georgia Tech IODA — completely free, no auth required
 * https://api.ioda.inetintel.cc.gatech.edu/v2/
 */

const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  // Original entries
  AF:[65,33],AL:[20,41],DZ:[3,28],AO:[18.5,-12.5],AR:[-64,-34],AM:[45,40],AU:[134,-25],AT:[14,47.5],AZ:[50,40.5],
  BD:[90,24],BY:[28,53],BE:[4,50.8],BR:[-51,-10],BG:[25.5,42.7],KH:[105,12.5],CM:[12,6],CA:[-96,62],CL:[-71,-30],
  CN:[105,35],CO:[-72,4],CD:[24,-3],CG:[15.8,-0.2],HR:[16,45.2],CU:[-79.5,22],CZ:[15.5,49.8],DK:[10,56],
  EC:[-78.5,-2],EG:[30,27],ET:[39.5,9],FI:[26,64],FR:[2,46],DE:[10,51],GH:[-1.5,8],GR:[22,39],
  GT:[-90.4,15.5],HN:[-86.6,14.8],HU:[19.5,47],IN:[79,22],ID:[120,-5],IR:[53,32],IQ:[44,33],IE:[-8,53],
  IL:[34.8,31.5],IT:[12.5,42.8],JP:[138,36],JO:[36.5,31],KZ:[67,48],KE:[38,1],KW:[47.5,29.5],
  LB:[35.8,33.9],LY:[17,27],LT:[24,55.5],MG:[47,-19],MY:[112,3],MX:[-102,23.5],MA:[-6,32],
  MZ:[35,-18.2],MM:[96.5,22],NP:[84,28.2],NL:[5.5,52.5],NZ:[174,-41],NG:[8,10],NO:[8,62],
  PK:[70,30],PS:[35.2,31.9],PA:[-80,9],PE:[-76,-10],PH:[122,12.5],PL:[19.5,52],PT:[-8,39.5],
  RO:[25,46],RU:[100,60],SA:[45,25],SN:[-14.5,14.5],RS:[21,44],SG:[103.8,1.35],SK:[19.5,48.7],
  ZA:[24,-29],KR:[128,36],ES:[-4,40],SD:[30,15],SE:[16,62],CH:[8,47],SY:[38,35],TW:[121,23.7],
  TZ:[35,-6],TH:[101,15],TR:[35,39],UA:[32,49],AE:[54,24],GB:[-2,54],US:[-97,38],UZ:[65,41.5],
  VE:[-66,8],VN:[106,16],YE:[48,15.5],ZM:[28,-14],ZW:[30,-20],
  // Extended — covers remaining IODA-reported countries
  AD:[1.6,42.5],AG:[-61.8,17.1],AW:[-69.9,12.5],AX:[19.9,60.2],
  BA:[17.7,43.9],BB:[-59.5,13.2],BF:[-1.5,12.4],BH:[50.6,26.0],BI:[29.9,-3.4],BJ:[2.3,9.3],
  BM:[-64.8,32.3],BN:[114.7,4.5],BO:[-64.9,-16.3],BQ:[-68.3,12.2],BS:[-77.4,24.3],
  BT:[90.4,27.5],BW:[24.7,-22.3],BZ:[-88.7,17.2],
  CI:[-5.5,7.5],CR:[-84.0,9.7],CV:[-24.0,15.1],CW:[-69.0,12.2],CY:[33.4,35.1],
  DM:[-61.4,15.4],DO:[-70.2,18.8],
  EE:[25.0,58.6],
  FJ:[178.0,-18.0],FO:[-6.9,62.0],
  GA:[11.6,-0.8],GE:[43.4,42.3],GG:[-2.6,49.5],GI:[-5.4,36.1],GM:[-15.3,13.5],GN:[-11.8,11.0],
  GP:[-61.6,16.3],GU:[144.8,13.5],GY:[-58.9,4.9],
  HK:[114.2,22.4],HT:[-72.3,18.9],
  IM:[-4.5,54.2],IS:[-18.9,64.9],
  JE:[-2.1,49.2],JM:[-77.3,18.1],
  KG:[74.6,41.2],KN:[-62.8,17.3],KY:[-80.5,19.3],
  LA:[102.5,17.9],LI:[9.5,47.2],LK:[80.7,7.9],LR:[-9.4,6.5],LS:[28.2,-29.6],LU:[6.1,49.8],LV:[25.0,56.9],
  MC:[7.4,43.7],MD:[28.4,47.0],ME:[19.4,42.7],MK:[21.7,41.6],ML:[-2.0,17.6],MN:[104.0,46.9],
  MO:[113.5,22.2],MQ:[-61.0,14.7],MR:[-10.9,20.3],MT:[14.4,35.9],MU:[57.6,-20.3],MV:[73.3,3.2],MW:[34.3,-13.3],
  NA:[17.1,-22.0],NC:[165.6,-20.9],NI:[-85.0,12.9],
  OM:[57.6,21.0],
  PF:[-149.4,-17.7],PG:[143.9,-6.3],PR:[-66.6,18.2],PY:[-58.4,-23.4],
  QA:[51.2,25.3],
  RE:[55.5,-21.1],RW:[29.9,-2.0],
  SC:[55.5,-4.6],SI:[14.8,46.2],SL:[-11.8,8.5],SM:[12.5,43.9],SO:[46.2,5.2],SS:[31.3,7.0],
  SV:[-88.9,13.8],SX:[-63.1,18.0],SZ:[31.5,-26.5],
  TG:[1.2,8.0],TJ:[71.3,38.8],TM:[59.6,40.0],TN:[9.2,34.0],TT:[-61.2,10.4],
  UG:[32.3,1.4],UY:[-56.0,-32.5],
  VG:[-64.6,18.4],VI:[-64.9,17.7],
};

// Minimum IODA score to display. Scores are raw deviation units (not %).
// 2000 was generating too many false positives from routine BGP churn and minor probe noise.
// 10000 catches moderate-to-major events while filtering out background variation.
const MIN_SCORE = 10000;

function scoreToLevel(score: number): string {
  if (score >= 50000) return 'critical';
  if (score >= 20000) return 'major';
  if (score >= 10000) return 'moderate';
  return 'minor';
}

export async function GET() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 86400; // Last 24 hours
    const url = `https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events?from=${from}&until=${now}&entityType=country&limit=200`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      cache: 'no-store',
      headers: { 'User-Agent': 'OSIRIS/4.2', 'Accept': 'application/json' },
    });

    console.log('[OSIRIS] IODA response status:', res.status);

    if (!res.ok) {
      // Fallback: return empty but valid response
      return NextResponse.json({ outages: [], total: 0, timestamp: new Date().toISOString(), source: 'IODA (offline)' });
    }

    const json = await res.json();
    const events = json.data || [];
    const nowTs = Math.floor(Date.now() / 1000);

    interface IodaEvent {
      location?: string;
      location_name?: string;
      score?: number;
      start?: number;
      duration?: number;
      datasource?: string;
      overlaps_window?: boolean;
    }

    // Per-country: collect all datasources seen + the highest-scoring event.
    // Tracking datasources lets us require corroboration before displaying.
    const byCountry = new Map<string, { sources: Set<string>; best: IodaEvent }>();

    for (const e of events as IodaEvent[]) {
      if (!e.overlaps_window) continue;

      // Skip events that resolved more than 2 hours ago — stale blips in the 24h window
      // that are no longer relevant. Ongoing events have duration=null/0.
      if (e.start && e.duration && (e.start + e.duration) < nowTs - 7200) continue;

      const code = e.location?.split('/')[1];
      if (!code || !COUNTRY_CENTROIDS[code]) continue;

      const rec = byCountry.get(code);
      if (!rec) {
        byCountry.set(code, { sources: new Set([e.datasource || '?']), best: e });
      } else {
        if (e.datasource) rec.sources.add(e.datasource);
        if ((e.score || 0) > (rec.best.score || 0)) rec.best = e;
      }
    }

    const outages = Array.from(byCountry.entries())
      .filter(([, { best, sources }]) => {
        const s = best.score || 0;
        if (s < MIN_SCORE) return false;

        // BGP-only events are noisy: route leaks, normal convergence, and maintenance
        // windows all look like "outages" in BGP data without any user impact.
        // Require very high score (critical) before trusting a BGP-only signal.
        const isBgpOnly = sources.size === 1 && [...sources][0].toLowerCase().includes('bgp');
        if (isBgpOnly && s < 50000) return false;

        // For moderate events, require at least 2 independent IODA datasources to agree
        // (e.g., both BGP anomaly AND reduced active-probe responses). A real outage
        // is visible in multiple signal channels; a false positive usually fires only one.
        if (s < 30000 && sources.size < 2) return false;

        return true;
      })
      .map(([code, { best, sources }], i) => {
        const [lng, lat] = COUNTRY_CENTROIDS[code];
        return {
          id: `ioda-${code}-${i}`,
          lat,
          lng,
          country: code,
          countryName: best.location_name || code,
          code,
          score: Math.round(best.score || 0),
          level: scoreToLevel(best.score || 0),
          from: best.start,
          until: best.start ? best.start + (best.duration || 0) : null,
          datasource: [...sources].map(s => s.replace(/_/g, ' ')).join(' + '),
          sourceCount: sources.size,
        };
      });

    return NextResponse.json({
      outages,
      total: outages.length,
      timestamp: new Date().toISOString(),
      source: 'IODA — Georgia Tech Internet Outage Detection',
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800' },
    });
  } catch (error) {
    console.error('[OSIRIS] IODA fetch error:', error);
    return NextResponse.json({ outages: [], total: 0, error: 'IODA unavailable' }, { status: 500 });
  }
}
