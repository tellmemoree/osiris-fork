// Aircraft type database sourced from Mictronics via wiedehopf/tar1090-db.
// Downloads the full 621K-entry CSV (~8.7MB gzip) once per container start,
// decompresses it in memory, and builds a hex → {type, military} lookup table.
// No per-request network calls; no rate-limit risk.
//
// CSV format (semicolon-delimited):
//   icao24hex ; registration ; typeCode ; flags ; description ; ...
// Flags: '10' or '11' = military (empirically verified against known military aircraft).

const CSV_URL = 'https://github.com/wiedehopf/tar1090-db/raw/refs/heads/csv/aircraft.csv.gz';

interface AcEntry { type: string; reg: string; military: boolean }

const db = new Map<string, AcEntry>();
let dbReady: Promise<void> | null = null;

export function loadDb(): Promise<void> {
  if (dbReady) return dbReady;
  dbReady = (async () => {
    const t0 = Date.now();
    try {
      const res = await fetch(CSV_URL, {
        headers: { 'Accept-Encoding': 'gzip' },
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`CSV fetch ${res.status}`);

      const buf = Buffer.from(await res.arrayBuffer());
      const { gunzipSync } = await import('zlib');
      const text = gunzipSync(buf).toString('utf-8');

      let rows = 0;
      for (const line of text.split('\n')) {
        const semi = line.indexOf(';');
        if (semi < 0) continue;
        const hex = line.slice(0, semi).toLowerCase().trim();
        if (!hex) continue;

        const parts = line.split(';');
        const reg   = parts[1]?.trim() ?? '';
        const type  = (parts[2]?.trim() ?? '').toUpperCase();
        const flags = parts[3]?.trim() ?? '';
        // Flags starting with '1' indicate military in the Mictronics DB
        const military = flags.length > 0 && flags[0] === '1';

        db.set(hex, { type, reg, military });
        rows++;
      }
      console.log(`[aircraftDb] loaded ${rows} entries in ${Date.now() - t0}ms`);
    } catch (e) {
      console.warn('[aircraftDb] DB load failed:', e);
    }
  })();
  return dbReady;
}

/**
 * Look up an ICAO24 hex code.
 * Returns empty strings/false when not found — call only after loadDb() resolves.
 */
export function lookupAircraft(hex: string): AcEntry {
  return db.get(hex.toLowerCase()) ?? { type: '', reg: '', military: false };
}
