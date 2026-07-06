/**
 * OSIRIS — Raion (district) boundary lookup
 *
 * Shared by any route that wants to corroborate a signal against Neptune.in.ua's
 * raion-level active-alert keys (/api/neptun-alerts). Loads public/raions.geojson
 * once (136 MultiPolygon features, `key` + `rayon` properties) and exposes:
 *
 *   raionKeyForPoint(lat, lng) — point-in-polygon lookup, for city-precise coords
 *   RAYON_NAME_TO_KEY          — exact "X район" name → lowercase key, for routes
 *                                 (air-raids) that already carry the full raion name
 */

import { promises as fs } from 'fs';
import path from 'path';

interface RaionFeature {
  key: string;     // lowercase, e.g. "куп'янський" — matches neptun-alerts activeKeys
  rayon: string;   // full name, e.g. "Куп'янський район"
  rings: [number, number][][][]; // MultiPolygon coordinate rings, [lng, lat] (GeoJSON order)
}

let cache: RaionFeature[] | null = null;
let loading: Promise<RaionFeature[]> | null = null;

async function loadFeatures(): Promise<RaionFeature[]> {
  const raw = await fs.readFile(path.join(process.cwd(), 'public', 'raions.geojson'), 'utf8');
  const geojson = JSON.parse(raw);
  const features: RaionFeature[] = [];
  for (const f of geojson.features ?? []) {
    const key = String(f.properties?.key ?? '').trim().toLowerCase();
    const rayon = String(f.properties?.rayon ?? '').trim();
    if (!key || !rayon) continue;
    // Normalize to MultiPolygon ring list regardless of Polygon/MultiPolygon input.
    const rings: [number, number][][][] =
      f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates
      : f.geometry?.type === 'Polygon' ? [f.geometry.coordinates]
      : [];
    features.push({ key, rayon, rings });
  }
  return features;
}

async function getFeatures(): Promise<RaionFeature[]> {
  if (cache) return cache;
  if (!loading) loading = loadFeatures().then(f => { cache = f; return f; });
  return loading;
}

// Standard ray-casting point-in-polygon over a single ring (Latin square algorithm).
function pointInRing(lat: number, lng: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// First ring of each polygon is the exterior; any further rings are holes.
function pointInPolygon(lat: number, lng: number, polygon: [number, number][][]): boolean {
  if (polygon.length === 0) return false;
  if (!pointInRing(lat, lng, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(lat, lng, polygon[i])) return false; // inside a hole
  }
  return true;
}

/** Returns the Neptune raion `key` containing (lat, lng), or null if none matches. */
export async function raionKeyForPoint(lat: number, lng: number): Promise<string | null> {
  const features = await getFeatures();
  for (const f of features) {
    for (const polygon of f.rings) {
      if (pointInPolygon(lat, lng, polygon)) return f.key;
    }
  }
  return null;
}

/** Full "X район" name → lowercase Neptune key, for routes that already have the raion name. */
export async function rayonNameToKey(): Promise<Map<string, string>> {
  const features = await getFeatures();
  return new Map(features.map(f => [f.rayon, f.key]));
}
