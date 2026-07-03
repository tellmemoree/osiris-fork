import { NextResponse } from 'next/server';
import { stealthFetch } from '@/lib/stealthFetch';
import { fetchAsfinagCameras } from './asfinag';
import { fetchBulgariaCameras } from './bulgaria';
import { fetchGreeceCameras } from './greece';
import { fetchSerbiaCameras } from './serbia';
import { fetchMacedoniaCameras } from './macedonia';
import { fetchTurkeyCameras } from './turkey';
import { fetchRomaniaCameras } from './romania';
import { fetchAustraliaCameras } from './australia';
import { fetchItalyCameras } from './italy';
import { fetchCzechiaCameras } from './czechia';
import { fetchSlovakiaCameras } from './slovakia';
import { fetchGermanyCameras } from './germany';
import { fetchFranceCameras } from './france';
import { fetchSpainCameras } from './spain';
import { fetchPolandCameras } from './poland';
import { fetchJapanCameras } from './japan';

/**
 * OSIRIS — Worldwide CCTV Camera API v2
 * Viewport-aware: pass ?region=xx to load cameras for specific regions
 * Supports: uk, us-east, us-west, us-central, canada, europe, asia
 * Or pass ?lat=x&lng=y&radius=5 for proximity-based loading
 */

// ═══ CAMERA SOURCE DEFINITIONS ═══

// Normalized camera marker emitted by every source fetcher.
interface Camera {
  id: string;
  lat: number;
  lng: number;
  name: string;
  city: string;
  country: string;
  feed_url?: string;
  external_url?: string;
  // Embedded live streams (e.g. YouTube iframe) — used by curated Middle East cams.
  stream_url?: string;
  stream_type?: string;
  source: string;
}

