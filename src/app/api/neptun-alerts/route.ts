import { NextResponse } from 'next/server';
import { stealthFetch } from '@/lib/stealthFetch';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Neptune.in.ua raion-level air-alert proxy
 * Upstream: https://neptun.in.ua/api/v1/alerts (Cloudflare-protected → stealthFetch)
 * Client joins activeKeys against static /raions.geojson (feature prop `key`).
 * Never returns 5xx: stale cache on upstream failure, empty payload otherwise.
 */

const UPSTREAM = 'https://neptun.in.ua/api/v1/alerts';
const CACHE_TTL_MS = 2 * 60_000;

interface NeptunPayload {
  updatedAt: string | null;
  activeKeys: string[];
}

// Version-gated cache: re-fetch only when >TTL old; if upstream `version` is
// unchanged after a re-fetch, reuse the previously shaped payload object.
let cached: { version: number; ts: number; data: NeptunPayload } | null = null;
let inflight: Promise<NeptunPayload> | null = null;

// raions.geojson keys use U+0027 apostrophes (e.g. "куп'янський") — normalize
// any curly/modifier apostrophe variants from the API so the join never misses.
const normalizeApos = (s: string) => s.replace(/[''ʼ]/g, "'");

async function fetchAlerts(): Promise<NeptunPayload> {
  const res = await stealthFetch(UPSTREAM, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`neptun upstream HTTP ${res.status}`);
  const j = await res.json();
  const version = Number(j?.version) || 0;
  if (cached && cached.version === version) {
    cached = { ...cached, ts: Date.now() };
    return cached.data;
  }
  const raions: any[] = Array.isArray(j?.raions) ? j.raions : [];
  const activeKeys = [...new Set(
    raions
      .map((r) => normalizeApos(String(r?.key ?? '').trim().toLowerCase()))
      .filter(Boolean),
  )];
  const data: NeptunPayload = {
    updatedAt: typeof j?.updatedAt === 'string' ? j.updatedAt : null,
    activeKeys,
  };
  cached = { version, ts: Date.now(), data };
  return data;
}

export async function GET() {
  const now = Date.now();
  try {
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      return NextResponse.json(cached.data);
    }
    if (!inflight) {
      inflight = fetchAlerts().finally(() => { inflight = null; });
    }
    return NextResponse.json(await inflight);
  } catch {
    // Stale-on-error; never 5xx — layer degrades to "no active raions".
    if (cached) return NextResponse.json(cached.data);
    return NextResponse.json({ updatedAt: null, activeKeys: [] } satisfies NeptunPayload);
  }
}
