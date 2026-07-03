# OSIRIS Architecture & Development Guide

**Last updated:** 2026-06-16 (agent-maintained, not tracked in git)

This document maps the data flow, layer recipe, API conventions, environment variables, and dev workflow for OSIRIS. Consult it before adding features, data sources, or map layers.

---

## Quick Start: Add a Map Layer (4-Touch Recipe)

Every map layer requires 4 touches:

1. **Backend route** — `/src/app/api/<layer>/route.ts` — fetch, shape, cache (module-level, no bbox params)
2. **Polling interval** — `src/app/page.tsx` — add `setInterval(() => fetchEndpoint('/api/<layer>'), POLL_RATE)` with appropriate TTL (5 min, 1 min, 10 sec, 30 min, 1 hour, etc.)
3. **MapLibre source & layer** — `OsirisMap.tsx` — `useEffect` with addSource/addLayer (triggered when data updates, not on pan/zoom)
4. **LayerPanel toggle** — `LayerPanel.tsx` — add checkbox to enable/disable

**Example:** Adding thermal strikes (already implemented):
- Route: `/api/strategic-thermal/route.ts` → module-level cache, queries NASA FIRMS + `/api/news`, merges results
- Polling: `page.tsx` has `setInterval(() => fetchEndpoint('/api/strategic-thermal', d => ({ thermal_aoi: d.aois })), 3600000)` (1 hour)
- Types: Defined inline in route (no shared types file); GeoJSON with `{ type: "Feature", geometry: { type: "Point", coordinates }, properties: { site, confidence, ... } }`
- Map: `OsirisMap.tsx` adds `addSource("thermal-aoi", { type: "geojson", data: geoJsonData })`; `addLayer({ id: "thermal-aoi", source: "thermal-aoi", ... })`
- Panel: `LayerPanel.tsx` checkbox wired to `setVisibleLayers(prev => ({ ...prev, thermal_aoi: !prev.thermal_aoi }))`

---

## File Structure

```
osiris/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Root map component (mounts OsirisMap, panels)
│   │   ├── layout.tsx            # HTML shell, globals CSS
│   │   ├── api/
│   │   │   ├── <layer>/route.ts  # ~50 routes: flights, thermal, news, etc.
│   │   │   └── osint/
│   │   │       ├── dns/
│   │   │       ├── shodan/
│   │   │       └── ... (16-tab suite)
│   │   └── globals.css           # Tailwind + custom CSS vars
│   ├── components/
│   │   ├── OsirisMap.tsx         # MapLibre canvas + layer rendering
│   │   ├── LayerPanel.tsx        # Layer control sidebar (10 groups, ~30 layers)
│   │   ├── page.tsx panels
│   │   ├── CameraViewer.tsx
│   │   ├── AxisBriefing.tsx
│   │   ├── IntelFeed.tsx
│   │   ├── FrontlineTracker.tsx
│   │   ├── EntityGraphPanel.tsx
│   │   ├── OsintPanel.tsx
│   │   ├── MarketsPanel.tsx
│   │   ├── ScmPanel.tsx
│   │   ├── NotificationDrawer.tsx
│   │   ├── KeyboardShortcuts.tsx
│   │   ├── SearchBar.tsx
│   │   └── ... (15+ panels total)
│   ├── lib/
│   │   ├── sdk/types.ts          # Core types (Lattice SDK types; define new types here or inline in routes)
│   │   ├── stealthFetch.ts       # Hardened fetch (user-agent rotation, retry)
│   │   ├── telegram-threats.ts   # Scraper corpus; route-wave builder
│   │   ├── alarm-history.ts      # Air-raid history + cross-referencing
│   │   ├── deepstate.ts          # DeepState API client
│   │   ├── shadowFleet.ts        # Shadow fleet IMO/MMSI lookup
│   │   ├── ssrf-guard.ts         # SSRF / host validation
│   │   ├── entitySearch.ts       # Entity fuzzy search
│   │   ├── osint-utils.ts        # Shared OSINT helpers
│   │   └── sdk/ (Lattice SDK adapter)
│   └── middleware.ts             # Request auth / filtering
├── public/                        # Static assets (icons, GeoJSON)
├── docs/
│   └── features.md               # Feature inventory (keep in sync)
├── next.config.ts                # Next.js config (routes, env vars)
├── tsconfig.json                 # TypeScript config
├── tailwind.config.ts            # Tailwind config (Ghost Protocol theme)
├── package.json                  # Dependencies
└── docker-compose.yml (in parent)
```

---

## Data Flow

### Map Layer Flow (interval-based polling in page.tsx)

