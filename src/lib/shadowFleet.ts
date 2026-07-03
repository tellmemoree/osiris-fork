import { stealthFetch } from '@/lib/stealthFetch';

/**
 * OSIRIS — Shadow Fleet Watchlist (dynamic)
 *
 * Maintains live sets of sanctioned / dark-fleet vessel identifiers — both IMO
 * numbers and MMSIs — refreshed from public sanctions sources on a TTL and
 * cached in-memory. Designed to fail safe: if the network source is unreachable
 * or returns nothing parseable, the curated SEED list is kept so the maritime
 * layer never goes blind.
 *
 * Why both IMO and MMSI: AIS broadcasts the IMO only in the infrequent
 * ShipStaticData (type-5) message, but the MMSI rides on every position report
 * (type 1/2/3). Matching on MMSI therefore flags a sanctioned vessel immediately
 * from its position stream, instead of waiting for (and depending on) a static
 * message that many dark-fleet tankers never send. IMO matching is kept as the
 * complementary path for vessels whose MMSI is absent from the source.
 *
 * Sources (in priority order):
 *  1. SHADOW_FLEET_SOURCE_URL env override — any endpoint returning JSON or free-text IMOs
 *  2. GUR War & Sanctions (war-sanctions.gur.gov.ua) — 1400+ vessels curated by Ukraine's
 *     Main Intelligence Directorate; scraped from the HTML vessel-name select dropdown
 *  3. OFAC SDN CSV — broad US sanctions list with IMO/MMSI in remarks column
 *  4. SEED_IMOS — hard-coded fallback, always merged so hand-vetted vessels survive outages
 */

