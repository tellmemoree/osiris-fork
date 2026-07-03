/**
 * OSIRIS — Global Threat Fusion (client-side)
 *
 * Pure scoring engine: takes the raw responses from the platform's live
 * feeds and fuses them into a single weighted THREATCON level with
 * per-domain breakdown and cross-domain hotspots. No I/O, fully testable.
 */

export type Domain = 'CONFLICT' | 'CYBER' | 'SIGNALS' | 'SEISMIC' | 'AVIATION' | 'ATMOSPHERIC';

export interface DomainDriver {
  label: string;   // the specific thing driving the score
  sub?: string;    // supporting detail (location, family, magnitude…)
  sev?: number;    // 0-100 severity for colouring
}

export interface DomainScore {
  domain: Domain;
  score: number;
  headline: string;
  count: number;
  weight: number;        // this domain's weight in the composite
  contribution: number;  // points it adds to the overall (score × weight)
  method: string;        // one-line explanation of how the score is derived
  drivers: DomainDriver[]; // the evidence — WHY this score
}

export interface Hotspot {
  lat: number;
  lng: number;
  label: string;
  domain: Domain;
  severity: number;
}

export interface Fusion {
  threatcon: number;
  level_label: string;
  level_color: string;
  overall: number;
  trend: 'rising' | 'falling' | 'steady';
  delta: number;
  dominant_domain: Domain | undefined;
  domains: DomainScore[];
  hotspots: Hotspot[];
}

export interface FusionInputs {
  malware?: any;
  quakes?: any;
  weather?: any;
  conflicts?: any;
  flights?: any;
  news?: any;
}

const WEIGHTS: Record<Domain, number> = {
  CONFLICT: 0.28, CYBER: 0.20, SIGNALS: 0.15, SEISMIC: 0.13, AVIATION: 0.12, ATMOSPHERIC: 0.12,
};
const LEVELS = ['', 'GUARDED', 'ELEVATED', 'HIGH', 'SEVERE', 'CRITICAL'];
const COLORS = ['', '#00E676', '#FFD54F', '#FF9500', '#FF5252', '#FF1744'];

const clamp = (n: number, lo = 0, hi = 100) => Math.round(Math.max(lo, Math.min(hi, n)));
const num = (v: any): number => (typeof v === 'number' && !Number.isNaN(v) ? v : 0);
const decode = (s: string): string => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#\d+;/g, '');

function push(domains: DomainScore[], d: Omit<DomainScore, 'weight' | 'contribution'>) {
  const weight = WEIGHTS[d.domain];
  domains.push({ ...d, weight, contribution: Math.round(d.score * weight) });
}