Layer data is fetched on fixed schedules (not pan/zoom-driven) in `src/app/page.tsx` via `setInterval`, at varying rates per layer:

```
page.tsx (useEffect)
  └─ setInterval(() => fetchEndpoint('/api/<layer>'), POLL_RATE)
      └─ /api/<layer>/route.ts
          ├─ Module-level cache (let cachedData, let lastFetchTime, const CACHE_TTL)
          ├─ External API (FIRMS, USGS, adsb.lol, etc.) if cache miss or stale
          ├─ Local data store (~/.osiris-data/*) for state persistence
          └─ GeoJSON response
              └─ OsirisMap.tsx renders via addSource + addLayer
```

**Poll rates** (from page.tsx):
- Flights, balloons, radiation, captures: 5 min
- Maritime (ships), air-raids, drones, missiles, KAB: 1 min
- Maritime (ships only): 10 sec
- Earthquakes, markets, power-outages: 5 min
- Frontlines: 30 min
- Air quality, thermal AOI: 1 hour

**Note:** Routes do **not** accept `bbox=` query parameters. Fetching is global per layer, not viewport-aware.

### Correlated Events Aggregator

```
/api/correlated-events                       ← Multi-signal correlation (air-raid + weapon + kab + drone + missile)
  ├─ Self-fetches: /api/air-raids, /api/weapon-threats, /api/kab-threats,
  │               /api/drone-threats, /api/missile-threats
  ├─ Promise.allSettled + AbortSignal.timeout(8000) per source (failed source → skipped)
  ├─ 60-minute rolling window; missile route flattens routes[].waves[].waypoints[]
  ├─ Join: emit CorrelatedEvent per oblast with ≥ 2 distinct signal types
  ├─ alarm_confirmed = true when 'air_raid' type is present for that oblast
  ├─ match_tightness_min = (maxTs - minTs) / 60_000 across all signals
  ├─ 60s module-level cache + inflight-coalescence; stale-on-error fallback
  ├─ Env: OSIRIS_SELF_ORIGIN (default http://localhost:3001)
  └─ Exports: Signal, CorrelatedEvent, CorrelatedEventsResponse (panel imports these)
```

### Conflict Event Aggregator

```
/api/conflict-events                         ← PRIMARY (replaces /api/gdelt)
  ├─ GDELT GEO 2.0 (frequently 404; best-effort, no auth)
  ├─ GDELT RSS (12 feeds: BBC/AJ/ISW/Ukrinform etc; parallel fetch)
  ├─ Telegram corpus via telegram-threats.ts:extractGeoEvents()
  ├─ UCDP GED Events /api/gedevents/ (requires UCDP_ACCESS_TOKEN; optional)
  ├─ ReliefWeb v2 (requires RELIEFWEB_APPNAME; currently stubbed/403)
  ├─ src/lib/conflict-geo.ts — shared GEO_DICT, RSS_FEEDS, clusterEvents()
  ├─ 0.3°/2h spatial+temporal dedup → confidence tiers by source *family*
  │     confirmed   = ≥2 distinct source families (gdelt+gdelt-rss = 1 family)
  │     reported    = 1 non-telegram source
  │     unverified  = telegram-only
  ├─ 5-min module-level cache; stale fallback only on total (all-rejected) failure
  └─ GeoJSON dots colored by confidence tier on global_incidents layer

/api/gdelt                                   ← DEPRECATED SHIM (do not add callers)
  ├─ Exists only for: /api/health, /api/stats, /api/scm-suppliers
  ├─ Returns same { events, total, timestamp, source } shape as before
  └─ Migrate callers to /api/conflict-events and delete this file
```

### Entity Graph (osiris-intel container, port 4000)

```
/api/entity/expand → proxy → http://osiris-intel:4000/resolve
  ├─ Aircraft: ICAO airline SPARQL, FAA N-number registry, expanded registration prefix table
  ├─ Vessel:  Wikidata name search (wdSearch) + IMO/owner/flag/tonnage/year SPARQL
  ├─ Company: Wikidata (wdSearch) + OpenCorporates officers/jurisdiction (500 req/day free)
  ├─ Person:  Wikidata SPARQL (birth date, nationality, positions)
  ├─ IP:      ip-api.com + RIPEstat ASN + Shodan ports/CVEs + AbuseIPDB reputation
  ├─ Country: Wikidata SPARQL (capital, leader, neighbors)
  └─ Sanctions: OFAC SDN + EU FSF + UN SC + UK HMT (OpenSanctions CSV, 24h refresh, tagged per list)

Rebuild: docker compose build osiris-intel && docker compose up -d osiris-intel
Env vars required for full enrichment: SHODAN_API_KEY (in osiris container .env), ABUSEIPDB_KEY
```