// ── UK: Transport for London JamCams (~900) ──
async function fetchTfLCameras(): Promise<Camera[]> {
  try {
    const res = await stealthFetch('https://api.tfl.gov.uk/Place/Type/JamCam', { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data || []).map((cam: { id?: string; lat?: number; lon?: number; commonName?: string; additionalProperties?: { key?: string; value?: string }[] }) => {
      const imgProp = cam.additionalProperties?.find((p) => p.key === 'imageUrl');
      const camId = cam.id?.replace('JamCams_', '') || '';
      return {
        id: `tfl-${cam.id}`, lat: cam.lat, lng: cam.lon,
        name: cam.commonName || 'London JamCam', city: 'London', country: 'UK',
        feed_url: imgProp?.value || `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${camId}.jpg`,
        source: 'TfL',
      };
    }).filter((c: Camera) => c.lat && c.lng);
  } catch { return []; }
}

// ── US-WEST: WSDOT Washington State (~500) ──
async function fetchWSDOTCameras(): Promise<Camera[]> {
  try {
    const res = await stealthFetch('https://data.wsdot.wa.gov/log/public/cameras.json', { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data || []).map((cam: { CameraID?: string | number; CameraLocation?: { Latitude?: number; Longitude?: number }; Title?: string; ImageURL?: string }) => ({
      id: `wsdot-${cam.CameraID}`, lat: cam.CameraLocation?.Latitude, lng: cam.CameraLocation?.Longitude,
      name: cam.Title || 'WSDOT Camera', city: 'Washington', country: 'US',
      feed_url: cam.ImageURL || '', source: 'WSDOT',
    })).filter((c: Camera) => c.lat && c.lng && c.feed_url);
  } catch { return []; }
}

// ── US-WEST: Caltrans California Districts ──
// Districts fetched in parallel — a sequential loop here previously chained 9
// awaits (~5s) and, behind the WSDOT stall, pushed the us-west region past the
// client timeout.
async function fetchCaltransCameras(): Promise<Camera[]> {
  const districts = ['d03', 'd04', 'd05', 'd06', 'd07', 'd08', 'd10', 'd11', 'd12'];
  const perDistrict = await Promise.all(districts.map(async (dist) => {
    const cams: Camera[] = [];
    try {
      const res = await stealthFetch(`https://cwwp2.dot.ca.gov/data/${dist}/cctv/cctvStatus${dist.toUpperCase()}.json`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return cams;
      const data = await res.json();
      for (const cam of (data?.data || [])) {
        const lat = parseFloat(cam.location?.latitude);
        const lng = parseFloat(cam.location?.longitude);
        const url = cam.cctv?.imageData?.static?.currentImageURL;
        if (!lat || !lng || !url) continue;
        cams.push({ id: `cal-${dist}-${cams.length}`, lat, lng, name: cam.location?.locationName || 'Caltrans', city: 'California', country: 'US', feed_url: url, source: 'Caltrans' });
      }
    } catch { /* silent */ }
    return cams;
  }));
  return perDistrict.flat();
}

// ── CANADA: Ottawa, Toronto, Montreal, Quebec ──
async function fetchCanadaCameras(): Promise<Camera[]> {
  const cams: Camera[] = [];

  // Ottawa Municipal Cameras (live API)
  try {
    const res = await stealthFetch('https://traffic.ottawa.ca/beta/camera_list', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data || [])) {
        if (!cam.latitude || !cam.longitude) continue;
        cams.push({
          id: `ottawa-muni-${cam.id}`, lat: cam.latitude, lng: cam.longitude,
          name: cam.description || 'Ottawa Traffic Camera', city: 'Ottawa', country: 'Canada',
          feed_url: `https://traffic.ottawa.ca/map/camera?id=${cam.number || cam.id}`, source: 'City of Ottawa',
        });
      }
    }
  } catch { /* silent */ }

  // Quebec 511 (covers Montreal, Quebec City, highways) — mp4 streams
  try {
    const res = await stealthFetch('https://ws.mapserver.transports.gouv.qc.ca/swtq?service=wfs&version=2.0.0&request=getfeature&typename=ms:infos_cameras&outfile=Camera&srsname=EPSG:4326&outputformat=geojson', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      for (const feature of (data.features || [])) {
        const coords = feature.geometry?.coordinates;
        const p = feature.properties;
        if (!coords || !p || !p.IDEcamera) continue;
        cams.push({
          id: `quebec511-${p.IDEcamera}`, lat: coords[1], lng: coords[0],
          name: p.DescriptionLocalisationEn || p.DescriptionLocalisationFr || 'Quebec 511 Camera',
          city: p.NomRegionDiffusion || 'Quebec', country: 'Canada',
          stream_url: p.URL_FLUX_DONNEE
            ? p.URL_FLUX_DONNEE.replace('FenetreVideo.html', 'camera.ashx') + '&format=mp4'
            : `https://www.quebec511.info/Carte/Fenetres/camera.ashx?id=${p.IDEcamera}&format=mp4`,
          stream_type: 'mp4',
          source: 'Quebec 511',
        });
      }
    }
  } catch { /* silent */ }

  // Ontario 511 (MTO Highway Cameras)
  try {
    const res = await stealthFetch('https://511on.ca/api/v2/get/cameras', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data || [])) {
        if (!cam.latitude || !cam.longitude) continue;
        cams.push({
          id: `on-${cam.id || cams.length}`, lat: cam.latitude, lng: cam.longitude,
          name: cam.description || cam.name || 'Ontario Camera', city: 'Ontario', country: 'Canada',
          feed_url: cam.imageUrl || cam.url || '', source: '511 Ontario',
        });
      }
    }
  } catch { /* silent */ }

  // Ville de Montréal municipal cameras
  try {
    const res = await stealthFetch('https://ville.montreal.qc.ca/circulation/sites/ville.montreal.qc.ca.circulation/files/cameras.json', { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data || [])) {
        cams.push({
          id: `mtl-muni-${cams.length}`, lat: cam.latitude || cam.lat, lng: cam.longitude || cam.lng,
          name: cam.description || cam.name || 'Montréal Camera', city: 'Montréal', country: 'Canada',
          feed_url: cam.url || cam.imageUrl || '', source: 'Ville MTL',
        });
      }
    }
  } catch { /* silent */ }

  // Curated Toronto cameras (fallback if 511ON fails)
  const curated = [
    { id: 'tor-1', lat: 43.6532, lng: -79.3832, name: 'Yonge / Dundas Square', city: 'Toronto', country: 'Canada', feed_url: 'https://511on.ca/api/v2/get/cameras', source: '511 Ontario' },
    { id: 'tor-2', lat: 43.6426, lng: -79.3871, name: 'CN Tower / Lakeshore', city: 'Toronto', country: 'Canada', feed_url: 'https://511on.ca/api/v2/get/cameras', source: '511 Ontario' },
    { id: 'tor-3', lat: 43.6711, lng: -79.3868, name: 'Bloor / Yonge', city: 'Toronto', country: 'Canada', feed_url: 'https://511on.ca/api/v2/get/cameras', source: '511 Ontario' },
  ];
  cams.push(...curated);

  // Alberta 511
  try {
    const res = await stealthFetch('https://511.alberta.ca/api/v2/get/cameras', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data || [])) {
        if (!cam.Latitude || !cam.Longitude || !cam.Views?.[0]?.Url) continue;
        cams.push({
          id: `ab-${cam.Id || cams.length}`, lat: cam.Latitude, lng: cam.Longitude,
          name: cam.Location || 'Alberta Camera', city: 'Alberta', country: 'Canada',
          feed_url: cam.Views[0].Url, source: 'Alberta 511',
        });
      }
    }
  } catch { /* silent */ }

  return cams.filter((c: Camera) => c.lat && c.lng);
}

