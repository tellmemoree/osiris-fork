import { NextRequest, NextResponse } from 'next/server';
import { computeFusion, type Fusion } from '@/lib/fusion';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * OSIRIS — Global Threat Fusion (server-side, edge-cacheable)
 *
 * SCALE DESIGN (≈333K visitors/month behind Cloudflare):
 * The fusion is computed ONCE here and served as a ~2 KB JSON. Clients make a
 * single tiny request instead of pulling six heavy feeds each and recomputing —
 * that's the difference between hammering the origin (and every upstream's
 * per-IP rate limit) 333K× and serving almost entirely from cache.
 *
 *   • module cache (60s) + single-flight coalescing → the six sub-feeds are
 *     read at most once per minute regardless of traffic
 *   • the sub-feeds have their own caches, so this rarely does real work
 *   • Cache-Control s-maxage lets Cloudflare's edge answer most requests
 *     without ever touching the origin
 */

const CACHE_TTL = 60_000;
const MIN_FEEDS = 2; // below this the read is degenerate — don't overwrite good cache
const CC = 'public, s-maxage=60, stale-while-revalidate=300';
let cached: Fusion | null = null;
let cachedAt = 0;
let inflight: Promise<Fusion> | null = null;
let lastOverall = 0;

async function grab(origin: string, path: string, revalidate: number): Promise<any> {
  try {
    const res = await fetch(`${origin}${path}`, { next: { revalidate } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function build(origin: string): Promise<Fusion> {
  const results = await Promise.all([
    grab(origin, '/api/malware', 300),
    grab(origin, '/api/earthquakes', 300),
    grab(origin, '/api/weather', 300),
    grab(origin, '/api/conflicts', 300),
    grab(origin, '/api/flights', 45),
    grab(origin, '/api/news', 120),
  ]);
  const online = results.filter(Boolean).length;
  const [malware, quakes, weather, conflicts, flights, news] = results;
  const f = computeFusion({ malware, quakes, weather, conflicts, flights, news }, lastOverall);

  // Only commit a read backed by enough feeds — a transient failure of several
  // upstreams must not overwrite a good cache with a bogus "all clear".
  if (online >= MIN_FEEDS) {
    lastOverall = f.overall;
    cached = f;
    cachedAt = Date.now();
  }
  return f;
}

function kickRebuild(origin: string) {
  if (inflight) return;
  inflight = build(origin).finally(() => { inflight = null; });
  // Swallow background errors — stale cache remains valid.
  inflight.catch(() => {});
}

export async function GET(request: NextRequest) {
  const origin = new URL(request.url).origin;
  const age = Date.now() - cachedAt;

  // Fresh → serve instantly.
  if (cached && age < CACHE_TTL) {
    return NextResponse.json(cached, { headers: { 'Cache-Control': CC } });
  }

  // Stale-while-revalidate: serve stale NOW, refresh in the background (never block).
  if (cached) {
    kickRebuild(origin);
    return NextResponse.json(cached, { headers: { 'Cache-Control': CC } });
  }

  // Cold start (no cache yet) → must build once.
  kickRebuild(origin);
  try {
    const fresh = await inflight!;
    return NextResponse.json(fresh, { headers: { 'Cache-Control': CC } });
  } catch {
    return NextResponse.json({ error: 'fusion unavailable' }, { status: 503 });
  }
}
