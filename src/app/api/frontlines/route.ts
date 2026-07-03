
import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fetchDeepState, extractFeatures, type GeoJSONFeatureCollection } from '@/lib/deepstate';
import { computeFootprintDelta } from '@/lib/frontline-delta';
import type { FeatureCollection } from 'geojson';

export const dynamic = 'force-dynamic';

// Cache TTL: 30 minutes — frontlines update at most a few times per day.
const SNAPSHOTS_DIR = path.join(process.env.HOME ?? '/root', '.osiris-data', 'frontline-snapshots');
const SNAPSHOT_MAX_AGE_DAYS = 35;

let staleCache: { frontlines: GeoJSONFeatureCollection; timestamp: string } | null = null;

// Militaryland (militaryland.net/ua/front-line/geojson) returns 404 — endpoint is dead.

const SNAPSHOT_DIR = path.join(os.homedir(), '.osiris-data', 'frontline-snapshots');

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

/** Save today's snapshot to SNAPSHOT_DIR/YYYY-MM-DD.json */
async function saveSnapshot(fc: FeatureCollection, date: string): Promise<void> {
  try {
    await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
    const file = path.join(SNAPSHOT_DIR, `${date}.json`);
    await fs.writeFile(file, JSON.stringify(fc), 'utf8');
  } catch (e) {
    console.warn('[OSIRIS] frontlines: snapshot write failed', e instanceof Error ? e.message : e);
  }
}

/** Load a snapshot for a given date. Returns null if not found. */
async function loadSnapshot(date: string): Promise<FeatureCollection | null> {
  try {
    const file = path.join(SNAPSHOT_DIR, `${date}.json`);
    const txt = await fs.readFile(file, 'utf8');
    const fc = JSON.parse(txt);
    if (fc?.type === 'FeatureCollection' && Array.isArray(fc.features)) return fc as FeatureCollection;
  } catch { /* file missing or parse error */ }
  return null;
}

/**
 * Find the most recent snapshot at or before `targetDate` (YYYY-MM-DD).
 * Returns { date, fc } or null if no snapshot exists.
 */
async function nearestSnapshot(targetDate: string): Promise<{ date: string; fc: FeatureCollection } | null> {
  let files: string[];
  try {
    files = await fs.readdir(SNAPSHOT_DIR);
  } catch { return null; }

  // Only YYYY-MM-DD.json files
  const candidates = files
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .filter(d => d <= targetDate)
    .sort()
    .reverse(); // newest first

  for (const date of candidates) {
    const fc = await loadSnapshot(date);
    if (fc) return { date, fc };
  }
  return null;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const deltaParam = searchParams.get('delta');
  const deltaDays = deltaParam ? parseInt(deltaParam, 10) : NaN;

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

  const today = new Date().toISOString().slice(0, 10);
  const timestamp = new Date().toISOString();
  staleCache = { frontlines, timestamp };

  // Persist today's snapshot (non-blocking)
  const currentFC: FeatureCollection = {
    type: 'FeatureCollection',
    features: enriched as any[],
  };
  saveSnapshot(currentFC, today).catch(() => {});

  // ── Delta mode: return directional RU/UA gain polygons ──
  if (!isNaN(deltaDays) && deltaDays > 0) {
    const targetDate = new Date(today + 'T00:00:00Z');
    targetDate.setUTCDate(targetDate.getUTCDate() - deltaDays);
    const targetDateStr = targetDate.toISOString().slice(0, 10);

    const snapshotResult = await nearestSnapshot(targetDateStr);
    if (!snapshotResult) {
      return NextResponse.json(
        {
          ru_gain: { type: 'FeatureCollection', features: [] },
          ua_gain: { type: 'FeatureCollection', features: [] },
          compare_date: targetDateStr,
          actual_compare_date: null,
          note: `No snapshot available for ${targetDateStr} or earlier.`,
          sources: ['DeepState'],
          timestamp,
        },
        { headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600' } }
      );
    }

    const { date: actualDate, fc: pastFC } = snapshotResult;
    const delta = computeFootprintDelta(currentFC, pastFC, actualDate);

    return NextResponse.json(
      {
        ru_gain: delta.ru_gain,
        ua_gain: delta.ua_gain,
        compare_date: targetDateStr,
        actual_compare_date: actualDate,
        sources: ['DeepState'],
        timestamp,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600' } }
    );
  }

  // ── Standard mode: return full frontline FeatureCollection ──
  return NextResponse.json(
    {
      frontlines,
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