### Intelligence Feed Flow

```
/api/news
  ├─ RSS feeds (Ukrainian news outlets)
  ├─ Telegram scraper (Ukrainian channels)
  ├─ Place extraction (nominatim, Gazetteer)
  ├─ 24h cache (news-cache.json)
  └─ GeoJSON articles + risk scores

/api/strategic-thermal
  ├─ NASA FIRMS API (M5 detections, 48h window)
  ├─ /api/news cross-reference (match article → fire)
  ├─ Site catalogue (~80 strategic RU targets)
  ├─ Confidence tiers: high, med, low, news
  └─ thermal-hits.json (48h confirmation history)

/api/drone-threats, /api/missile-threats
  ├─ Telegram UA channels (1.5h window, 15-min cache)
  ├─ telegram-threats.ts: buildRoute() for temporal waves
  ├─ Alarm cross-ref (air-raid-history.json)
  └─ Route polylines + alarm-confirmed rings
```

### Live AIS / ADS-B Flow

```
/api/maritime
  ├─ aisstream.io WebSocket + caching
  ├─ Shadow fleet MMSI lookup (shadow-mmsi.json)
  └─ GeoJSON vessel positions + flags + types

/api/flights
  ├─ adsb.lol (6 global regions, sequential sweep)
  ├─ Per-region caching + 429 mitigation
  ├─ NACp ≤ 4 → GPS jamming markers
  └─ Aircraft + heli icons + callsign popups
```

---

## API Route Conventions

### Standard Route Structure

Routes use **module-level caching** (not shared utilities). Example from `/api/flights`:

```typescript
// /src/app/api/<layer>/route.ts
import { NextResponse } from "next/server";

// Module-level cache (reused across requests, cleared on restart)
let cachedData: GeoJSON | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 45000; // milliseconds (45 seconds)

export async function GET() {
  const now = Date.now();
  
  try {
    // 1. Return cached if fresh
    if (cachedData && (now - lastFetchTime) < CACHE_TTL) {
      return NextResponse.json(cachedData, {
        headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" }
      });
    }
    
    // 2. Fetch from external source (or fallback to stale cache on error)
    const data = await fetchExternal();
    
    // 3. Shape to GeoJSON
    const geojson = {
      type: "FeatureCollection",
      features: data.map(item => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: { ... }
      }))
    };
    
    // 4. Update cache
    cachedData = geojson;
    lastFetchTime = now;
    
    return NextResponse.json(geojson, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" }
    });
  } catch (error) {
    // Fallback: return stale cache if available
    if (cachedData) return NextResponse.json(cachedData);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
```

**Do not create a shared `getCached()/setCached()` utility.** Each route owns its module-level cache.

### Caching Patterns

- **Hard cache:** `~/.osiris-data/<file>.json` (persistent disk store for state)
- **HTTP cache:** Response `Cache-Control: max-age=300` (5 min browser cache)
- **In-memory cache:** Map in route handler (cleared on restart)

**When to persist:**
- Air-raid history (immutable historical snapshots)
- Shadow fleet MMSI mappings (learned state)
- Frontline snapshots (delta detection)
- Thermal hits (confirmation history)
- Drone / missile / KAB route-track entries (`drone-route-tracks.json`, `missile-route-tracks.json`, `kab-tracks.json`) — rolling 24h/12h/6h windows via `loadTrackEntries` / `mergeAndSaveTracks` in `src/lib/threat-tracks.ts`; seeds in-memory accumulator on cold-start so layers survive Docker rebuilds

### Error Handling

- **External API 429/timeout** → return cached data if available, else `{ error: "..." }`
- **Invalid bbox** → `{ error: "Invalid bbox format" }`
- **Auth required** → set env var; fallback to public/free API if available

---

## Environment Variables

**Source of truth:** `.env.example` — copy to `.env` and fill values.

### Actual Environment Variables