// ── US-CENTRAL: Chicago, Houston, Dallas, Denver ──
async function fetchUSCentralCameras(): Promise<Camera[]> {
  const cams: Camera[] = [];
  // Illinois DOT
  try {
    const res = await stealthFetch('https://www.travelmidwest.com/lmiga/cameraReport.json', { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data?.cameraReports || data || []).slice(0, 800)) {
        if (!cam.latitude || !cam.longitude) continue;
        cams.push({
          id: `ildot-${cams.length}`, lat: cam.latitude, lng: cam.longitude,
          name: cam.cameraName || cam.description || 'IDOT Camera', city: 'Illinois', country: 'US',
          feed_url: cam.imageUrl || cam.url || '', source: 'IDOT',
        });
      }
    }
  } catch { /* silent */ }

  return cams.filter((c: Camera) => c.lat && c.lng);
}

// ── US-EAST: OH, DC, Florida, Georgia ──
async function fetchUSEastCameras(): Promise<Camera[]> {
  const cams: Camera[] = [];

  // Butler County, OH (from redhunt45 fork)
  cams.push(
    {
      id: 'butler-oh-hamilton', lat: 39.3988617, lng: -84.5595353,
      name: 'Hamilton, OH', city: 'Hamilton', country: 'US',
      feed_url: 'https://gsccam.butlersheriff.org/axis-cgi/jpg/image.cgi',
      external_url: 'https://gsccam.butlersheriff.org/camera/index.html#/video',
      source: 'Butler County, OH',
    },
    {
      id: 'butler-oh-129-747', lat: 39.381435, lng: -84.438423,
      name: 'OH-129 at 747', city: 'Butler County', country: 'US',
      feed_url: 'https://towercam.butlersheriff.org/axis-cgi/jpg/image.cgi',
      external_url: 'https://towercam.butlersheriff.org/aca/index.html#view',
      source: 'Butler County, OH',
    },
  );

  // Cincinnati, OH (from redhunt45 fork)
  cams.push(
    {
      id: 'cincinnati-cincyvision-yt', lat: 39.089101, lng: -84.527943,
      name: 'CincyVision YT', city: 'Cincinnati', country: 'US',
      external_url: 'https://www.youtube.com/@AaronPreslin/live',
      source: 'Cincinnati, OH',
    },
    {
      id: 'cincinnati-covington-earthcam', lat: 39.090510, lng: -84.510413,
      name: 'Cincinnati-Covington EarthCam', city: 'Covington', country: 'US',
      external_url: 'https://www.earthcam.com/usa/kentucky/covington/?cam=covington',
      source: 'Cincinnati, OH',
    },
  );
  // Florida 511
  try {
    const res = await stealthFetch('https://fl511.com/api/v2/cameras', { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data || []).slice(0, 800)) {
        if (!cam.latitude || !cam.longitude) continue;
        cams.push({
          id: `fl-${cams.length}`, lat: cam.latitude, lng: cam.longitude,
          name: cam.description || 'FL-511 Camera', city: 'Florida', country: 'US',
          feed_url: cam.imageUrl || '', source: 'FL-511',
        });
      }
    }
  } catch { /* silent */ }

  return cams.filter((c: Camera) => c.lat && c.lng);
}

