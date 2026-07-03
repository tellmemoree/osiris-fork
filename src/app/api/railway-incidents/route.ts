import { NextResponse } from 'next/server';
import { getThreatCorpus, matchOblasts, RAILWAY_PATTERNS } from '@/lib/telegram-threats';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Railway Strike Incidents (Telegram-derived)
 *
 * Filters the shared Telegram threat corpus for messages that mention railway
 * infrastructure (stations, depots, track, rolling stock) and maps each match
 * to an approximate oblast centroid.
 *
 * Data quality: TELEGRAM-ONLY / UNVERIFIED.
 * Precision: OBLAST-LEVEL — not an exact station location.
 *
 * Cache: 5 min at module level (aligned with UI poll interval).
 */

// ── types ─────────────────────────────────────────────────────────────────────

interface RailIncident {
  oblast:    string;
  lat:       number;
  lng:       number;
  text:      string;   // snippet ≤150 chars
  source:    string;   // e.g. "war_monitor"
  pubDate:   string;   // ISO
  type:      'rail-strike';
  precision: 'oblast-level';
}

interface RailResponse {
  type:      'FeatureCollection';
  features:  GeoJSONFeature[];
  total:     number;
  timestamp: string;
}

interface GeoJSONFeature {
  type:       'Feature';
  geometry:   { type: 'Point'; coordinates: [number, number] };
  properties: RailIncident;
}

// ── module-level cache ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

let cached:   RailResponse | null = null;
let cachedAt                      = 0;
let inflight: Promise<RailResponse> | null = null;

// ── builder ───────────────────────────────────────────────────────────────────

function matchesRailway(text: string): boolean {
  return RAILWAY_PATTERNS.some((re) => re.test(text));
}

async function buildRailResponse(): Promise<RailResponse> {
  const messages = await getThreatCorpus();

  // Deduplicate: keep only the most recent mention per oblast
  const byOblast = new Map<string, { incident: RailIncident }>();

  for (const msg of messages) {
    if (!matchesRailway(msg.text)) continue;

    const oblasts = matchOblasts(msg.text);
    if (oblasts.length === 0) continue;

    for (const ref of oblasts) {
      const existing = byOblast.get(ref.oblast);
      const snippet  = msg.text.slice(0, 150);
      const ts       = new Date(msg.ts).toISOString();

      if (!existing || msg.ts > new Date(existing.incident.pubDate).getTime()) {
        byOblast.set(ref.oblast, {
          incident: {
            oblast:    ref.oblast,
            lat:       ref.coords[1],
            lng:       ref.coords[0],
            text:      snippet,
            source:    msg.channel,
            pubDate:   ts,
            type:      'rail-strike',
            precision: 'oblast-level',
          },
        });
      }
    }
  }

  const features: GeoJSONFeature[] = Array.from(byOblast.values()).map(({ incident }) => ({
    type:     'Feature',
    geometry: { type: 'Point', coordinates: [incident.lng, incident.lat] },
    properties: incident,
  }));

  return {
    type:      'FeatureCollection',
    features,
    total:     features.length,
    timestamp: new Date().toISOString(),
  };
}

// ── GET handler ───────────────────────────────────────────────────────────────

export async function GET() {
  const now = Date.now();

  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' },
    });
  }

  if (inflight) {
    const data = await inflight;
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' },
    });
  }

  inflight = buildRailResponse();
  try {
    const data = await inflight;
    cached   = data;
    cachedAt = Date.now();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' },
    });
  } catch {
    return NextResponse.json(
      { type: 'FeatureCollection', features: [], total: 0, timestamp: new Date().toISOString() },
      { status: 500 },
    );
  } finally {
    inflight = null;
  }
}