```
# Maritime tracking
AIS_API_KEY                    # aisstream.io — live vessel positions (aisstream API key)

# OSINT enrichment
SHODAN_API_KEY                 # IP intel: open ports, CVEs, tags — free tier works; read by osiris-intel container
ABUSEIPDB_KEY                  # IP abuse reputation (api.abuseipdb.com) — get free key at abuseipdb.com
OPENSANCTIONS_API_KEY          # OpenSanctions entity API (structured props: IMO, passport, registration) — free key at opensanctions.org/api/
CENSYS_API_ID                  # Censys API ID (PAT or legacy key)
CENSYS_API_SECRET              # Optional; only for legacy key+secret auth

# Telegram push alerts
TELEGRAM_BOT_TOKEN             # Created via @BotFather; for /api/digest + threshold alerts
TELEGRAM_CHAT_ID               # Chat ID from @userinfobot

# Camera & infrastructure (optional)
WINDY_WEBCAM_KEY               # Windy API (free tier 500 req/day); expands CCTV coverage
GITHUB_WEBHOOK_SECRET          # GitHub webhook signature verification (skipped if unset)
SDK_INGEST_KEY                 # Lattice SDK auth for /api/sdk/ingest (fallback: 'polybolos-dev-key')
UMAMI_WEBSITE_ID               # Analytics (fallback: hardcoded in middleware)
SHADOW_FLEET_SOURCE_URL        # Override OFAC SDN source (fallback: treasury.gov)
OSIRIS_SELF_ORIGIN             # Base URL for /api/oblast-pressure internal self-fetch (default: http://localhost:3001)

# Conflict event aggregator (optional upgrades to /api/conflict-events)
UCDP_ACCESS_TOKEN              # Free token from ucdpapi.pcr.uu.se; enables UCDP GED events layer
RELIEFWEB_APPNAME              # appname from reliefweb.int app registration; currently stubbed (403 until approved)

# UI flags (cosmetic only)
NEXT_PUBLIC_TG_ENABLED         # Set to '1' when Telegram is configured; shows badge only
```

To add an env var:
1. Add to `.env` (and `.env.example` so others see it)
2. Read in route with `process.env.VAR_NAME` (routes, not `next.config.ts`)
3. Document above and in the route code comment

---

## Rebuild + Restart :3001

**After ANY code change**, rebuild the app in Docker:

```bash
# From parent directory
docker compose -f ~/osiris/docker-compose.yml build osiris && \
docker compose -f ~/osiris/docker-compose.yml up -d osiris && \
sleep 2 && curl http://localhost:3001/api/health
```

Why? `next start` does **not** hot-reload. The dev server `:3001` is running `next start`, not `next dev`. Build output is baked into the container.

**Health check:** Verify `/api/health` returns `{ status: "operational", platform: "OSIRIS", uptime: <seconds>, ... }` before testing.

---

## Known-Dead Upstreams & Fallbacks

| Upstream | Status | Fallback |
|----------|--------|----------|
| Turkey CCTV (Windy.com) | ❌ Blocked by X-Frame-Options | Removed; empty array stub kept |
| Telegram t.me/s/ embeds | ⚠️ Flaky (channel owner can disable) | Not geoblocking; check channel settings |

---

## Layer Panel Organization

LayerPanel.tsx organizes layers into 10 groups:

```
┌─ SDK
├─ Aviation (Flights, Private, Jets, Military)
├─ Maritime & Space (Ships, Shadow Fleet, Cables, Satellites)
├─ Surveillance (CCTV, News, Live News Feeds)
├─ Natural Hazards (Earthquakes, Fires, Weather, Air Quality)
├─ Threats & Infrastructure (Nuclear, Global Incidents, GPS Jamming)
├─ Ukraine War (Frontline, Thermal, Captures, Raids, KAB, Drones, Missiles, Power)
├─ Russia (RU Air Raids)
├─ Network Intel (Internet Outages, Malware)
└─ Display (Day/Night Cycle)
```

To add a layer to the panel:
1. Add toggle in `LayerPanel.tsx` under the correct group
2. Bind to `visibleLayers` state
3. Pass to `OsirisMap.tsx` to control visibility

---

## Theming

Two themes, CSS-var based:

### Core (default)
```css
--bg-primary: #0a1428;
--text-primary: #e0e0e0;
--accent: #00d9ff;      /* Cyan for aviation */
--alert: #ff6b6b;
```

### Ghost Protocol (W24)
```css
--bg-void: #05000f;
--accent: #b388ff;      /* Phantom purple */
--cctv-color: #b388ff;  /* Purple CCTV */
```

Toggle via LayerPanel switch. CSS cascade ensures all panels adapt automatically via `var()` references.

---

## Keyboard Shortcuts

Defined in `KeyboardShortcuts.tsx`. Add shortcuts via:

```typescript
const shortcuts = [
  { key: "t", action: "Toggle thermal layer", handler: () => toggleLayer("thermal_aoi") },
  { key: "?", action: "Show this menu", handler: () => setShowShortcuts(!showShortcuts) },
];
```

---

## Git Workflow

### Branch Model
- **osiris-Ukraine:** Working branch (feature branches merge here)
- **osiris-Ukraine-merged:** Stable branch (tested, ready for deployment)
- **Feature branches:** `feat/<name>` from `osiris-Ukraine`, one feature per branch