// ── EUROPE: Netherlands, Germany, France ──
async function fetchEuropeCameras(): Promise<Camera[]> {
  const cams: Camera[] = [];

  // Netherlands Rijkswaterstaat
  try {
    const res = await stealthFetch('https://opendata.ndw.nu/cameras.json', { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data || []).slice(0, 1000)) {
        if (!cam.lat || !cam.lng) continue;
        cams.push({
          id: `nl-${cams.length}`, lat: cam.lat, lng: cam.lng,
          name: cam.name || 'NL Camera', city: 'Netherlands', country: 'NL',
          feed_url: cam.imageUrl || '', source: 'RWS',
        });
      }
    }
  } catch { /* silent */ }

  cams.push(...await fetchAsfinagCameras());

  return cams.filter((c: Camera) => c.lat && c.lng);
}

// ── ASIA/PACIFIC ──
async function fetchAsiaCameras(): Promise<Camera[]> {
  const cams: Camera[] = [];

  // Singapore Live Traffic Images
  try {
    const res = await stealthFetch('https://api.data.gov.sg/v1/transport/traffic-images', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      const items = data.items?.[0]?.cameras || [];
      for (const cam of items) {
        if (!cam.location?.latitude || !cam.location?.longitude || !cam.image) continue;
        cams.push({
          id: `sin-${cam.camera_id}`,
          lat: cam.location.latitude,
          lng: cam.location.longitude,
          name: `Camera ${cam.camera_id}`,
          city: 'Singapore',
          country: 'Singapore',
          feed_url: cam.image,
          source: 'LTA Singapore'
        });
      }
    }
  } catch { /* silent */ }

  return cams;
}

// Windy webcam bbox fetcher — returns active webcams for the given bounding box.
// Gated on WINDY_WEBCAM_KEY (free tier = 500 req/day, register at api.windy.com).
async function fetchWindyCameras(
  minLat: number, minLon: number, maxLat: number, maxLon: number,
  regionPrefix: string,
): Promise<Camera[]> {
  const key = process.env.WINDY_WEBCAM_KEY;
  if (!key) return [];
  try {
    const url = `https://api.windy.com/api/webcams/v2/list/bbox/${minLat},${minLon},${maxLat},${maxLon}?lang=en&show=webcams:location,image,player&key=${key}`;
    const res = await stealthFetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const data = await res.json() as {
      result?: {
        webcams?: {
          id: string; status: string; title?: string;
          location?: { city?: string; country?: string; latitude?: number; longitude?: number };
          image?: { current?: { preview?: string } };
          player?: { day?: { embed?: string } };
        }[];
      };
    };
    return (data?.result?.webcams || [])
      .filter(w => w.status === 'active' && w.location?.latitude && w.location?.longitude)
      .map(w => {
        const embedUrl = w.player?.day?.embed;
        return {
          id: `windy-${regionPrefix}-${w.id}`,
          lat: w.location!.latitude!,
          lng: w.location!.longitude!,
          name: w.title || `${w.location?.city ?? ''} Webcam`,
          city: w.location?.city ?? '',
          country: w.location?.country ?? '',
          feed_url: w.image?.current?.preview || undefined,
          stream_url: embedUrl || undefined,
          stream_type: embedUrl ? ('iframe' as const) : ('jpg' as const),
          source: 'Windy',
        };
      });
  } catch { return []; }
}

