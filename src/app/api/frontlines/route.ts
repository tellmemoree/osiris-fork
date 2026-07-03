
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { fetchDeepState, extractFeatures, type GeoJSONFeatureCollection } from '@/lib/deepstate';

export const dynamic = 'force-dynamic';

// Cache TTL: 30 minutes — frontlines update at most a few times per day.
const SNAPSHOTS_DIR = path.join(process.env.HOME ?? '/root', '.osiris-data', 'frontline-snapshots');
const SNAPSHOT_MAX_AGE_DAYS = 35;

let staleCache: { frontlines: GeoJSONFeatureCollection; timestamp: string } | null = null;

// Militaryland (militaryland.net/ua/front-line/geojson) returns 404 — endpoint is dead.

function parseStatus(name: string): { statusKey: string; statusLabel: string } {
  if (name.includes('geoJSON.status.dismissed_at')) return { statusKey: 'dismissed_at', statusLabel: 'Liberated' };
  if (name.includes('geoJSON.status.dismissed'))    return { statusKey: 'dismissed',    statusLabel: 'Liberated' };
  if (name.includes('geoJSON.status.occupied'))     return { statusKey: 'occupied',     statusLabel: 'Occupied' };
  if (name.includes('geoJSON.status.unknown'))      return { statusKey: 'unknown',      statusLabel: 'Unknown Status' };
  if (name.includes('geoJSON.status.attack_direction')) return { statusKey: 'attack_direction', statusLabel: 'Attack Direction' };
  return { statusKey: 'other', statusLabel: '' };
}

function extractEnglish(text: string): string {
  const parts = text.split('///');
  const en = parts.find(p => /[a-zA-Z]{3}/.test(p) && !p.trim().startsWith('geoJSON'));
  return en ? en.trim() : '';
}

function stripHtml(html: string): string {
  // Strip well-formed tags, then drop any leftover stray angle brackets so an
  // UNTERMINATED tag (e.g. `<svg/onload=...` with no closing `>`) can't survive
  // and be auto-completed by the browser's HTML parser downstream. The popup
  // also escapes this value with esc(), but neutralise it server-side too.
  return html.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// Parse liberation date from name like "{{at:25.03}}" — all are 2022 (Kyiv/Kharkiv pullback)
function parseDismissedDate(name: string): string | null {
  const m = name.match(/\{\{at:([^}]+)\}\}/);
  if (!m) return null;
  const first = m[1].trim().split(/[\s–\-]+/)[0].trim();
  const parts = first.split('.');
  if (parts.length < 2) return null;
  const [day, month] = parts;
  return `2022-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function enrichFeatures(features: unknown[]): unknown[] {
  return features.map((f: any) => {
    const props = f?.properties || {};
    const name: string = props.name || '';
    const desc: string = props.description || '';
    const { statusKey, statusLabel } = parseStatus(name);
    const descriptionEn = extractEnglish(stripHtml(desc));
    const eventDate = statusKey === 'dismissed_at' ? parseDismissedDate(name) : null;

    return {
      ...f,
      properties: {
        ...props,
        statusKey,
        statusLabel,
        descriptionEn,
        ...(eventDate ? { eventDate } : {}),
      },
    };
  });
}

/**
 * Write today's snapshot to ~/.osiris-data/frontline-snapshots/YYYY-MM-DD.json.
 * Only writes if the file doesn't already exist.
 * Prunes files older than SNAPSHOT_MAX_AGE_DAYS days when writing.
 */
function maybeWriteSnapshot(frontlines: GeoJSONFeatureCollection): void {
  try {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const todayFile = path.join(SNAPSHOTS_DIR, `${today}.json`);

    if (fs.existsSync(todayFile)) return;

    // Prune old snapshots before writing.
    try {
      const cutoff = Date.now() - SNAPSHOT_MAX_AGE_DAYS * 86_400_000;
      const entries = fs.readdirSync(SNAPSHOTS_DIR);
      for (const entry of entries) {
        if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(entry)) continue;
        const dateStr = entry.slice(0, 10);
        const entryMs = new Date(dateStr).getTime();
        if (!isNaN(entryMs) && entryMs < cutoff) {
          try { fs.unlinkSync(path.join(SNAPSHOTS_DIR, entry)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore cleanup errors */ }

    fs.writeFileSync(todayFile, JSON.stringify(frontlines));
  } catch { /* never crash the request on snapshot IO */ }
}

/**
 * Load the snapshot from deltaDays ago, if it exists.
 * Returns null when the file is missing or unparseable.
 */
function loadDeltaSnapshot(deltaDays: number): GeoJSONFeatureCollection | null {
  try {
    const pastDate = new Date(Date.now() - deltaDays * 86_400_000);
    const pastFile = path.join(SNAPSHOTS_DIR, `${pastDate.toISOString().slice(0, 10)}.json`);
    if (fs.existsSync(pastFile)) {
      try { return JSON.parse(fs.readFileSync(pastFile, 'utf8')); } catch { /* unparseable */ }
    }
  } catch { /* ignore */ }
  return null;
}

export async function GET(request: Request) {
  // Parse ?delta=N (1–90 days).
  const url = new URL(request.url);
  const deltaParam = url.searchParams.get('delta');
  const deltaDays = deltaParam ? Math.min(90, Math.max(1, parseInt(deltaParam, 10))) : null;

  let deepStateData: GeoJSONFeatureCollection;
  try {
    deepStateData = await fetchDeepState();
  } catch (reason) {
    console.error('Frontlines fetch error (DeepState):', reason);
    if (staleCache) {
      return NextResponse.json(
        { ...staleCache, sources: ['DeepState'], stale: true, delta_frontlines: null },
        { headers: { 'Cache-Control': 'no-store', 'X-Stale': 'true' } }
      );
    }
    return NextResponse.json(
      { frontlines: null, error: 'DeepState unavailable' },
      { status: 502 }
    );
  }

  const raw = extractFeatures(deepStateData);
  const enriched = enrichFeatures(raw);

  // Drop territories liberated before 2026 — all dismissed/dismissed_at entries are
  // 2022 pullback areas (Kyiv, Bucha, Irpin, Kharkiv oblast, etc.).
  const filtered = enriched.filter((f: any) => {
    const sk = f?.properties?.statusKey;
    return sk !== 'dismissed' && sk !== 'dismissed_at';
  });

  const frontlines: GeoJSONFeatureCollection = {
    type: 'FeatureCollection',
    features: filtered,
  };

  const timestamp = new Date().toISOString();
  staleCache = { frontlines, timestamp };

  // Persist today's snapshot; prunes files older than 35 days.
  maybeWriteSnapshot(frontlines);

  // Load historical snapshot for delta comparison.
  const delta_frontlines: GeoJSONFeatureCollection | null =
    deltaDays !== null ? loadDeltaSnapshot(deltaDays) : null;

  return NextResponse.json(
    {
      frontlines,
      delta_frontlines,
      sources: ['DeepState'],
      timestamp,
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
      },
    }
  );
}