### Commit Conventions
```
feat(domain): description
fix(domain): description
chore(domain): description
ci(domain): description
```

Example: `feat(thermal): add TANECO site + match news snippets`

### PR Workflow
1. Push to feature branch
2. Create PR (base: `osiris-Ukraine`)
3. User tests + merges
4. After testing, user promotes: `osiris-Ukraine` → `osiris-Ukraine-merged`

### Hotfix Exception
Only when explicitly marked "hotfix":
- Merge directly to `osiris-Ukraine` + tag
- Auto-merge to `osiris-Ukraine-merged` via CI

---

## Active Bugs & Regression Tracking

| Issue | Status | Notes |
|-------|--------|-------|
| Aviation 0-planes on cold start | 🔧 In-flight | adsb.lol 429s on parallel fan-out; sequential sweep + per-region cache in `live/week25-integration` (not yet merged to osiris-Ukraine) |
| Earthquakes layer W25 regression | 🔧 Investigating | Renders on W24, not on `week25-integration`; API has data; likely client-side interaction bug |
| Thermal AOI misses | 🔄 In-progress | Site catalogue expanded (TANECO, TAIF-NK, Nizhnekamsk, Poltavskaya/Slavyansk-na-Kubani, Taman); location-aware snippets merged (96ad4f9, 63e07f5). **Pending:** NASA FIRMS map key to enable 24–48h area API (currently 12h active window + free tier only). |

---

## Testing

- Unit tests: Jest + React Testing Library (run via `npm test`)
- Integration: Spin up `:3001`, navigate map, check console for errors
- Regression: Test all layer toggles + panel interactions after merging

No automated e2e tests yet; manual inspection required for new features.

---

## Deployment

### Local Docker
```bash
docker compose -f ~/osiris/docker-compose.yml up -d
```

### Accessing
```
Map:   http://localhost:3001
API:   http://localhost:3001/api/<route>
Logs:  docker logs osiris-container
```

### Health Checks
```bash
curl http://localhost:3001/api/health
curl http://localhost:3001/api/stats
```

---

## Quick Reference: Adding a Feature

### 1. Add a new data layer

```
Step 1: Create /api/<layer>/route.ts with module-level cache (let cachedData, let lastFetchTime, const CACHE_TTL)
Step 2: Add setInterval polling in src/app/page.tsx (choose poll rate: 10s, 1 min, 5 min, 30 min, or 1 hour)
Step 3: Define GeoJSON types inline in the route handler (do not create src/lib/types.ts)
Step 4: Add addSource + addLayer in OsirisMap.tsx useEffect (keyed on data changes, not pan/zoom)
Step 5: Add toggle checkbox in LayerPanel.tsx under the correct group (Aviation, Maritime, Ukraine War, etc.)
Step 6: Test layer visibility + popups + zoom interactions in browser at http://localhost:3001
```

### 2. Add a new panel

```
Step 1: Create src/components/<PanelName>.tsx
Step 2: Add useState + useEffect for data fetching
Step 3: Mount in src/app/page.tsx
Step 4: Add panel toggle in LayerPanel.tsx
Step 5: Test panel open/close + responsive layout
```

### 3. Add a new API endpoint

```
Step 1: Create /api/<route>/route.ts
Step 2: Implement GET/POST handlers
Step 3: Test with curl or browser
Step 4: Document in this ARCHITECTURE.md
Step 5: Add to features.md if it's user-facing
```

---

## Troubleshooting

### Map doesn't load (`OsirisMap.tsx` error)
- Check MapLibre key is set (if using hosted tiles)
- Check `/api/health` returns 200
- Check browser console for CORS errors

### Layer shows 0 features
- Check `/api/<layer>` (no bbox param) returns valid GeoJSON with features array
- Check browser Network tab to confirm the API call succeeded (not 429, 500, or timeout)
- Check layer visibility is enabled in LayerPanel
- Check the route is returning the data in the correct GeoJSON format

### External API 429 / rate limit
- Check if fallback cache is being used
- Check if env var is set for paid tier (if available)
- Check `stealthFetch` is using user-agent rotation

### Thermal AOI missing a strike
- Check if strike is within 48h window
- Check if site is in the catalogue (~80 strategic RU targets)
- Check if news source has covered the event
- Consider adding to site catalogue if false negative

---

## Further Reading

- `docs/features.md` — Living feature inventory
- `AGENTS.md` — Next.js 16 gotchas + agent conventions
- `/api/health`, `/api/stats` — Monitoring endpoints