async function fetchUkraineCameras(): Promise<Camera[]> {
  const UA_DIR = 'https://www.skylinewebcams.com/en/webcam/ukraine.html';
  const cams: Camera[] = [
    { id: 'ua-cam-kyiv', lat: 50.4501, lng: 30.5234, name: 'Kyiv — live public cams', city: 'Kyiv', country: 'Ukraine', feed_url: 'https://www.earthcam.com/world/ukraine/kiev/', source: 'EarthCam' },
    { id: 'ua-cam-lviv', lat: 49.8397, lng: 24.0297, name: 'Lviv — public webcam directory', city: 'Lviv', country: 'Ukraine', feed_url: UA_DIR, source: 'Skyline (UA)' },
    { id: 'ua-cam-odesa', lat: 46.4825, lng: 30.7233, name: 'Odesa — public webcam directory', city: 'Odesa', country: 'Ukraine', feed_url: UA_DIR, source: 'Skyline (UA)' },
    { id: 'ua-cam-kharkiv', lat: 49.9935, lng: 36.2304, name: 'Kharkiv — public webcam directory', city: 'Kharkiv', country: 'Ukraine', feed_url: UA_DIR, source: 'Skyline (UA)' },
    { id: 'ua-cam-dnipro', lat: 48.4647, lng: 35.0462, name: 'Dnipro — public webcam directory', city: 'Dnipro', country: 'Ukraine', feed_url: UA_DIR, source: 'Skyline (UA)' },
  ];

  // Windy webcams for Ukraine
  const windyCams = await fetchWindyCameras(44, 21.5, 53, 41, 'ua');
  cams.push(...windyCams);

  return cams;
}



// ── MIDDLE EAST: Israel, Lebanon (curated embedded live streams) ──
async function fetchMiddleEastCameras(): Promise<Camera[]> {
  const cams: Camera[] = [];

  // Israel Curated (Embedded)
  cams.push(
    {
      id: 'il-israel-multicam', lat: 32.0853, lng: 34.7818,
      name: 'Israel Multi-Cam (Live)', city: 'Tel Aviv', country: 'Israel',
      stream_url: 'https://www.youtube.com/embed/gmtlJ_m2r5A?autoplay=1&mute=1',
      stream_type: 'iframe',
      source: 'YouTube Live',
    },
    {
      id: 'il-jerusalem-live', lat: 31.7767, lng: 35.2345,
      name: 'Jerusalem Western Wall', city: 'Jerusalem', country: 'Israel',
      stream_url: 'https://www.youtube.com/embed/77akujLn4k8?autoplay=1&mute=1',
      stream_type: 'iframe',
      source: 'YouTube Live',
    }
  );

  // Lebanon Curated (Embedded)
  cams.push(
    {
      id: 'lb-beirut-skyline', lat: 33.8938, lng: 35.5018,
      name: 'Beirut Skyline Live', city: 'Beirut', country: 'Lebanon',
      stream_url: 'https://www.youtube.com/embed/qJf4NqPKLjI?autoplay=1&mute=1',
      stream_type: 'iframe',
      source: 'YouTube Live',
    },
    {
      id: 'lb-me-multicam', lat: 33.2721, lng: 35.2033,
      name: 'Middle East Multi-Cam (Live)', city: 'Regional', country: 'Middle East',
      stream_url: 'https://www.youtube.com/embed/oxT5R6I0N6E?autoplay=1&mute=1',
      stream_type: 'iframe',
      source: 'YouTube Live',
    }
  );

  return cams;
}