// 847 IMOs from Ukraine GUR War & Sanctions shadow fleet database, snapshot 2026-06.
// Source: https://war-sanctions.gur.gov.ua/en/transport/shadow-fleet
const SEED_IMOS: number[] = [
  8230663, 8231057, 8700096, 8724779, 8727915, 8727941, 8808525, 8821761,
  8867129, 8881369, 8892007, 8894536, 8925414, 8925426, 9005338, 9012886,
  9035541, 9037123, 9041655, 9056571, 9070072, 9087714, 9102277, 9105114,
  9105140, 9113094, 9113276, 9127667, 9131357, 9137648, 9142916, 9144782,
  9151890, 9153525, 9154000, 9161871, 9163269, 9163764, 9164512, 9164718,
  9166314, 9166675, 9168946, 9169421, 9171175, 9171345, 9171357, 9171448,
  9171498, 9174220, 9174397, 9175078, 9178068, 9181194, 9182291, 9183271,
  9183295, 9183843, 9185528, 9185530, 9186625, 9187227, 9189146, 9190078,
  9191553, 9194983, 9194995, 9196644, 9197844, 9198082, 9198094, 9198290,
  9198317, 9198783, 9199127, 9200861, 9203265, 9203277, 9204764, 9205067,
  9206671, 9207027, 9208069, 9208124, 9208215, 9209972, 9211896, 9211999,
  9212008, 9212400, 9213296, 9213313, 9218181, 9220914, 9220926, 9220938,
  9221267, 9221671, 9222443, 9222560, 9223540, 9224271, 9224283, 9224295,
  9224439, 9224441, 9224453, 9224465, 9224805, 9227443, 9227479, 9228784,
  9229374, 9229439, 9230880, 9230971, 9231212, 9231509, 9231767, 9231901,
  9232876, 9232888, 9232929, 9232931, 9233349, 9233741, 9233765, 9233777,
  9234501, 9234642, 9234666, 9234680, 9235000, 9235244, 9235713, 9235725,
  9235737, 9236004, 9236016, 9236248, 9236353, 9236640, 9236743, 9236755,
  9237008, 9237228, 9237412, 9237632, 9237797, 9238052, 9238868, 9240512,
  9240885, 9242118, 9242120, 9242223, 9244635, 9247376, 9247390, 9247429,
  9247431, 9247443, 9247778, 9247780, 9247792, 9247883, 9247986, 9248447,
  9248461, 9248485, 9248796, 9248801, 9248813, 9248849, 9249087, 9249128,
  9249130, 9249178, 9249312, 9249324, 9250531, 9250543, 9250737, 9250892,
  9250907, 9251274, 9251456, 9251640, 9251676, 9251810, 9251822, 9252333,
  9252371, 9252400, 9252955, 9252967, 9253076, 9253234, 9253246, 9253313,
  9253325, 9253894, 9253909, 9254850, 9254862, 9255244, 9255282, 9255488,
  9255660, 9255672, 9255684, 9255830, 9255842, 9256028, 9256054, 9256066,
  9256078, 9256248, 9256858, 9256860, 9256913, 9256975, 9256987, 9257022,
  9257137, 9257149, 9257802, 9257814, 9257993, 9258002, 9258026, 9258167,
  9258478, 9258521, 9258868, 9258870, 9258882, 9259185, 9259197, 9259367,
  9259599, 9259733, 9259745, 9259927, 9259991, 9260055, 9260067, 9260275,
  9260483, 9260823, 9261401, 9261619, 9261657, 9262168, 9262766, 9262924,
  9263186, 9263198, 9263203, 9263215, 9263643, 9263693, 9264271, 9264283,
  9264570, 9264881, 9265744, 9265756, 9265873, 9265885, 9266475, 9266750,
  9266762, 9266853, 9266865, 9266877, 9268112, 9268186, 9269403, 9270517,
  9270529, 9270555, 9270749, 9271327, 9271406, 9271585, 9271951, 9272694,
  9272931, 9273052, 9273246, 9273260, 9273337, 9273351, 9273387, 9273442,
  9274082, 9274434, 9274446, 9274525, 9274616, 9274800, 9275660, 9275763,
  9275995, 9276028, 9276030, 9276561, 9276573, 9276585, 9277735, 9277747,
  9277759, 9278064, 9278698, 9279719, 9280366, 9280873, 9280885, 9281009,
  9281011, 9281152, 9281683, 9281891, 9282041, 9282106, 9282479, 9282481,
  9282493, 9282508, 9282522, 9282558, 9282792, 9282986, 9283241, 9283289,
  9283291, 9283306, 9283801, 9284582, 9284594, 9284726, 9285744, 9285756,
  9285823, 9285835, 9285847, 9285859, 9286023, 9286073, 9286229, 9286281,
  9286657, 9288019, 9288095, 9288265, 9288356, 9288368, 9288693, 9288708,
  9288710, 9288722, 9288734, 9288746, 9288851, 9288863, 9288875, 9288899,
  9288930, 9288954, 9288992, 9289477, 9289491, 9289518, 9289520, 9289532,
  9289738, 9289752, 9289776, 9290309, 9290323, 9290335, 9290361, 9290373,
  9290385, 9290397, 9290517, 9290828, 9290919, 9290921, 9291250, 9291262,
  9292034, 9292046, 9292058, 9292060, 9292163, 9292187, 9292199, 9292204,
  9292228, 9292503, 9292515, 9292577, 9292589, 9292838, 9292979, 9292981,
  9293002, 9293117, 9293155, 9293337, 9293959, 9293997, 9294123, 9294240,
  9294331, 9295048, 9296195, 9296377, 9296391, 9296406, 9296418, 9296585,
  9296597, 9296810, 9296822, 9297199, 9297319, 9297345, 9297357, 9297369,
  9297371, 9297541, 9297553, 9297888, 9297905, 9298272, 9298492, 9298595,
  9299123, 9299135, 9299161, 9299173, 9299446, 9299458, 9299496, 9299666,
  9299678, 9299680, 9299692, 9299707, 9299719, 9299721, 9299733, 9299745,
  9299769, 9299771, 9299862, 9299874, 9299886, 9299898, 9299903, 9301380,
  9301392, 9301407, 9301419, 9301421, 9301524, 9301615, 9302970, 9304356,
  9304590, 9304629, 9304655, 9304667, 9304825, 9305556, 9305568, 9305609,
  9306562, 9306627, 9306639, 9306782, 9306794, 9306809, 9307152, 9307815,
  9307932, 9308065, 9308077, 9308132, 9308170, 9308443, 9308778, 9308821,
  9308833, 9308857, 9308950, 9309227, 9309576, 9309588, 9309980, 9310525,
  9310707, 9311309, 9311531, 9311610, 9311622, 9312872, 9312884, 9312896,
  9313149, 9313498, 9314088, 9314105, 9314167, 9314179, 9314818, 9314820,
  9314882, 9314894, 9315446, 9315642, 9315654, 9315745, 9315769, 9316127,
  9317949, 9318022, 9318034, 9318096, 9318539, 9318541, 9318553, 9319674,
  9319686, 9319703, 9319870, 9319882, 9320843, 9321172, 9321421, 9321562,
  9321677, 9321689, 9321691, 9321706, 9321718, 9321847, 9321976, 9322267,
  9322827, 9322839, 9322956, 9322968, 9323314, 9323326, 9323338, 9323340,
  9323364, 9323376, 9323429, 9323596, 9323974, 9323986, 9326055, 9326718,
  9326720, 9326861, 9326885, 9327360, 9327372, 9327396, 9327413, 9327425,
  9328170, 9328716, 9329655, 9329667, 9329758, 9329760, 9330472, 9330599,
  9330604, 9331141, 9331153, 9332028, 9332171, 9332315, 9332614, 9332781,
  9332810, 9332822, 9332834, 9333400, 9333412, 9333424, 9333436, 9333785,
  9334296, 9334557, 9334569, 9334789, 9335094, 9336414, 9336426, 9336490,
  9336517, 9337133, 9337195, 9337327, 9337341, 9337389, 9337418, 9337901,
  9338905, 9339301, 9339313, 9339325, 9339337, 9340116, 9341067, 9341079,
  9341081, 9341093, 9341512, 9343986, 9344033, 9345623, 9346720, 9346732,
  9346744, 9346859, 9346873, 9347308, 9348479, 9350654, 9352195, 9353096,
  9353113, 9353125, 9354301, 9354313, 9354521, 9354636, 9358412, 9360128,
  9360130, 9360415, 9365752, 9365764, 9365776, 9368223, 9368235, 9369617,
  9371608, 9374416, 9374868, 9377042, 9377779, 9378618, 9378620, 9378632,
  9379052, 9379301, 9379698, 9379703, 9380051, 9380570, 9380673, 9381732,
  9381744, 9382073, 9382712, 9382798, 9383869, 9383950, 9384069, 9384095,
  9384306, 9384435, 9384447, 9384459, 9384564, 9384992, 9385142, 9385831,
  9386536, 9387255, 9387279, 9388027, 9388730, 9388742, 9388754, 9388766,
  9388780, 9388792, 9389071, 9389083, 9389095, 9389100, 9389679, 9390587,
  9391402, 9392822, 9393668, 9394935, 9395379, 9397456, 9397535, 9397547,
  9397559, 9397676, 9399480, 9400980, 9402328, 9402469, 9402471, 9402732,
  9404948, 9405057, 9408190, 9408205, 9408530, 9408542, 9408554, 9408683,
  9408695, 9409247, 9409259, 9409467, 9410387, 9410870, 9410894, 9411020,
  9411331, 9412000, 9412335, 9412347, 9412359, 9412452, 9412995, 9413004,
  9413547, 9413559, 9413561, 9413573, 9416422, 9417464, 9418482, 9418494,
  9419137, 9419151, 9419448, 9419450, 9421960, 9421972, 9422445, 9422457,
  9422988, 9424651, 9428358, 9430210, 9430272, 9433016, 9434890, 9435337,
  9435363, 9435375, 9436006, 9436018, 9436020, 9436941, 9437983, 9439383,
  9439400, 9439539, 9439541, 9441958, 9448968, 9459242, 9460564, 9472634,
  9486805, 9495832, 9503304, 9511387, 9511521, 9511533, 9513139, 9522324,
  9524451, 9524463, 9530917, 9531375, 9531387, 9544281, 9550682, 9553957,
  9554822, 9554834, 9571052, 9577082, 9577094, 9585912, 9585924, 9589750,
  9599341, 9599353, 9610781, 9610793, 9610808, 9610810, 9612923, 9621558,
  9621560, 9624316, 9637961, 9640516, 9640528, 9640530, 9645011, 9645982,
  9655468, 9655470, 9667928, 9676230, 9683726, 9735141, 9749130, 9749154,
  9766073, 9766085, 9820776, 9826720, 9826902, 9832547, 9832559, 9842176,
  9842188, 9842190, 9843560, 9866380, 9866392, 9901025, 9901037,
];

