/**
 * OSIRIS — Multi-Source Conflict Event Aggregator
 *
 * Fans out to multiple free sources, deduplicates events by location+time
 * bucket, and assigns confidence tiers (confirmed / reported / unverified).
 *
 * Sources:
 *   gdelt       — GDELT GEO 2.0 (3s timeout; hard-skips on 404/non-200)
 *   gdelt-rss   — GDELT RSS (BBC, Al Jazeera, ISW, Ukrinform, etc.)
 *   telegram    — UA threat corpus via telegram-threats.ts
 *   ucdp        — UCDP GED events API (requires UCDP_ACCESS_TOKEN)
 *
 * Cache TTL: 5 min (data volatility: near-real-time war reporting).
 * SSRF guard: not needed — all URLs are hardcoded (no user-supplied hosts).
 * Env vars:
 *   UCDP_ACCESS_TOKEN   — optional; UCDP GED endpoint gated behind this
 */

import { NextResponse } from 'next/server';
import { stealthFetch } from '@/lib/stealthFetch';
import {
  ConflictEvent,
  EventType,
  RSS_FEEDS,
  CONFLICT_KEYWORDS,
  geoMapText,
  findPlaceCoords,
  clusterEvents,
  escapeHtml,
  safeHref,
} from '@/lib/conflict-geo';
import { extractGeoEvents } from '@/lib/telegram-threats';

export const dynamic = 'force-dynamic';

// ── Module-level cache ───────────────────────────────────────────────────────

const CACHE_TTL = 300_000; // 5 minutes — near-real-time war data
let cachedData: ConflictEvent[] | null = null;
let lastFetch = 0;

// ── GDELT GEO 2.0 ───────────────────────────────────────────────────────────

async function fetchGdelt(): Promise<ConflictEvent[]> {
  const queries = [
    'protest OR riot OR unrest',
    'conflict OR military OR attack OR strike',
    'coup OR revolution OR emergency',
  ] as const;

  const allEvents: ConflictEvent[] = [];
  let eventId = 0;

  for (const query of queries) {
    try {
      const encodedQuery = encodeURIComponent(query);
      const url = `https://api.gdeltproject.org/api/v2/geo/geo?query=${encodedQuery}&format=GeoJSON&timespan=24h&maxpoints=100`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      type GdeltGeo = { features?: { geometry?: { coordinates?: number[] }; properties?: Record<string, unknown> }[] };
      let geojson: GdeltGeo | null = null;
      try {
        const res = await stealthFetch(url, { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeoutId);
        if (!res.ok) continue;
        geojson = (await res.json()) as GdeltGeo;
      } catch {
        clearTimeout(timeoutId);
        continue;
      }
      const features = geojson?.features;
      if (!features) continue;

      for (const feature of features) {
        const coords = feature.geometry?.coordinates;
        if (!coords || coords.length < 2) continue;

        const props = feature.properties ?? {};
        const nameRaw = props.name ?? (typeof props.html === 'string' ? props.html.replace(/<[^>]*>/g, '').slice(0, 120) : null) ?? 'GDELT Event';
        const name = String(nameRaw);
        const eventUrl = typeof props.url === 'string' ? props.url : typeof props.shareimage === 'string' ? props.shareimage : undefined;

        const rawType = query.includes('protest') ? 'unrest' : query.includes('conflict') ? 'conflict' : 'political';

        allEvents.push({
          id: `gdelt-${eventId++}`,
          lat: coords[1],
          lng: coords[0],
          name,
          url: eventUrl,
          html: typeof props.html === 'string' ? escapeHtml(props.html) : undefined,
          eventType: rawType as EventType,
          sources: ['gdelt'],
          deaths: undefined,
        });
      }
    } catch {
      // Individual query failure is non-fatal
    }
  }

  return allEvents;
}

// ── GDELT RSS fallback ───────────────────────────────────────────────────────

async function fetchGdeltRss(): Promise<ConflictEvent[]> {
  // Fan out all 12 feeds in parallel — sequential awaits stack 5s timeouts each.
  const results = await Promise.allSettled(
    RSS_FEEDS.map(feed => fetch(feed.url, { signal: AbortSignal.timeout(5000) })
      .then(res => res.ok ? res.text() : null)
      .catch(() => null)
      .then(xml => ({ feed, xml }))),
  );

  const allEvents: ConflictEvent[] = [];
  let eventId = 0;

  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value.xml) continue;
    const { feed, xml } = r.value;

    const items = xml.match(/<item>([\s\S]*?)<\/item>/gi) ?? [];

    for (const item of items) {
      const titleMatch =
        item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) ??
        item.match(/<title>(.*?)<\/title>/i);
      const linkMatch = item.match(/<link>(.*?)<\/link>/i);
      const descMatch =
        item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/i) ??
        item.match(/<description>(.*?)<\/description>/i);
      const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/i);

      if (!titleMatch || !linkMatch) continue;

      const parsed = dateMatch ? new Date(dateMatch[1]) : new Date();
      const published = Number.isNaN(parsed.getTime())
        ? new Date().toISOString()
        : parsed.toISOString();
      const ageHours = (Date.now() - new Date(published).getTime()) / 3_600_000;
      if (ageHours > 24) continue;

      const title = titleMatch[1];
      const link = linkMatch[1];
      const desc = descMatch ? descMatch[1] : '';

      const textToSearch = (title + ' ' + desc).toLowerCase();
      const isConflict = CONFLICT_KEYWORDS.some(kw => textToSearch.includes(kw));
      if (!isConflict) continue;

      // Try ranked town-first resolver first
      const ranked = findPlaceCoords(textToSearch); // returns [lat, lng]
      let lat: number, lng: number;
      if (ranked) {
        [lat, lng] = ranked;
      } else {
        const fallback = geoMapText(textToSearch); // returns [lng, lat]
        if (!fallback) continue;
        [lng, lat] = fallback;
      }
      allEvents.push({
        id: `osint-${feed.source.replace(/\s+/g, '')}-${eventId++}`,
        lat,
        lng,
        name: `[${feed.source}] ${title}`,
        url: link,
        html: `<a href="${safeHref(link)}" target="_blank">${escapeHtml(title)}</a><br/><i>Source: ${escapeHtml(feed.source)}</i>`,
        eventType: 'conflict',
        sources: ['gdelt-rss'],
        published,
      });
    }
  }

  return allEvents;
}

