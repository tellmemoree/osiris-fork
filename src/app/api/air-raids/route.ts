
import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { stealthFetch } from '@/lib/stealthFetch';
import { DISTRICT_COORDS } from './district-coords';

// ---------------------------------------------------------------------------
// Persistence — ~/.osiris-data/air-raid-history.json
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(os.homedir(), '.osiris-data');
const FILE = path.join(DATA_DIR, 'air-raid-history.json');

// 5-min intervals × 60min × 24h × 7 days = 2 016 entries max
const SNAP_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_SNAPS = 2_016;

interface AirRaidSnap {
  ts: string;      // ISO timestamp
  active: string[]; // English oblast names currently alarmed
}

let lastSnapAt = 0; // epoch ms — module-level, survives across requests
let lastGoodAlerts: EnrichedAlert[] | null = null; // served with stale:true on upstream failure

async function readHistory(): Promise<AirRaidSnap[]> {
  try {
    const txt = await fs.readFile(FILE, 'utf8');
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function writeHistory(snaps: AirRaidSnap[]): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(snaps.slice(-MAX_SNAPS)), 'utf8');
  } catch (e) {
    console.warn('[OSIRIS] air-raids: persist failed', e instanceof Error ? e.message : e);
  }
}

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Ukrainian Air Raid Alerts API
 * Source: vadimklimenko.com/map/statuses.json (keyless, no token required).
 * Provides BOTH oblast-level and district (raion) level granularity, so a
 * partial alert covering only a few raions of an oblast is plotted precisely
 * at those raions instead of lighting up the whole oblast.
 *
 * Logic: if a state is enabled → one oblast-level alert. Otherwise we descend
 * into its districts and emit a district-level alert for each enabled raion.
 */

// Oblast/state centroid [lng, lat] + English display label, keyed by the exact
// Ukrainian state name returned by the feed.
const OBLAST_INFO: Record<string, { coords: [number, number]; en: string }> = {
  'Вінницька область': { coords: [28.468, 49.233], en: 'Vinnytsia oblast' },
  'Волинська область': { coords: [25.325, 50.747], en: 'Volyn oblast' },
  'Дніпропетровська область': { coords: [35.046, 48.465], en: 'Dnipropetrovsk oblast' },
  'Донецька область': { coords: [37.800, 48.000], en: 'Donetsk oblast' },
  'Житомирська область': { coords: [28.658, 50.255], en: 'Zhytomyr oblast' },
  'Закарпатська область': { coords: [23.297, 48.620], en: 'Zakarpattia oblast' },
  'Запорізька область': { coords: [35.139, 47.838], en: 'Zaporizhzhia oblast' },
  'Івано-Франківська область': { coords: [24.711, 48.922], en: 'Ivano-Frankivsk oblast' },
  'Київська область': { coords: [30.523, 50.450], en: 'Kyiv oblast' },
  'м. Київ': { coords: [30.523, 50.450], en: 'Kyiv' },
  'Кіровоградська область': { coords: [32.262, 48.508], en: 'Kirovohrad oblast' },
  'Луганська область': { coords: [39.300, 48.566], en: 'Luhansk oblast' },
  'Львівська область': { coords: [24.029, 49.839], en: 'Lviv oblast' },
  'Миколаївська область': { coords: [31.994, 46.975], en: 'Mykolaiv oblast' },
  'Одеська область': { coords: [30.723, 46.482], en: 'Odesa oblast' },
  'Полтавська область': { coords: [34.551, 49.588], en: 'Poltava oblast' },
  'Рівненська область': { coords: [26.251, 50.620], en: 'Rivne oblast' },
  'Сумська область': { coords: [34.800, 50.910], en: 'Sumy oblast' },
  'Тернопільська область': { coords: [25.594, 49.553], en: 'Ternopil oblast' },
  'Харківська область': { coords: [36.230, 49.990], en: 'Kharkiv oblast' },
  'Херсонська область': { coords: [32.601, 46.635], en: 'Kherson oblast' },
  'Хмельницька область': { coords: [26.987, 49.423], en: 'Khmelnytskyi oblast' },
  'Черкаська область': { coords: [32.060, 49.445], en: 'Cherkasy oblast' },
  'Чернівецька область': { coords: [25.940, 48.292], en: 'Chernivtsi oblast' },
  'Чернігівська область': { coords: [31.285, 51.498], en: 'Chernihiv oblast' },
  'АР Крим': { coords: [34.102, 44.952], en: 'Crimea' },
  'Севастополь': { coords: [33.522, 44.616], en: 'Sevastopol' },
};