// GUR War & Sanctions live scrape URL — same source as the seed, checked every 24h
// for additions. Cloudflare-protected but accessible with browser headers.
const GUR_URL = 'https://war-sanctions.gur.gov.ua/en/transport/shadow-fleet';
const SOURCE_URL =
  process.env.SHADOW_FLEET_SOURCE_URL ?? 'https://www.treasury.gov/ofac/downloads/sdn.csv';

const TTL_MS = 12 * 60 * 60 * 1000;  // refresh OFAC at most every 12h
const GUR_TTL_MS = 24 * 60 * 60 * 1000; // refresh GUR at most every 24h
const ERROR_BACKOFF_MS = 5 * 60 * 1000; // after a failure, retry in 5 min

// Module-level vars attached to globalThis so they survive Next.js module
// re-evaluation (e.g. under memory pressure) without resetting the watchlist
// or triggering an unnecessary re-fetch on the next request.
const globalForFleet = globalThis as unknown as {
  sfImos: Set<number>;
  sfMmsis: Set<number>;
  sfLastRefresh: number;
  sfLastGurRefresh: number;
  sfRefreshing: Promise<void> | null;
};

if (!globalForFleet.sfImos) {
  globalForFleet.sfImos = new Set<number>(SEED_IMOS);
  globalForFleet.sfMmsis = new Set<number>();
  globalForFleet.sfLastRefresh = 0;
  globalForFleet.sfLastGurRefresh = 0;
  globalForFleet.sfRefreshing = null;
}