// ═══ REGION MAPPING ═══
const REGION_FETCHERS: Record<string, () => Promise<Camera[]>> = {
  'middle-east': fetchMiddleEastCameras,
  'ukraine': fetchUkraineCameras,
  'uk': fetchTfLCameras,
  'us-west': async () => {
    const [wsdot, caltrans] = await Promise.all([fetchWSDOTCameras(), fetchCaltransCameras()]);
    return [...wsdot, ...caltrans];
  },
  'us-east': fetchUSEastCameras,
  'us-central': fetchUSCentralCameras,
  'canada': fetchCanadaCameras,
  'europe': fetchEuropeCameras,
  'asia': fetchAsiaCameras,
  'bulgaria': fetchBulgariaCameras,
  'greece': fetchGreeceCameras,
  'serbia': fetchSerbiaCameras,
  'macedonia': fetchMacedoniaCameras,
  'turkey': fetchTurkeyCameras,
  'romania': fetchRomaniaCameras,
  'australia': fetchAustraliaCameras,
  'italy': fetchItalyCameras,
  'czechia': fetchCzechiaCameras,
  'slovakia': fetchSlovakiaCameras,
  'germany': fetchGermanyCameras,
  'france': fetchFranceCameras,
  'spain': fetchSpainCameras,
  'poland': fetchPolandCameras,
  'japan': fetchJapanCameras,
};

