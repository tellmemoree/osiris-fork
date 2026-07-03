/**
 * OSIRIS — Frontline delta computation (directional RU/UA gain).
 *
 * Given two DeepState FeatureCollections (current + past snapshot), computes:
 *   ru_gain  = area now occupied but NOT previously occupied (RU advance)
 *   ua_gain  = area previously occupied but NOT now occupied (UA recovery)
 *
 * Patches below MIN_AREA_KM2 are discarded as sliver noise.
 * All turf calls are wrapped in try/catch — invalid polygons throw.
 */

import { union } from '@turf/union';
import { difference } from '@turf/difference';
import { area as turfArea } from '@turf/area';
import { booleanValid } from '@turf/boolean-valid';
import type { Feature, Polygon, MultiPolygon, FeatureCollection } from 'geojson';

const MIN_AREA_KM2 = 5;

type PolyFeature = Feature<Polygon | MultiPolygon>;

function emptyFC(): FeatureCollection<Polygon | MultiPolygon> {
  return { type: 'FeatureCollection', features: [] };
}

/** Validate and filter polygon features. */
function validPolygons(features: unknown[]): PolyFeature[] {
  const out: PolyFeature[] = [];
  for (const f of features) {
    const feat = f as any;
    const geomType = feat?.geometry?.type;
    if (geomType !== 'Polygon' && geomType !== 'MultiPolygon') continue;
    try {
      if (booleanValid(feat as PolyFeature)) out.push(feat as PolyFeature);
    } catch {
      // Skip features that throw during validation
    }
  }
  return out;
}

/**
 * Union a list of polygons into one shape using @turf/union (v7 FeatureCollection API).
 * Returns null if the input is empty or union fails.
 */
function unionAll(features: PolyFeature[]): PolyFeature | null {
  if (features.length === 0) return null;
  if (features.length === 1) return features[0];
  try {
    const fc: FeatureCollection<Polygon | MultiPolygon> = {
      type: 'FeatureCollection',
      features,
    };
    const result = union(fc);
    return result as PolyFeature | null;
  } catch {
    return null;
  }
}

/**
 * Split a MultiPolygon Feature into individual Polygon Features.
 * Passes through Polygon features unchanged.
 */
function splitMultiPolygon(feat: PolyFeature): Feature<Polygon>[] {
  if (feat.geometry.type === 'Polygon') {
    return [feat as Feature<Polygon>];
  }
  // MultiPolygon
  return (feat.geometry as MultiPolygon).coordinates.map((coords) => ({
    type: 'Feature' as const,
    geometry: { type: 'Polygon' as const, coordinates: coords },
    properties: feat.properties ?? {},
  }));
}

/**
 * Tag each patch in a difference result with direction, area_km2, and compare_date.
 * Filters patches below MIN_AREA_KM2.
 */
function tagAndFilter(
  feat: PolyFeature | null,
  direction: 'ru_gain' | 'ua_gain',
  compareDate: string,
): FeatureCollection<Polygon | MultiPolygon> {
  if (!feat) return emptyFC();

  const patches = splitMultiPolygon(feat);
  const tagged = patches
    .map((p) => {
      let areaKm2 = 0;
      try {
        areaKm2 = turfArea(p) / 1_000_000; // m² → km²
      } catch {
        return null;
      }
      if (areaKm2 < MIN_AREA_KM2) return null;
      return {
        type: 'Feature' as const,
        geometry: p.geometry,
        properties: {
          direction,
          area_km2: Math.round(areaKm2 * 100) / 100,
          compare_date: compareDate,
        },
      } as Feature<Polygon>;
    })
    .filter((p): p is Feature<Polygon> => p !== null);

  return { type: 'FeatureCollection', features: tagged };
}

export interface DeltaResult {
  ru_gain: FeatureCollection<Polygon | MultiPolygon>;
  ua_gain: FeatureCollection<Polygon | MultiPolygon>;
  compare_date: string;
}

/**
 * Compute directional frontline delta between two DeepState snapshots.
 *
 * @param current  Today's DeepState FeatureCollection
 * @param past     Past snapshot FeatureCollection
 * @param compareDate  YYYY-MM-DD of the past snapshot (for display)
 */
export function computeFootprintDelta(
  current: FeatureCollection,
  past: FeatureCollection,
  compareDate: string,
): DeltaResult {
  const empty: DeltaResult = {
    ru_gain: emptyFC(),
    ua_gain: emptyFC(),
    compare_date: compareDate,
  };

  try {
    // Only compare occupied polygons — dismissed/liberated areas are historical
    const currentOccupied = validPolygons(
      (current.features || []).filter(
        (f: any) => f?.properties?.statusKey === 'occupied',
      ),
    );
    const pastOccupied = validPolygons(
      (past.features || []).filter(
        (f: any) => f?.properties?.statusKey === 'occupied',
      ),
    );

    if (currentOccupied.length === 0 || pastOccupied.length === 0) return empty;

    const footprintNow = unionAll(currentOccupied);
    const footprintPast = unionAll(pastOccupied);

    if (!footprintNow || !footprintPast) return empty;

    // RU gain: areas in current footprint that were NOT in past footprint
    let ruGainFeat: PolyFeature | null = null;
    try {
      const fc: FeatureCollection<Polygon | MultiPolygon> = {
        type: 'FeatureCollection',
        features: [footprintNow, footprintPast],
      };
      ruGainFeat = difference(fc) as PolyFeature | null;
    } catch {
      // Invalid geometry — skip
    }

    // UA gain: areas in past footprint that are NOT in current footprint
    let uaGainFeat: PolyFeature | null = null;
    try {
      const fc: FeatureCollection<Polygon | MultiPolygon> = {
        type: 'FeatureCollection',
        features: [footprintPast, footprintNow],
      };
      uaGainFeat = difference(fc) as PolyFeature | null;
    } catch {
      // Invalid geometry — skip
    }

    return {
      ru_gain: tagAndFilter(ruGainFeat, 'ru_gain', compareDate),
      ua_gain: tagAndFilter(uaGainFeat, 'ua_gain', compareDate),
      compare_date: compareDate,
    };
  } catch {
    return empty;
  }
}