// IMO numbers are exactly 7 digits.
function isValidImo(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1_000_000 && n <= 9_999_999;
}

// MMSI is exactly 9 digits; real ship station IDs use MID prefixes 2–7.
function isValidMmsi(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 200_000_000 && n <= 799_999_999;
}

/** Parse IMO numbers out of a source payload (JSON in several shapes, or CSV/text). */
export function parseImos(body: string): number[] {
  const trimmed = body.trimStart();

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const json: unknown = JSON.parse(body);
      const arr: unknown[] = Array.isArray(json)
        ? json
        : Array.isArray((json as { imos?: unknown[] })?.imos)
          ? (json as { imos: unknown[] }).imos
          : [];
      const out = arr
        .map((item) => {
          if (typeof item === 'number') return item;
          if (typeof item === 'string') return Number(item);
          const obj = item as { imo?: unknown; imoNumber?: unknown };
          return Number(obj?.imo ?? obj?.imoNumber);
        })
        .filter(isValidImo);
      if (out.length > 0) return out;
      // Fall through to regex if JSON had no usable IMOs.
    } catch {
      // Not JSON after all — fall through to the text scanner.
    }
  }

  // Free-text / CSV: match "IMO 1234567" (optional colon/whitespace).
  const out: number[] = [];
  const re = /IMO[:\s]*?(\d{7})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const n = Number(m[1]);
    if (isValidImo(n)) out.push(n);
  }
  return out;
}

/**
 * Parse IMOs from the GUR War & Sanctions HTML vessel-name select dropdown.
 * The page embeds all vessel IMOs in <option>VESSEL NAME (IMO)</option> elements
 * inside the id="f-n" select. We extract 7-digit numbers that appear in parens
 * inside option tags — only valid IMO range (1M–9.9M) are kept.
 */
export function parseGurHtml(html: string): number[] {
  const out: number[] = [];
  // Match option contents: VESSEL NAME (1234567)
  const re = /<option[^>]*>[^<(]+\((\d{7})\)<\/option>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const n = Number(m[1]);
    if (isValidImo(n)) out.push(n);
  }
  return [...new Set(out)];
}

