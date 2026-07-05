/**
 * OSIRIS — Entity search index.
 *
 * Turns the app's live `data` arrays (flights, ships, satellites, cameras,
 * infrastructure, news feeds, incidents, …) into one uniform, searchable list so
 * the search bar can locate ANY on-map entity by name — not just geocoded places.
 *
 * Adding a new searchable layer = add one entry to SOURCES. The UI and ranking
 * stay generic.
 */

export interface SearchEntity {
  id: string;
  name: string; // primary label that gets matched
  sublabel: string; // secondary context (type, flag, place…)
  kind: string; // display category (Flight, Ship, Satellite, …)
  layerKey: string; // activeLayers key to reveal on select
  lat: number;
  lng: number;
}

type Row = Record<string, unknown>;
type AppData = Record<string, unknown>;

interface Source {
  dataKey: string; // key in `data`
  kind: string | ((r: Row) => string); // per-record kind for heterogeneous sources (e.g. unified threats)
  layerKey: string;
  name: (r: Row) => string | undefined;
  sub?: (r: Row) => string | undefined;
}

const str = (v: unknown): string | undefined =>
  v === undefined || v === null || v === '' ? undefined : String(v);

const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');

const THREAT_KIND_LABELS: Record<string, string> = {
  fpv: 'FPV', cruise: 'Cruise', ballistic: 'Ballistic', kab: 'KAB',
  aviation: 'Aviation', recon: 'Recon', uav: 'UAV',
};

// One descriptor per entity array in `data`.
const SOURCES: Source[] = [
  { dataKey: 'commercial_flights', kind: 'Flight', layerKey: 'flights', name: (r) => str(r.callsign) || str(r.registration), sub: (r) => join('flight', str(r.model) || str(r.icao24)) },
  { dataKey: 'private_flights', kind: 'Private', layerKey: 'private', name: (r) => str(r.callsign) || str(r.registration), sub: (r) => join('private flight', str(r.model)) },
  { dataKey: 'private_jets', kind: 'Jet', layerKey: 'jets', name: (r) => str(r.callsign) || str(r.registration), sub: (r) => join('private jet', str(r.model)) },
  { dataKey: 'military_flights', kind: 'Military', layerKey: 'military', name: (r) => str(r.callsign) || str(r.registration), sub: (r) => join('military', str(r.model)) },
  { dataKey: 'maritime_ships', kind: 'Ship', layerKey: 'ships', name: (r) => str(r.name) || str(r.mmsi), sub: (r) => join(r.shadow_fleet ? 'shadow fleet' : str(r.type), str(r.flag)) },
  { dataKey: 'satellites', kind: 'Satellite', layerKey: 'satellites', name: (r) => str(r.name), sub: (r) => join('satellite', str(r.mission)) },
  { dataKey: 'cameras', kind: 'Camera', layerKey: 'cctv', name: (r) => str(r.name), sub: (r) => join(str(r.city), str(r.country)) || 'camera' },
  { dataKey: 'infrastructure', kind: 'Infra', layerKey: 'infrastructure', name: (r) => str(r.name), sub: (r) => join(str(r.country), str(r.status)) },
  { dataKey: 'live_feeds', kind: 'Live feed', layerKey: 'live_news', name: (r) => str(r.name), sub: (r) => join(str(r.city), str(r.country)) || 'live feed' },
  { dataKey: 'gdelt', kind: 'Incident', layerKey: 'global_incidents', name: (r) => str(r.name), sub: () => 'conflict event' },
  { dataKey: 'earthquakes', kind: 'Quake', layerKey: 'earthquakes', name: (r) => str(r.place), sub: (r) => `M${str(r.magnitude) ?? '?'}` },
  { dataKey: 'radiation', kind: 'Radiation', layerKey: 'radiation', name: (r) => str(r.name) || str(r.city), sub: (r) => join(str(r.country), 'radiation') },
  { dataKey: 'weather_events', kind: 'Weather', layerKey: 'weather', name: (r) => str(r.title) || str(r.name), sub: (r) => str(r.type) || 'weather' },
  { dataKey: 'maritime_ports', kind: 'Port', layerKey: 'maritime', name: (r) => str(r.name), sub: (r) => join(str(r.country), 'port') },
  { dataKey: 'threats', kind: (r) => THREAT_KIND_LABELS[str((r.properties as Row)?.ttype) ?? ''] ?? 'Threat', layerKey: 'unified_threats',
    name: (r) => str((r.properties as Row)?.place) || str((r.properties as Row)?.oblast),
    sub: (r) => str((r.properties as Row)?.title) || 'threat' },
  { dataKey: 'power_outages', kind: 'Outage', layerKey: 'power_outages', name: (r) => str(r.regionName), sub: (r) => join(str(r.type), 'outage') },
];

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Flatten the live `data` arrays into one searchable entity list. */
export function buildEntityIndex(data: AppData): SearchEntity[] {
  const out: SearchEntity[] = [];
  for (const src of SOURCES) {
    const arr = data[src.dataKey];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i] as Row;
      // GeoJSON Feature rows (e.g. unified threats) carry coords in
      // geometry.coordinates ([lng,lat]) rather than flat r.lat/r.lng.
      const geomCoords = (r.geometry as Row)?.coordinates as [number, number] | undefined;
      const lat = num(r.lat) ?? num(geomCoords?.[1]);
      const lng = num(r.lng) ?? num(geomCoords?.[0]);
      const name = src.name(r);
      if (!name || lat === undefined || lng === undefined) continue;
      if (lat === 0 && lng === 0) continue; // null island = bad fix
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const kind = typeof src.kind === 'function' ? src.kind(r) : src.kind;
      out.push({
        id: `${src.dataKey}-${str(r.id) || str(r.mmsi) || str(r.icao24) || str(r.noradId) || i}`,
        name,
        sublabel: src.sub?.(r) || kind,
        kind,
        layerKey: src.layerKey,
        lat,
        lng,
      });
    }
  }
  return out;
}

/**
 * Rank matches: exact name > name starts-with > word-in-name starts-with >
 * substring in name > substring in sublabel. Ties break toward shorter names.
 */
export function searchEntities(index: SearchEntity[], query: string, limit = 8): SearchEntity[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const scored: { e: SearchEntity; score: number }[] = [];
  for (const e of index) {
    const name = e.name.toLowerCase();
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(` ${q}`)) score = 60;
    else if (name.includes(q)) score = 40;
    else if (e.sublabel.toLowerCase().includes(q)) score = 20;
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.name.length - b.e.name.length);
  return scored.slice(0, limit).map((s) => s.e);
}
