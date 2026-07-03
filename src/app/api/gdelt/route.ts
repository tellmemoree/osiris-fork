/**
 * @deprecated Use /api/conflict-events instead.
 *
 * OSIRIS — Global Incidents API (GDELT — deprecation shim)
 *
 * This route exists only for backward compatibility with internal callers that
 * have not yet migrated:
 *   - /api/health    (probe list)
 *   - /api/stats     (incident count)
 *   - /api/scm-suppliers (risk enrichment)
 *
 * It reimplements GDELT GEO 2.0 and GDELT RSS fetching locally (not delegating
 * to /api/conflict-events), then returns the legacy shape: { events, total, timestamp, source }.
 * The `source` field is kept as a string for callers that check it.
 * UCDP and Telegram sources are intentionally omitted — this shim returns GDELT-only data.
 *
 * Do NOT add new callers here. Point new code at /api/conflict-events.
 */

import { NextResponse } from 'next/server';
import { stealthFetch } from '@/lib/stealthFetch';
import {
  ConflictEvent,
  EventType,
  GEO_DICT,
  RSS_FEEDS,
  CONFLICT_KEYWORDS,
  clusterEvents,
  escapeHtml,
  safeHref,
} from '@/lib/conflict-geo';

export const dynamic = 'force-dynamic';

// ── Module-level cache (independent of conflict-events cache) ────────────────

const CACHE_TTL = 300_000; // 5 minutes
let cachedEvents: ConflictEvent[] | null = null;
let lastFetch = 0;

// ── GDELT GEO 2.0 (same logic as conflict-events/route.ts) ──────────────────

async function fetchGdeltEvents(): Promise<ConflictEvent[]> {
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
      const timeoutId = setTimeout(() => controller.abort(), 5000);
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

        const isDupe = allEvents.some(e =>
          Math.abs(e.lat - coords[1]) < 0.5 &&
          Math.abs(e.lng - coords[0]) < 0.5 &&
          e.name === name,
        );
        if (isDupe) continue;

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
          confidence: 'reported',
        });
      }
    } catch {
      // Individual query failure is non-fatal
    }
  }

  return allEvents;
}

// ── GDELT RSS fallback ───────────────────────────────────────────────────────

async function fetchRssEvents(): Promise<ConflictEvent[]> {
  const perFeed = await Promise.allSettled(
    RSS_FEEDS.map(async (feed, feedIdx) => {
      const events: ConflictEvent[] = [];
      const res = await fetch(feed.url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return events;
      const xml = await res.text();
      const items = xml.match(/<item>([\s\S]*?)<\/item>/gi) ?? [];
      let itemIdx = 0;
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
        const published = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
        if ((Date.now() - new Date(published).getTime()) / 3_600_000 > 24) continue;
        const title = titleMatch[1];
        const link = linkMatch[1];
        const desc = descMatch ? descMatch[1] : '';
        const textToSearch = (title + ' ' + desc).toLowerCase();
        if (!CONFLICT_KEYWORDS.some(kw => textToSearch.includes(kw))) continue;
        let coords: [number, number] | null = null;
        const eventId = feedIdx * 1000 + itemIdx;
        for (const [location, point] of Object.entries(GEO_DICT)) {
          const regex = new RegExp(`\\b${location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          if (regex.test(textToSearch)) {
            const jitterLng = ((eventId * 137.5) % 200 - 100) / 100 * 1.5;
            const jitterLat = ((eventId * 251.3) % 200 - 100) / 100 * 1.5;
            coords = [point[0] + jitterLng, point[1] + jitterLat];
            break;
          }
        }
        if (coords) {
          events.push({
            id: `osint-${feed.source.replace(/\s+/g, '')}-${itemIdx}`,
            lat: coords[1], lng: coords[0],
            name: `[${feed.source}] ${title}`, url: link,
            html: `<a href="${safeHref(link)}" target="_blank">${escapeHtml(title)}</a><br/><i>Source: ${escapeHtml(feed.source)}</i>`,
            eventType: 'conflict', sources: ['gdelt-rss'], confidence: 'reported', published,
          });
          itemIdx++;
        }
      }
      return events;
    }),
  );
  return perFeed.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function GET() {
  const now = Date.now();

  try {
    if (cachedEvents && now - lastFetch < CACHE_TTL) {
      return NextResponse.json(
        { events: cachedEvents, total: cachedEvents.length, timestamp: new Date(lastFetch).toISOString(), source: 'gdelt (cached)' },
        { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
      );
    }

    let events = await fetchGdeltEvents();
    let source = 'GDELT 2.0 GeoJSON API';

    if (events.length === 0) {
      events = await fetchRssEvents();
      source = 'OSINT RSS Mapping (GDELT fallback)';
    }

    // Apply clustering so callers get deduplicated results
    const clustered = clusterEvents(events);
    cachedEvents = clustered;
    lastFetch = now;

    return NextResponse.json(
      { events: clustered, total: clustered.length, timestamp: new Date().toISOString(), source },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  } catch (error) {
    console.error('[OSIRIS] GDELT shim error:', error);
    if (cachedEvents) {
      return NextResponse.json(
        { events: cachedEvents, total: cachedEvents.length, timestamp: new Date(lastFetch).toISOString(), source: 'stale cache' },
      );
    }
    return NextResponse.json({ events: [], total: 0, error: 'Failed to fetch incident data' }, { status: 500 });
  }
}