/** Parse MMSIs out of a free-text / CSV source payload ("MMSI 123456789"). */
export function parseMmsis(body: string): number[] {
  const out: number[] = [];
  const re = /MMSI[:\s]*?(\d{9})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const n = Number(m[1]);
    if (isValidMmsi(n)) out.push(n);
  }
  return out;
}

async function refreshGur(): Promise<void> {
  try {
    const res = await stealthFetch(GUR_URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`GUR returned ${res.status}`);
    const html = await res.text();
    const gurImos = parseGurHtml(html);
    if (gurImos.length < 100) {
      // Too few to be a real parse — Cloudflare challenge page or layout change
      console.warn(`[OSIRIS] shadow-fleet GUR parse yielded only ${gurImos.length} IMOs — skipping`);
      globalForFleet.sfLastGurRefresh = Date.now() - GUR_TTL_MS + ERROR_BACKOFF_MS;
      return;
    }
    globalForFleet.sfImos = new Set<number>([...SEED_IMOS, ...globalForFleet.sfImos, ...gurImos]);
    globalForFleet.sfLastGurRefresh = Date.now();
    console.log(`[OSIRIS] shadow-fleet GUR refreshed: ${gurImos.length} vessels, total IMO set: ${globalForFleet.sfImos.size}`);
  } catch (err) {
    console.warn('[OSIRIS] shadow-fleet GUR refresh failed:', err instanceof Error ? err.message : err);
    globalForFleet.sfLastGurRefresh = Date.now() - GUR_TTL_MS + ERROR_BACKOFF_MS;
  }
}

async function refresh(): Promise<void> {
  try {
    // Run GUR refresh concurrently if stale
    const gurPromise = Date.now() - globalForFleet.sfLastGurRefresh > GUR_TTL_MS ? refreshGur() : Promise.resolve();

    const res = await stealthFetch(SOURCE_URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`watchlist source returned ${res.status}`);

    const body = await res.text();
    const parsedImos = parseImos(body);
    const parsedMmsis = parseMmsis(body);

    await gurPromise;

    if (parsedImos.length === 0 && parsedMmsis.length === 0) {
      console.warn('[OSIRIS] shadow-fleet source yielded 0 identifiers; keeping current set');
      globalForFleet.sfLastRefresh = Date.now() - TTL_MS + ERROR_BACKOFF_MS;
      return;
    }

    // Merge: seed + GUR (already in sfImos) + OFAC. Never shrink the set.
    globalForFleet.sfImos = new Set<number>([...globalForFleet.sfImos, ...parsedImos]);
    if (parsedMmsis.length > 0) {
      globalForFleet.sfMmsis = new Set<number>(parsedMmsis);
    }
    globalForFleet.sfLastRefresh = Date.now();
    console.log(
      `[OSIRIS] shadow-fleet watchlist refreshed: ${globalForFleet.sfImos.size} IMOs, ${globalForFleet.sfMmsis.size} MMSIs (OFAC: ${parsedImos.length}/${parsedMmsis.length})`
    );
  } catch (err) {
    console.warn(
      '[OSIRIS] shadow-fleet refresh failed; using cached/seed set:',
      err instanceof Error ? err.message : err
    );
    globalForFleet.sfLastRefresh = Date.now() - TTL_MS + ERROR_BACKOFF_MS;
  } finally {
    globalForFleet.sfRefreshing = null;
  }
}

// Kicks off a background refresh when the set is stale, so callers (including the
// hot AIS message handler) never block. The first call returns the SEED set
// immediately while the first fetch runs.
function maybeRefresh(): void {
  if (!globalForFleet.sfRefreshing && Date.now() - globalForFleet.sfLastRefresh > TTL_MS) {
    globalForFleet.sfRefreshing = refresh();
  }
}

/** Current sanctioned-IMO watchlist (synchronous; refreshes in the background). */
export function getShadowFleetImos(): Set<number> {
  maybeRefresh();
  return globalForFleet.sfImos;
}

/** Current sanctioned-MMSI watchlist (synchronous; refreshes in the background). */
export function getShadowFleetMmsis(): Set<number> {
  maybeRefresh();
  return globalForFleet.sfMmsis;
}
