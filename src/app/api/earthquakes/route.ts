
import { NextResponse } from 'next/server';

/**
 * OSIRIS — Earthquake Data API
 * Fetches real-time seismic events from USGS (last 24h, M2.5+)
 * No API key required
 *
 * Cache: 5-min module-level cache — USGS feed updates ~every minute but data is
 * identical across all clients within the 15-min client poll window.
 */

const CACHE_TTL = 5 * 60_000; // 5 min — balances USGS update frequency vs. request fan-out

const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
} as const;

type EarthquakePayload = {
  earthquakes: unknown[];
  total: number;
  timestamp: string;
};

let cachedEarthquakes: EarthquakePayload | null = null;
let lastFetch = 0;

export async function GET() {
  const now = Date.now();

  // Serve from module-level cache if fresh (5-min TTL)
  if (cachedEarthquakes && now - lastFetch < CACHE_TTL) {
    return NextResponse.json(cachedEarthquakes, { headers: CACHE_HEADERS });
  }
  try {
    const url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      if (cachedEarthquakes) {
        return NextResponse.json(cachedEarthquakes, { headers: CACHE_HEADERS });
      }
      return NextResponse.json({ earthquakes: [], error: 'USGS unavailable' });
    }

    const data = await res.json();
    const features = data.features || [];

    const earthquakes = features.map((f: { id?: string; geometry?: { coordinates?: number[] }; properties?: Record<string, unknown> }) => {
      const coords = f.geometry?.coordinates || [0, 0, 0];
      const props = f.properties || {};
      return {
        id: f.id,
        lat: coords[1],
        lng: coords[0],
        depth: coords[2],
        magnitude: props.mag,
        place: props.place,
        time: props.time,
        url: props.url,
        tsunami: props.tsunami,
        type: props.type,
        felt: props.felt,
        alert: props.alert,
      };
    });

    const payload: EarthquakePayload = {
      earthquakes,
      total: earthquakes.length,
      timestamp: new Date().toISOString(),
    };
    cachedEarthquakes = payload;
    lastFetch = now;

    return NextResponse.json(payload, { headers: CACHE_HEADERS });
  } catch (error) {
    console.error('Earthquake fetch error:', error);
    // Serve stale cache on upstream failure rather than an empty response
    if (cachedEarthquakes) {
      return NextResponse.json(cachedEarthquakes, { headers: CACHE_HEADERS });
    }
    return NextResponse.json({ earthquakes: [], error: 'Failed to fetch earthquake data' }, { status: 500 });
  }
}