export function computeFusion(input: FusionInputs, prevOverall = 0): Fusion {
  const { malware, quakes, weather, conflicts, flights, news } = input;
  const hotspots: Hotspot[] = [];
  const domains: DomainScore[] = [];

  // CONFLICT — weighted by active war zones + escalation + live event tempo
  {
    const zones: any[] = conflicts?.zones || [];
    const wars = zones.filter(z => z.severity === 'war');
    const highs = zones.filter(z => z.severity === 'high' || z.severity === 'elevated');
    const live = num(conflicts?.totalLiveEvents);
    const score = clamp(wars.length * 20 + highs.length * 10 + live * 2);
    const drivers: DomainDriver[] = [
      ...[...wars, ...highs]
        .sort((a, b) => (b.severity === 'war' ? 1 : 0) - (a.severity === 'war' ? 1 : 0))
        .slice(0, 5)
        .map(z => ({ label: z.label || 'Conflict zone', sub: String(z.severity || '').toUpperCase(), sev: z.severity === 'war' ? 95 : z.severity === 'high' ? 75 : 55 })),
    ];
    if (live > 0) drivers.push({ label: `${live} live conflict events`, sub: 'last 24h tempo', sev: clamp(live * 6) });
    push(domains, {
      domain: 'CONFLICT', score, count: zones.length,
      headline: wars.length ? `${wars.length} active war zone${wars.length > 1 ? 's' : ''} · ${live} live events` : `${zones.length} monitored zones`,
      method: 'war ×20 + escalating ×10 + live events ×2',
      drivers,
    });
    for (const z of zones) {
      if (z.lat == null) continue;
      const sev = z.severity === 'war' ? 95 : z.severity === 'high' ? 75 : z.severity === 'elevated' ? 55 : 35;
      hotspots.push({ lat: z.lat, lng: z.lng, label: z.label || 'Conflict zone', domain: 'CONFLICT', severity: sev });
    }
  }
  // CYBER — botnet C2 weighted heavily over bulk distribution hosts
  {
    const threats: any[] = malware?.threats || [];
    const c2 = num(malware?.stats?.by_type?.botnet_c2);
    const families: any[] = malware?.stats?.top_families || [];
    const score = clamp(c2 * 9 + threats.length * 0.15);
    const drivers: DomainDriver[] = [];
    if (c2 > 0) drivers.push({ label: `${c2} live botnet C2 server${c2 > 1 ? 's' : ''}`, sub: 'active command & control', sev: 90 });
    for (const f of families.slice(0, 4)) drivers.push({ label: f.name || 'Unknown family', sub: `${f.count} hosts`, sev: clamp(num(f.count) * 2) });
    push(domains, {
      domain: 'CYBER', score, count: threats.length,
      headline: `${threats.length} malware hosts · ${c2} botnet C2`,
      method: 'botnet C2 ×9 + distribution hosts ×0.15',
      drivers,
    });
    for (const t of threats.filter(t => t.severity === 'critical').slice(0, 8)) {
      hotspots.push({ lat: t.lat, lng: t.lng, label: `${t.malware} C2 · ${t.country}`, domain: 'CYBER', severity: 90 });
    }
  }
  // SIGNALS — high-priority OSINT news tempo
  {
    const items: any[] = news?.news || [];
    const scores = items.map(n => num(n.risk_score));
    const hot = scores.filter(s => s >= 8).length;
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const score = clamp(hot * 14 + avg * 4);
    const drivers: DomainDriver[] = [...items]
      .sort((a, b) => num(b.risk_score) - num(a.risk_score))
      .slice(0, 5)
      .map(n => ({ label: decode(String(n.title || 'Signal')).slice(0, 70), sub: `${n.source || 'OSINT'} · risk ${num(n.risk_score)}`, sev: clamp(num(n.risk_score) * 10) }));
    push(domains, {
      domain: 'SIGNALS', score, count: items.length,
      headline: `${items.length} OSINT items · ${hot} high-priority`,
      method: 'high-priority items ×14 + avg risk ×4',
      drivers,
    });
    for (const n of items.filter(n => num(n.risk_score) >= 8 && Array.isArray(n.coords)).slice(0, 4)) {
      hotspots.push({ lat: n.coords[0], lng: n.coords[1], label: decode(String(n.title || 'Signal')).slice(0, 60), domain: 'SIGNALS', severity: clamp(num(n.risk_score) * 10) });
    }
  }
  // SEISMIC — driven by the strongest event + count of major quakes
  {
    const eq: any[] = quakes?.earthquakes || [];
    const mags = eq.map(q => num(q.magnitude));
    const maxMag = mags.length ? Math.max(...mags) : 0;
    const strong = mags.filter(m => m >= 5).length;
    const score = clamp(maxMag * 11 + strong * 5);
    const drivers: DomainDriver[] = [...eq]
      .sort((a, b) => num(b.magnitude) - num(a.magnitude))
      .slice(0, 5)
      .map(q => ({ label: `M${num(q.magnitude).toFixed(1)}`, sub: q.place || 'unknown', sev: clamp(num(q.magnitude) * 12) }));
    push(domains, {
      domain: 'SEISMIC', score, count: eq.length,
      headline: eq.length ? `${eq.length} quakes · max M${maxMag.toFixed(1)}` : 'No significant seismicity',
      method: 'max magnitude ×11 + M5.0+ count ×5',
      drivers,
    });
    for (const q of eq.filter(q => num(q.magnitude) >= 5).slice(0, 4)) {
      hotspots.push({ lat: q.lat, lng: q.lng, label: `M${num(q.magnitude).toFixed(1)} · ${q.place || 'quake'}`, domain: 'SEISMIC', severity: clamp(num(q.magnitude) * 12) });
    }
  }
  // AVIATION — military air activity + GPS-denial (jamming) zones
  {
    const milFlights: any[] = flights?.military_flights || [];
    const mil = milFlights.length;
    const jam: any[] = flights?.gps_jamming || [];
    const score = clamp(mil * 0.28 + jam.length * 8);
    const drivers: DomainDriver[] = [];
    if (mil > 0) drivers.push({ label: `${mil} military aircraft airborne`, sub: 'ADS-B tracked', sev: clamp(mil * 0.5) });
    for (const j of [...jam].sort((a, b) => num(b.severity) - num(a.severity)).slice(0, 4)) {
      drivers.push({ label: `GPS jamming zone`, sub: `interference ${num(j.severity)}%`, sev: clamp(num(j.severity)) });
    }
    push(domains, {
      domain: 'AVIATION', score, count: mil,
      headline: `${mil} military aircraft · ${jam.length} GPS-jam zones`,
      method: 'military aircraft ×0.28 + GPS-jam zones ×8',
      drivers,
    });
    for (const j of jam.slice(0, 4)) {
      hotspots.push({ lat: j.lat, lng: j.lng, label: `GPS jamming · ${num(j.severity)}%`, domain: 'AVIATION', severity: clamp(num(j.severity)) });
    }
  }
  // ATMOSPHERIC — active severe-weather events, high-severity weighted
  {
    const events: any[] = weather?.events || [];
    const highEvents = events.filter(e => (e.severity || '').toLowerCase() === 'high');
    const score = clamp(highEvents.length * 11 + events.length * 0.4);
    const drivers: DomainDriver[] = highEvents.slice(0, 5).map(e => ({ label: e.type || 'Severe weather', sub: e.area || e.title || '', sev: 70 }));
    if (!drivers.length && events.length) drivers.push({ label: `${events.length} active weather events`, sub: 'no high-severity', sev: 30 });
    push(domains, {
      domain: 'ATMOSPHERIC', score, count: events.length,
      headline: `${events.length} severe-weather events · ${highEvents.length} high-severity`,
      method: 'high-severity ×11 + all events ×0.4',
      drivers,
    });
    for (const e of highEvents.filter(e => e.lat != null).slice(0, 3)) {
      hotspots.push({ lat: e.lat, lng: e.lng, label: `${e.type} · ${e.area || ''}`.trim(), domain: 'ATMOSPHERIC', severity: 70 });
    }
  }

  const overall = clamp(domains.reduce((s, d) => s + d.score * WEIGHTS[d.domain], 0));
  const level = clamp(Math.ceil(overall / 20), 1, 5);
  const delta = overall - prevOverall;
  const trend: Fusion['trend'] = Math.abs(delta) < 1.5 ? 'steady' : delta > 0 ? 'rising' : 'falling';
  const dominant = [...domains].sort((a, b) => b.score * WEIGHTS[b.domain] - a.score * WEIGHTS[a.domain])[0];

  return {
    threatcon: level,
    level_label: LEVELS[level],
    level_color: COLORS[level],
    overall: Math.round(overall),
    trend,
    delta: Math.round(delta * 10) / 10,
    dominant_domain: dominant?.domain,
    domains: domains.sort((a, b) => b.score - a.score),
    hotspots: hotspots.sort((a, b) => b.severity - a.severity).slice(0, 6),
  };
}
