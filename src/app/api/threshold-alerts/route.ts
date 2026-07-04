import { NextRequest, NextResponse } from 'next/server';
import { sendTelegramMessage, telegramConfigured } from '@/lib/telegram';

export const dynamic = 'force-dynamic';

export interface ThresholdAlert {
  id: string;
  rule: string;
  title: string;
  description: string;
  severity: 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'LOW';
  lat?: number;
  lng?: number;
  timestamp: string;
}

const CACHE_TTL = 300_000; // 5 min
let cache: ThresholdAlert[] | null = null;
let cacheTs = 0;

// Stable per-id first-seen time so an alert's displayed timestamp reflects when
// the condition was first detected, not "now" on every cache-miss regeneration
// (rules recompute `timestamp: new Date().toISOString()` fresh each cycle).
const firstSeenAt = new Map<string, string>();

// Track which alert IDs have been pushed to Telegram this session (reset every 24h)
const sentIds = new Set<string>();
setInterval(() => sentIds.clear(), 86_400_000);

function distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dlat = lat2 - lat1;
  const dlng = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.sqrt(dlat * dlat + dlng * dlng) * 111.32;
}

const CHOKEPOINTS = [
  { name: 'Bosphorus', lat: 41.12, lng: 29.07 },
  { name: 'Dardanelles', lat: 40.15, lng: 26.39 },
  { name: 'Kerch Strait', lat: 45.38, lng: 36.63 },
  { name: 'Suez Canal', lat: 30.58, lng: 32.35 },
  { name: 'Strait of Gibraltar', lat: 35.99, lng: -5.62 },
];

// Rule 1: Active air raid + KAB threat in the same oblast
function ruleAirRaidPlusKab(
  airRaids: Record<string, unknown>[],
  kabThreats: Record<string, unknown>[]
): ThresholdAlert[] {
  const alerts: ThresholdAlert[] = [];
  const airOblasts = new Set(airRaids.map(r => String(r.oblast ?? r.regionName ?? '')));
  for (const kab of kabThreats) {
    const oblast = String(kab.oblast ?? '');
    if (!oblast || !airOblasts.has(oblast)) continue;
    alerts.push({
      id: `air-kab-${oblast.toLowerCase().replace(/\s+/g, '-')}`,
      rule: 'Air Raid + KAB Co-location',
      title: `Air raid + KAB threat — ${oblast}`,
      description: `Active air raid alert and glide bomb threat detected simultaneously in ${oblast}.`,
      severity: 'HIGH',
      lat: kab.lat as number | undefined,
      lng: kab.lng as number | undefined,
      timestamp: new Date().toISOString(),
    });
  }
  return alerts;
}

// Rule 2: Shadow-fleet vessel within 200 km of a strategic chokepoint
function ruleShadowFleetChokepoint(ships: Record<string, unknown>[]): ThresholdAlert[] {
  const alerts: ThresholdAlert[] = [];
  for (const ship of ships) {
    if (!ship.shadow_fleet) continue;
    const lat = ship.lat as number;
    const lng = ship.lng as number;
    for (const cp of CHOKEPOINTS) {
      if (distKm(lat, lng, cp.lat, cp.lng) < 200) {
        const name = String(ship.name ?? ship.mmsi ?? 'Unknown');
        alerts.push({
          id: `shadow-${ship.mmsi}-${cp.name.replace(/\s+/g, '-').toLowerCase()}`,
          rule: 'Shadow Fleet at Chokepoint',
          title: `${name} near ${cp.name}`,
          description: `Shadow-fleet vessel ${name} (${ship.flag ?? '?'}) operating within 200 km of ${cp.name}. Speed: ${ship.speed ?? '?'} kt.`,
          severity: 'ELEVATED',
          lat,
          lng,
          timestamp: new Date().toISOString(),
        });
        break;
      }
    }
  }
  return alerts;
}