// ── Telegram corpus ──────────────────────────────────────────────────────────

async function extractTelegramEvents(): Promise<ConflictEvent[]> {
  try {
    const raw = await extractGeoEvents();
    return raw.map((r, i) => ({
      id: `telegram-geo-${i}`,
      lat: r.lat,
      lng: r.lng,
      name: r.name,
      eventType: r.eventType as EventType,
      sources: r.sources,
      published: r.published,
    }));
  } catch {
    return [];
  }
}

// ── UCDP GED events ──────────────────────────────────────────────────────────

async function fetchUcdp(): Promise<ConflictEvent[]> {
  const token = process.env.UCDP_ACCESS_TOKEN;
  if (!token) return [];

  try {
    const res = await fetch(
      'https://ucdpapi.pcr.uu.se/api/gedevents/24.1?pagesize=100&Country=Ukraine',
      {
        headers: { 'x-ucdp-access-token': token },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return [];

    const data = await res.json() as {
      Result?: {
        latitude?: string | number;
        longitude?: string | number;
        where_description?: string;
        type_of_violence?: number;
        deaths_a?: number;
        deaths_b?: number;
        deaths_civilians?: number;
        deaths_unknown?: number;
        date_start?: string;
      }[];
    };

    const results = data.Result ?? [];
    const events: ConflictEvent[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.latitude == null || r.longitude == null) continue;
      const lat = typeof r.latitude === 'string' ? parseFloat(r.latitude) : r.latitude;
      const lng = typeof r.longitude === 'string' ? parseFloat(r.longitude) : r.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const typeMap: Record<number, EventType> = { 1: 'battle', 2: 'conflict', 3: 'one-sided' };
      const eventType: EventType = typeMap[r.type_of_violence ?? 0] ?? 'conflict';
      const deaths = (r.deaths_a ?? 0) + (r.deaths_b ?? 0) + (r.deaths_civilians ?? 0) + (r.deaths_unknown ?? 0);
      events.push({
        id: `ucdp-${i}`,
        lat,
        lng,
        name: r.where_description ?? 'UCDP Event',
        eventType,
        sources: ['ucdp'],
        published: r.date_start ? new Date(r.date_start).toISOString() : undefined,
        deaths: deaths > 0 ? deaths : undefined,
      });
    }
    return events;
  } catch {
    return [];
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const now = Date.now();

  // Serve from cache if still fresh
  if (cachedData && now - lastFetch < CACHE_TTL) {
    const uniqueSources = Array.from(new Set(cachedData.flatMap(e => e.sources)));
    return NextResponse.json(
      { events: cachedData, total: cachedData.length, timestamp: new Date(lastFetch).toISOString(), sources: uniqueSources },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  }

  const fetchers = [fetchGdelt(), fetchGdeltRss(), extractTelegramEvents(), fetchUcdp()];
  const settled = await Promise.allSettled(fetchers);

  const flat: ConflictEvent[] = [];
  let rejectedCount = 0;
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      flat.push(...r.value);
    } else {
      rejectedCount++;
    }
  }

  // Fall back to stale cache when all fetchers returned empty — all fetchers
  // swallow errors and resolve with [], so rejectedCount is never > 0 in practice.
  // Serving stale when flat is empty is safe: genuine zero-event windows for
  // Ukraine conflict are essentially impossible; empty means upstream failure.
  if (flat.length === 0 && cachedData && cachedData.length > 0) {
    const uniqueSources = Array.from(new Set(cachedData.flatMap(e => e.sources)));
    return NextResponse.json(
      { events: cachedData, total: cachedData.length, timestamp: new Date(lastFetch).toISOString(), sources: uniqueSources, stale: true },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
    );
  }

  const events = clusterEvents(flat);
  cachedData = events;
  lastFetch = now;

  const uniqueSources = Array.from(new Set(events.flatMap(e => e.sources)));

  return NextResponse.json(
    { events, total: events.length, timestamp: new Date().toISOString(), sources: uniqueSources },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
  );
}
