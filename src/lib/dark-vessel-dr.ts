/**
 * Dead-reckoning math for AIS-dark shadow fleet vessels.
 * All functions are pure — no side effects, safe to call in useEffect.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const R_KM = 6371; // Earth radius, km

/**
 * Great-circle destination point given a start position, bearing, and distance.
 * Returns [lat, lng] in decimal degrees.
 */
export function destinationPoint(
  lat: number,
  lng: number,
  bearingDeg: number,
  distKm: number,
): [number, number] {
  const φ1 = lat * DEG;
  const λ1 = lng * DEG;
  const θ = bearingDeg * DEG;
  const δ = distKm / R_KM;

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );

  return [φ2 * RAD, ((λ2 * RAD + 540) % 360) - 180];
}

/**
 * Dead-reckoned position.
 * Returns [lat, lng] or null if elapsedHours > 6 (DR cap).
 */
export function deadReckon(
  lat: number,
  lng: number,
  headingDeg: number,
  speedKnots: number,
  elapsedHours: number,
): [number, number] | null {
  if (elapsedHours > 6) return null;
  const distKm = speedKnots * 1.852 * elapsedHours;
  const [drLat, drLng] = destinationPoint(lat, lng, headingDeg, distKm);
  return [drLat, drLng];
}

/**
 * Uncertainty radius in km, growing with time and speed.
 * r = 2 + 0.35 * speedKnots * 1.852 * elapsedHours
 */
export function uncertaintyRadiusKm(
  speedKnots: number,
  elapsedHours: number,
): number {
  return 2 + 0.35 * speedKnots * 1.852 * elapsedHours;
}

/**
 * 32-vertex polygon approximating a circle on the map surface.
 * Properties are copied from callerProps so popup/filter expressions work.
 */
export function uncertaintyRing(
  centerLat: number,
  centerLng: number,
  radiusKm: number,
  callerProps: Record<string, unknown> = {},
): GeoJSON.Feature<GeoJSON.Polygon> {
  const VERTICES = 32;
  const coords: [number, number][] = [];
  for (let i = 0; i <= VERTICES; i++) {
    const bearingDeg = (i / VERTICES) * 360;
    const [lat, lng] = destinationPoint(
      centerLat,
      centerLng,
      bearingDeg,
      radiusKm,
    );
    coords.push([lng, lat]);
  }
  // Close the ring
  coords.push(coords[0]);

  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [coords] },
    properties: { ...callerProps },
  };
}