// Rule 3: High/medium-confidence FIRMS hit on an RU airfield
function ruleFirmsAirfield(aois: Record<string, unknown>[]): ThresholdAlert[] {
  return aois
    .filter(a => a.hit && a.category === 'airfield' && a.confidence !== 'low' && a.confidence !== null)
    .map(a => ({
      id: `thermal-airfield-${String(a.id ?? a.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      rule: 'FIRMS Strike — RU Airfield',
      title: `FIRMS hit: ${a.name}`,
      description: `${a.fireCount} fire detection(s) within strike range of ${a.name}. Max FRP: ${a.maxFrp} MW. Confidence: ${a.confidence?.toString().toUpperCase()}. Heuristic — verify independently.`,
      severity: (a.confidence === 'high' ? 'HIGH' : 'ELEVATED') as ThresholdAlert['severity'],
      lat: a.lat as number | undefined,
      lng: a.lng as number | undefined,
      timestamp: new Date().toISOString(),
    }));
}

// Rule 4: FIRMS fire confirmation on any non-airfield strategic site or news AOI.
// Airfields are already covered by ruleFirmsAirfield; this fills every other category.
// Confidence 'news' = no fire data yet (just a news mention) — excluded.
function ruleFirmsStrikeConfirmed(aois: Record<string, unknown>[]): ThresholdAlert[] {
  const CAT_SEV: Record<string, ThresholdAlert['severity']> = {
    oil:       'HIGH',
    naval:     'HIGH',
    ammo:      'HIGH',
    power:     'HIGH',
    logistics: 'ELEVATED',
    rail:      'ELEVATED',
    news:      'ELEVATED',
  };

  return aois
    .filter(a =>
      a.hit &&
      a.category !== 'airfield' &&
      a.confidence !== 'news' &&
      a.confidence !== 'low' &&
      a.confidence !== null
    )
    .map(a => {
      const cat = String(a.category ?? '');
      const base: ThresholdAlert['severity'] = CAT_SEV[cat] ?? 'ELEVATED';
      const videoConf = Boolean(a.videoConfirmed);
      const bilateral = Boolean(a.bilateral);

      const sev: ThresholdAlert['severity'] =
        bilateral ? 'CRITICAL'
        : videoConf && base !== 'HIGH' ? 'HIGH'
        : base;

      const tags = [
        a.confidence ? `${String(a.confidence).toUpperCase()} confidence` : null,
        videoConf ? 'VIDEO CONFIRMED' : null,
        bilateral ? 'BILATERAL' : null,
        a.weapon ? `Weapon: ${a.weapon}` : null,
      ].filter(Boolean).join(' · ');

      return {
        id: `strike-${cat}-${String(a.id ?? a.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
        rule: 'Strike Confirmation',
        title: `Strike confirmed: ${a.name}`,
        description: `${a.fireCount} FIRMS detection(s) at ${a.name} (${cat.toUpperCase()})${tags ? ' · ' + tags : ''}. Max FRP: ${a.maxFrp} MW. Heuristic — verify independently.`,
        severity: sev,
        lat: a.lat as number | undefined,
        lng: a.lng as number | undefined,
        timestamp: new Date().toISOString(),
      };
    });
}

async function telegramAlert(alert: ThresholdAlert): Promise<void> {
  if (!telegramConfigured() || sentIds.has(alert.id)) return;
  sentIds.add(alert.id);
  const sev = { CRITICAL: '🔴', HIGH: '🟠', ELEVATED: '🟡', LOW: '🟢' }[alert.severity] ?? '⚪';
  const text = `${sev} <b>OSIRIS THRESHOLD ALERT</b>\n<b>${alert.rule}</b>\n\n${alert.description}\n\n<i>${alert.timestamp}</i>`;
  await sendTelegramMessage(text);
}

export async function GET(req: NextRequest) {
  const now = Date.now();
  if (cache && now - cacheTs < CACHE_TTL) {
    return NextResponse.json({ alerts: cache, timestamp: new Date(cacheTs).toISOString(), fromCache: true });
  }

  const base = new URL(req.url).origin;
  const toJson = (r: Response) => r.ok ? r.json() as Promise<Record<string, unknown>> : Promise.resolve({} as Record<string, unknown>);
  const [airR, kabR, maritimeR, thermalR] = await Promise.allSettled([
    fetch(new URL('/api/air-raids', base).href).then(toJson),
    fetch(new URL('/api/kab-threats', base).href).then(toJson),
    fetch(new URL('/api/maritime', base).href).then(toJson),
    fetch(new URL('/api/strategic-thermal', base).href).then(toJson),
  ]);

  const airRaids: Record<string, unknown>[] = airR.status === 'fulfilled' ? ((airR.value.alerts ?? []) as Record<string, unknown>[]) : [];
  const kabThreats: Record<string, unknown>[] = kabR.status === 'fulfilled' ? ((kabR.value.threats ?? []) as Record<string, unknown>[]) : [];
  const ships: Record<string, unknown>[] = maritimeR.status === 'fulfilled' ? ((maritimeR.value.ships ?? []) as Record<string, unknown>[]) : [];
  const aois: Record<string, unknown>[] = thermalR.status === 'fulfilled' ? ((thermalR.value.aois ?? []) as Record<string, unknown>[]) : [];

  const alerts: ThresholdAlert[] = [
    ...ruleAirRaidPlusKab(airRaids, kabThreats),
    ...ruleShadowFleetChokepoint(ships),
    ...ruleFirmsAirfield(aois),
    ...ruleFirmsStrikeConfirmed(aois),
  ];

  // Pin each alert's timestamp to when its id was first seen, not this cycle's
  // regeneration time. Ids no longer present get pruned so a genuinely new
  // occurrence later starts a fresh clock.
  const liveIds = new Set(alerts.map(a => a.id));
  for (const id of firstSeenAt.keys()) {
    if (!liveIds.has(id)) firstSeenAt.delete(id);
  }
  for (const alert of alerts) {
    const seen = firstSeenAt.get(alert.id);
    if (seen) {
      alert.timestamp = seen;
    } else {
      firstSeenAt.set(alert.id, alert.timestamp);
    }
  }

  // Push new alerts to Telegram (fire-and-forget)
  for (const alert of alerts) {
    telegramAlert(alert).catch(() => {});
  }

  cache = alerts;
  cacheTs = now;

  return NextResponse.json(
    { alerts, timestamp: new Date().toISOString(), fromCache: false },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