// Determine which regions to fetch based on viewport bounds
function getRegionsForBounds(lat: number, lng: number): string[] {
  const regions: string[] = [];
  // UK
  if (lat > 49 && lat < 61 && lng > -8 && lng < 2) regions.push('uk');
  // US-East
  if (lat > 24 && lat < 49 && lng > -85 && lng < -66) regions.push('us-east');
  // US-West
  if (lat > 24 && lat < 49 && lng > -125 && lng < -100) regions.push('us-west');
  // US-Central
  if (lat > 24 && lat < 49 && lng > -105 && lng < -80) regions.push('us-central');
  // Canada
  if (lat > 42 && lat < 70 && lng > -141 && lng < -52) regions.push('canada');
  // Ukraine
  if (lat > 44 && lat < 53 && lng > 21.5 && lng < 41) regions.push('ukraine');
  // Middle East (Israel, Lebanon)
  if (lat > 29 && lat < 34.5 && lng > 34 && lng < 36.5) regions.push('middle-east');
  // Europe
  const inBulgaria = lat > 41 && lat < 44.5 && lng > 22 && lng < 29.5;
  const inGreece = lat > 34.5 && lat < 41.8 && lng > 19 && lng < 30;
  const inSerbia = lat > 42 && lat < 46.5 && lng > 18.8 && lng < 23.3;
  const inMacedonia = lat > 40.8 && lat < 42.8 && lng > 20.4 && lng < 23.2;
  const inRomania = lat > 43.5 && lat < 48.5 && lng > 20 && lng < 29.8;
  const inTurkey = lat > 35.5 && lat < 42.5 && lng > 25.5 && lng < 45;
  const inItaly = lat > 36 && lat < 47.5 && lng > 6.5 && lng < 18.5;
  const inCzechia = lat > 48.5 && lat < 51.1 && lng > 12 && lng < 18.9;
  const inSlovakia = lat > 47.7 && lat < 49.6 && lng > 16.8 && lng < 22.6;
  const inGermany = lat > 47 && lat < 55.1 && lng > 5.8 && lng < 15.1;
  const inFrance = lat > 42.3 && lat < 51.1 && lng > -5 && lng < 8.3;
  const inSpain = lat > 27 && lat < 43.8 && lng > -18.2 && lng < 4.4;
  const inPoland = lat > 49.0 && lat < 54.8 && lng > 14.1 && lng < 24.1;
  const inBalkans = inBulgaria || inGreece || inSerbia || inMacedonia || inRomania || inTurkey;
  const inWesternEurope = inItaly || inCzechia || inSlovakia || inGermany || inFrance || inSpain || inPoland;

  if (lat > 35 && lat < 72 && lng > -11 && lng < 40 && !inBalkans && !inWesternEurope) {
    regions.push('europe');
  }
  if (inBulgaria) regions.push('bulgaria');
  if (inGreece) regions.push('greece');
  if (inSerbia) regions.push('serbia');
  if (inMacedonia) regions.push('macedonia');
  if (inRomania) regions.push('romania');
  if (inTurkey) regions.push('turkey');
  if (inItaly) regions.push('italy');
  if (inCzechia) regions.push('czechia');
  if (inSlovakia) regions.push('slovakia');
  if (inGermany) regions.push('germany');
  if (inFrance) regions.push('france');
  if (inSpain) regions.push('spain');
  if (inPoland) regions.push('poland');

  // Japan
  if (lat > 24 && lat < 46 && lng > 122 && lng < 154) regions.push('japan');

  // Asia (includes Middle East, SE Asia, overriding parts of china but that's ok they can both load)
  if ((lat > -10 && lat < 60 && lng > 60 && lng < 150)) regions.push('asia');
  // Australia explicitly
  if (lat > -45 && lat < -10 && lng > 110 && lng < 155) regions.push('asia');

  return regions.length > 0 ? regions : ['uk', 'us-east']; // Default fallback
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const region = searchParams.get('region');
    const lat = parseFloat(searchParams.get('lat') || '0');
    const lng = parseFloat(searchParams.get('lng') || '0');

    let regionsToFetch: string[];

    if (region === 'all') {
      regionsToFetch = Object.keys(REGION_FETCHERS);
    } else if (region) {
      regionsToFetch = region.split(',').filter(r => r in REGION_FETCHERS);
    } else if (lat !== 0 || lng !== 0) {
      regionsToFetch = getRegionsForBounds(lat, lng);
    } else {
      // Default: load all regions for global coverage
      regionsToFetch = Object.keys(REGION_FETCHERS);
    }

    // Per-region hard cap. A single dead upstream (e.g. WSDOT) must never stall
    // the whole `region=all` batch — Promise.allSettled waits for the slowest
    // region, so without this one stuck region times out the client and blanks
    // every healthy region with it. Each region races a timeout that resolves to
    // [] so healthy regions (most respond in <300ms) always return promptly.
    const REGION_TIMEOUT_MS = 12000;
    const withTimeout = (p: Promise<Camera[]>): Promise<Camera[]> => {
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<Camera[]>(resolve => {
        timer = setTimeout(() => resolve([]), REGION_TIMEOUT_MS);
      });
      return Promise.race([
        Promise.resolve(p).catch(() => [] as Camera[]),
        timeout,
      ]).finally(() => clearTimeout(timer));
    };

    const results = await Promise.allSettled(
      regionsToFetch.map(r => withTimeout(REGION_FETCHERS[r]()))
    );

    const allCameras: Camera[] = [];
    const sources: Record<string, number> = {};

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const cam of result.value) {
          allCameras.push(cam);
          sources[cam.source] = (sources[cam.source] || 0) + 1;
        }
      }
    }

    // Don't cache near-empty responses (transient upstream failures) so the
    // next request retries instead of serving an empty camera set for 5 min.
    const cacheControl = allCameras.length < 50
      ? 'no-store, max-age=0'
      : 'public, s-maxage=300, stale-while-revalidate=600';

    return NextResponse.json({
      cameras: allCameras,
      total: allCameras.length,
      sources,
      regions: regionsToFetch,
      timestamp: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': cacheControl },
    });
  } catch (error) {
    console.error('CCTV fetch error:', error);
    return NextResponse.json({ cameras: [], error: 'Failed' }, { status: 500 });
  }
}