// Raw shape from vadimklimenko.com/map/statuses.json
type RawNode = {
  enabled?: boolean;
  enabled_at?: string | null;
  districts?: Record<string, RawNode>;
};
type RawStatuses = {
  states?: Record<string, RawNode>;
};

type EnrichedAlert = {
  regionId: number | null;
  regionName: string;   // English oblast label, or Ukrainian raion name for districts
  regionType: string;   // 'oblast' | 'district'
  level: 'oblast' | 'district';
  oblast: string;       // parent oblast (English) for context
  alertType: string;
  startedAt: string;
  lat: number | null;
  lng: number | null;
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
  // Normal path — fetch live alerts
  // -------------------------------------------------------------------------
  try {
    const res = await stealthFetch('https://vadimklimenko.com/map/statuses.json', {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.error(`[OSIRIS] vadimklimenko responded with ${res.status}`);
      if (lastGoodAlerts) {
        return NextResponse.json({ alerts: lastGoodAlerts, total: lastGoodAlerts.length, stale: true, error: `air-alert source returned ${res.status}` });
      }
      return NextResponse.json({ alerts: [], total: 0, error: `air-alert source returned ${res.status}` }, { status: 502 });
    }

    const data: RawStatuses = await res.json();
    const states = data.states ?? {};
    const alerts: EnrichedAlert[] = [];
    const activeOblasts: string[] = [];

    for (const [stateName, state] of Object.entries(states)) {
      const info = OBLAST_INFO[stateName];
      const oblastEn = info?.en ?? stateName;

      if (state.enabled) {
        // Whole oblast under alert → single oblast-level marker
        activeOblasts.push(oblastEn);
        alerts.push({
          regionId: null,
          regionName: oblastEn,
          regionType: 'oblast',
          level: 'oblast',
          oblast: oblastEn,
          alertType: 'AIR',
          startedAt: state.enabled_at ?? '',
          lat: info ? info.coords[1] : null,
          lng: info ? info.coords[0] : null,
        });
        continue;
      }

      // Oblast not fully alerted → emit a marker for each enabled raion
      for (const [districtName, district] of Object.entries(state.districts ?? {})) {
        if (!district.enabled) continue;
        const coords = DISTRICT_COORDS[districtName] ?? null;
        alerts.push({
          regionId: null,
          regionName: districtName,
          regionType: 'district',
          level: 'district',
          oblast: oblastEn,
          alertType: 'AIR',
          startedAt: district.enabled_at ?? '',
          lat: coords ? coords[1] : null,
          lng: coords ? coords[0] : null,
        });
      }
    }

    // -----------------------------------------------------------------------
    // Persist snapshot if enough time has passed since the last one
    // -----------------------------------------------------------------------
    const now = Date.now();
    if (now - lastSnapAt >= SNAP_INTERVAL_MS) {
      lastSnapAt = now;
      try {
        const history = await readHistory();
        history.push({ ts: new Date(now).toISOString(), active: activeOblasts });
        await writeHistory(history);
      } catch (e) {
        console.warn('[OSIRIS] air-raids: snapshot append failed', e instanceof Error ? e.message : e);
      }
    }

    lastGoodAlerts = alerts;
    const oblastCount = alerts.filter((a) => a.level === 'oblast').length;
    const districtCount = alerts.filter((a) => a.level === 'district').length;

    return NextResponse.json(
      {
        alerts,
        total: alerts.length,
        oblast_alerts: oblastCount,
        district_alerts: districtCount,
        timestamp: new Date().toISOString(),
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
        },
      }
    );
  } catch (error) {
    console.error('[OSIRIS] Air raid fetch error:', error);
    if (lastGoodAlerts) {
      return NextResponse.json({ alerts: lastGoodAlerts, total: lastGoodAlerts.length, stale: true, error: error instanceof Error ? error.message : 'Failed to fetch air raid data' });
    }
    return NextResponse.json({ alerts: [], total: 0, error: error instanceof Error ? error.message : 'Failed to fetch air raid data' });
  }
}
