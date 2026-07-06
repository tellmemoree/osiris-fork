/**
 * OSIRIS — Conflict Geo Shared Library
 *
 * Shared constants and utilities used by /api/conflict-events and
 * /api/gdelt (deprecation alias). Extracted so both routes share a single
 * source of truth for GEO_DICT, RSS_FEEDS, CONFLICT_KEYWORDS, and the
 * deduplication / confidence-tiering algorithm.
 *
 * Also the single source of truth for oblast/raion attribution — OBLAST_REFS,
 * RAION_CENTERS, and matchOblasts() (consolidated here from telegram-threats.ts
 * and kab-threats/route.ts, which previously each kept an independent copy).
 * telegram-threats.ts re-exports matchOblasts/OblastRef/OBLAST_REFS/
 * OBLAST_MATCHERS so existing call sites (drone-threats, weapon-threats,
 * mig31k, strategic-thermal, railway-incidents) are unaffected.
 *
 * NOTE: GEO_DICT tuples are [lng, lat] (GeoJSON order). OBLAST_REFS.coords is
 * also [lng, lat]. PLACE_COORDS/RAION_CENTERS are [lat, lng] — do not mix.
 */

// ── oblast refs (moved verbatim from telegram-threats.ts — see matchOblasts()) ─
//
// Also re-exported from telegram-threats.ts so every existing call site
// (drone-threats, weapon-threats, mig31k, strategic-thermal, railway-incidents)
// keeps working unchanged.

export interface OblastRef {
  oblast: string;
  coords: [number, number]; // [lng, lat] GeoJSON order
  tokens: string[];
}

export const OBLAST_REFS: OblastRef[] = [
  { oblast: 'Kharkiv oblast',        coords: [36.230, 49.990], tokens: ['харків', 'харківщ', 'kharkiv', 'чугуїв', "куп'янськ", 'kupiansk', 'вовчанськ', 'vovchansk', 'ізюм', 'izium'] },
  { oblast: 'Sumy oblast',           coords: [34.800, 50.910], tokens: ['сумщ', 'сумськ', 'сумської', 'м. суми', 'sumy', 'шостк', 'конотоп'] },
  { oblast: 'Zaporizhzhia oblast',   coords: [35.139, 47.838], tokens: ['запоріж', 'запорізьк', 'zaporizh', 'оріхів', 'оріхов', 'гуляйполе', 'huliaipole', 'токмак', 'tokmak'] },
  { oblast: 'Kherson oblast',        coords: [32.601, 46.635], tokens: ['херсон', 'херсонщ', 'kherson', 'берислав'] },
  { oblast: 'Donetsk oblast',        coords: [37.800, 48.000], tokens: ['донеччин', 'донецьк', 'donetsk', 'краматорськ', 'kramatorsk', "слов'янськ", 'покровськ', 'pokrovsk', 'костянтинівк', 'часів яр', 'торецьк', 'toretsk', 'авдіїв'] },
  { oblast: 'Dnipropetrovsk oblast', coords: [35.046, 48.465], tokens: ['дніпропетровщ', 'дніпро', 'нікополь', 'nikopol', 'кривий ріг', 'kryvyi rih', 'павлоград', 'марганець'] },
  { oblast: 'Chernihiv oblast',      coords: [31.285, 51.498], tokens: ['чернігівщ', 'чернігів', 'chernihiv', 'новгород-сіверськ', 'семенівк'] },
  { oblast: 'Mykolaiv oblast',       coords: [31.994, 46.975], tokens: ['миколаївщ', 'миколаїв', 'mykolaiv', 'очаків', 'снігурівк'] },
  { oblast: 'Poltava oblast',        coords: [34.551, 49.588], tokens: ['полтавщ', 'полтав', 'poltava', 'кременчук', 'kremenchuk', 'лубни'] },
  { oblast: 'Luhansk oblast',        coords: [39.300, 48.566], tokens: ['луганщ', 'луганськ', 'luhansk', 'luhans', 'рубіжн', 'сєвєродонецьк', 'лисичанськ'] },
  { oblast: 'Odesa oblast',          coords: [30.723, 46.482], tokens: ['одещ', 'одеськ', 'odesa', 'odessa', 'ізмаїл', 'чорноморськ', 'южне'] },
  { oblast: 'Kyiv oblast',           coords: [30.523, 50.450], tokens: ['київщ', 'київськ', 'kyivsk', 'бровар', 'бориспіл', 'vasylkiv', 'васильків'] },
  { oblast: 'Kyiv City',             coords: [30.523, 50.450], tokens: ['kyiv', 'київ'] },
  { oblast: 'Zhytomyr oblast',       coords: [28.658, 50.255], tokens: ['житомирщ', 'житомир', 'zhytomyr', 'бердичів', 'коростень'] },
  // Bare 'рівн' dropped — collides with 'рівня'/'рівний' (level/equal); the
  // remaining tokens are long enough to stay specific to the place name.
  { oblast: 'Rivne oblast',          coords: [26.251, 50.620], tokens: ['рівненщ', 'рівненськ', 'rivne', 'рівного', 'рівному', 'м. рівне'] },
  { oblast: 'Vinnytsia oblast',      coords: [28.468, 49.233], tokens: ['вінниц', 'вінниці', 'vinnytsia', 'вінниця', 'жмеринк'] },
  { oblast: 'Khmelnytskyi oblast',   coords: [26.987, 49.423], tokens: ['хмельниц', 'khmelnytsk', 'хмельницьк', "кам'янець"] },
  { oblast: 'Kirovohrad oblast',     coords: [32.262, 48.508], tokens: ['кіровоград', 'kirovohrad', 'кропивниц', 'kropyvnytsk'] },
  // ── Western oblasts (previously missing — strikes/drones reach these) ─────
  { oblast: 'Lviv oblast',           coords: [24.030, 49.840], tokens: ['львів', 'львівщ', 'львівськ', 'lviv', 'дрогобич', 'drohobych', 'стрий', 'stryi'] },
  { oblast: 'Ternopil oblast',       coords: [25.595, 49.554], tokens: ['тернопіл', 'тернопільщ', 'тернопільськ', 'ternopil', 'кременець'] },
  { oblast: 'Volyn oblast',          coords: [25.325, 50.747], tokens: ['волин', 'волинськ', 'волинщ', 'volyn', 'луцьк', 'lutsk', 'ковель'] },
  { oblast: 'Ivano-Frankivsk oblast',coords: [24.711, 48.923], tokens: ['івано-франківськ', 'івано-франківщ', 'прикарпатт', 'ivano-frankivsk', 'коломия', 'калуш'] },
  { oblast: 'Zakarpattia oblast',    coords: [22.288, 48.621], tokens: ['закарпат', 'zakarpat', 'ужгород', 'uzhhorod', 'мукачев', 'mukachevo'] },
  { oblast: 'Chernivtsi oblast',     coords: [25.935, 48.292], tokens: ['чернівц', 'чернівецьк', 'буковин', 'chernivtsi', 'буковина'] },
  { oblast: 'Cherkasy oblast',       coords: [32.060, 49.445], tokens: ['черкащ', 'черкаськ', 'cherkasy', 'умань', 'uman', 'черкаси'] },
];

// ── raion-center gazetteer (post-2020 reform, ~136 raions + 4 hromada exceptions) ──
//
// Each entry is a raion's administrative-center town, with real coordinates
// sourced from Wikidata (P36 admin-center-of-raion property, cross-checked
// against Wikipedia/decentralization.gov.ua for the handful the SPARQL query
// resolved incorrectly — see inline overrides during generation). Tokens are
// lowercase declension stems following the exact convention already used in
// OBLAST_REFS.tokens (leading-boundary-only regex match, e.g. 'запоріж'
// matches 'запоріжжя') — stems avoid trailing letters so genitive/dative/
// instrumental forms still match, EXCEPT where the naive stem would collide
// with a common Ukrainian word (see 'рівне'/'сумськ' below, matching the
// existing 'рівн' exclusion already documented on Rivne oblast above).
//
// Scope note / deviation from the strict "136 raion capitals" spec: four
// entries below (Baturyn, Korop, Sosnytsia, Kulykivka) are NOT raion capitals
// — they are hromada centers one level below the raion (Nizhyn, Novhorod-
// Siverskyi, Koriukivka, and Chernihiv raions respectively). They are the
// four concrete failing examples from live investigation (real Telegram text:
// "1 північніше Батурина", "1 східніше Коропа", "1 південніше Сосниці",
// "1 північніше Куликівки" — all silently dropped before this fix) and are a
// hard requirement from the spec, so they're included as named exceptions
// rather than expanding scope to full hromada-level (~1,470 hromadas, out of
// bounds for this change).
export interface RaionCenter {
  town: string;
  oblast: string;
  lat: number;
  lng: number;
  tokens: string[];
}

export const RAION_CENTERS: RaionCenter[] = [
  { town: 'Вінниця', oblast: 'Vinnytsia oblast', lat: 49.2372, lng: 28.4672, tokens: ['вінни', 'vinnytsia'] },
  { town: 'Гайсин', oblast: 'Vinnytsia oblast', lat: 48.8094, lng: 29.3906, tokens: ['гайси', 'haisyn'] },
  { town: 'Жмеринка', oblast: 'Vinnytsia oblast', lat: 49.0425, lng: 28.0992, tokens: ['жмерин', 'zhmerynka'] },
  { town: 'Могилів-Подільський', oblast: 'Vinnytsia oblast', lat: 48.45, lng: 27.7833, tokens: ['могилів-подільський', 'mohyliv-podilskyi'] },
  { town: 'Тульчин', oblast: 'Vinnytsia oblast', lat: 48.6744, lng: 28.8497, tokens: ['тульч', 'tulchyn'] },
  { town: 'Хмільник', oblast: 'Vinnytsia oblast', lat: 49.55, lng: 27.9667, tokens: ['хмільн', 'khmilnyk'] },
  { town: 'Володимир', oblast: 'Volyn oblast', lat: 50.8481, lng: 24.3222, tokens: ['володим', 'volodymyr'] },
  { town: 'Камінь-Каширський', oblast: 'Volyn oblast', lat: 51.6242, lng: 24.9606, tokens: ['камінь-каширський', 'kamin-kashyrskyi'] },
  { town: 'Ковель', oblast: 'Volyn oblast', lat: 51.2167, lng: 24.7167, tokens: ['ковел', 'kovel'] },
  { town: 'Луцьк', oblast: 'Volyn oblast', lat: 50.7478, lng: 25.3244, tokens: ['луць', 'lutsk'] },
  { town: 'Дніпро', oblast: 'Dnipropetrovsk oblast', lat: 48.4675, lng: 35.04, tokens: ['дніпр', 'dnipro'] },
  { town: 'Кам\'янське', oblast: 'Dnipropetrovsk oblast', lat: 48.5167, lng: 34.6133, tokens: ['кам\'янсь', 'kamianske'] },
  { town: 'Кривий Ріг', oblast: 'Dnipropetrovsk oblast', lat: 47.91, lng: 33.39, tokens: ['кривий ріг', 'kryvyi rih'] },
  { town: 'Нікополь', oblast: 'Dnipropetrovsk oblast', lat: 47.5667, lng: 34.4, tokens: ['нікопо', 'nikopol'] },
  { town: 'Павлоград', oblast: 'Dnipropetrovsk oblast', lat: 48.52, lng: 35.87, tokens: ['павлогр', 'pavlohrad'] },
  // Cyrillic token intentionally omitted: 'сама' collides with the common
  // pronoun ("she/herself"), and the disambiguated form 'самар' collides with
  // the pre-existing PLACE_COORDS entry for Samara, Russia (a strike-target
  // city — see the Russian-cities section below). Coordinates kept for
  // documentation; this raion center won't auto-match until a safe,
  // non-colliding token is found.
  { town: 'Самар', oblast: 'Dnipropetrovsk oblast', lat: 48.6316, lng: 35.2245, tokens: [] },
  { town: 'Синельникове', oblast: 'Dnipropetrovsk oblast', lat: 48.3178, lng: 35.5119, tokens: ['синельнико', 'synelnykove'] },
  { town: 'Бахмут', oblast: 'Donetsk oblast', lat: 48.5947, lng: 38.0008, tokens: ['бахму', 'bakhmut'] },
  { town: 'Волноваха', oblast: 'Donetsk oblast', lat: 47.5994, lng: 37.4999, tokens: ['волнова', 'volnovakha'] },
  { town: 'Горлівка', oblast: 'Donetsk oblast', lat: 48.3336, lng: 38.0925, tokens: ['горлів', 'horlivka'] },
  { town: 'Донецьк', oblast: 'Donetsk oblast', lat: 48.0158, lng: 37.8028, tokens: ['донец', 'donetsk'] },
  { town: 'Кальміуське', oblast: 'Donetsk oblast', lat: 47.6667, lng: 38.0667, tokens: ['кальміусь', 'kalmiuske'] },
  { town: 'Краматорськ', oblast: 'Donetsk oblast', lat: 48.7392, lng: 37.5839, tokens: ['краматорс', 'kramatorsk'] },
  { town: 'Маріуполь', oblast: 'Donetsk oblast', lat: 47.1306, lng: 37.5639, tokens: ['маріупо', 'mariupol'] },
  { town: 'Покровськ', oblast: 'Donetsk oblast', lat: 48.2833, lng: 37.1833, tokens: ['покровс', 'pokrovsk'] },
  { town: 'Бердичів', oblast: 'Zhytomyr oblast', lat: 49.8919, lng: 28.6, tokens: ['бердич', 'berdychiv'] },
  { town: 'Житомир', oblast: 'Zhytomyr oblast', lat: 50.2544, lng: 28.6578, tokens: ['житом', 'zhytomyr'] },
  { town: 'Звягель', oblast: 'Zhytomyr oblast', lat: 50.5833, lng: 27.6333, tokens: ['звяге', 'zviahel'] },
  { town: 'Коростень', oblast: 'Zhytomyr oblast', lat: 50.95, lng: 28.65, tokens: ['коросте', 'korosten'] },
  { town: 'Берегове', oblast: 'Zakarpattia oblast', lat: 48.2025, lng: 22.6375, tokens: ['берего', 'berehove'] },
  { town: 'Мукачево', oblast: 'Zakarpattia oblast', lat: 48.4414, lng: 22.7136, tokens: ['мукаче', 'mukachevo'] },
  // 'рахі'/'рахів' dropped as bare stems — both are leading substrings of
  // 'рахівниця' (abacus); 'рахова' (genitive) doesn't collide.
  { town: 'Рахів', oblast: 'Zakarpattia oblast', lat: 48.05, lng: 24.2167, tokens: ['рахова', 'rakhiv'] },
  { town: 'Тячів', oblast: 'Zakarpattia oblast', lat: 48.0114, lng: 23.5722, tokens: ['тячі', 'tiachiv'] },
  { town: 'Ужгород', oblast: 'Zakarpattia oblast', lat: 48.6239, lng: 22.295, tokens: ['ужгор', 'uzhhorod'] },
  // Bare 'хуст' dropped — collides with 'хустка'/'хустині' (headscarf); the
  // declined forms below are long enough to stay specific to the place name.
  { town: 'Хуст', oblast: 'Zakarpattia oblast', lat: 48.1814, lng: 23.2978, tokens: ['хуста', 'хусті', 'khust'] },
  { town: 'Бердянськ', oblast: 'Zaporizhzhia oblast', lat: 46.7556, lng: 36.7889, tokens: ['бердянс', 'berdiansk'] },
  { town: 'Василівка', oblast: 'Zaporizhzhia oblast', lat: 47.4435, lng: 35.2802, tokens: ['василів', 'vasylivka'] },
  { town: 'Запоріжжя', oblast: 'Zaporizhzhia oblast', lat: 47.85, lng: 35.1175, tokens: ['запоріж', 'zaporizhzhia'] },
  { town: 'Мелітополь', oblast: 'Zaporizhzhia oblast', lat: 46.8489, lng: 35.3675, tokens: ['мелітопо', 'melitopol'] },
  // Bare 'полог' dropped — collides with 'пологовий'/'пологів' (maternity,
  // adj.); the declined forms below diverge from that word at char 6.
  { town: 'Пологи', oblast: 'Zaporizhzhia oblast', lat: 47.4796, lng: 36.2611, tokens: ['пологи', 'пологів', 'пологах', 'pology'] },
  { town: 'Верховина', oblast: 'Ivano-Frankivsk oblast', lat: 48.1517, lng: 24.8136, tokens: ['верхови', 'verkhovyna'] },
  { town: 'Івано-Франківськ', oblast: 'Ivano-Frankivsk oblast', lat: 48.9228, lng: 24.7106, tokens: ['івано-франківськ', 'ivano-frankivsk'] },
  { town: 'Калуш', oblast: 'Ivano-Frankivsk oblast', lat: 49.0442, lng: 24.3597, tokens: ['калу', 'kalush'] },
  { town: 'Коломия', oblast: 'Ivano-Frankivsk oblast', lat: 48.5306, lng: 25.0403, tokens: ['колом', 'kolomyia'] },
  // Bare 'косі' dropped — collides with 'косіння' (mowing); 'косів' (full
  // nominative) diverges from it at char 5.
  { town: 'Косів', oblast: 'Ivano-Frankivsk oblast', lat: 48.315, lng: 25.0953, tokens: ['косів', 'kosiv'] },
  { town: 'Надвірна', oblast: 'Ivano-Frankivsk oblast', lat: 48.6333, lng: 24.5833, tokens: ['надвір', 'nadvirna'] },
  { town: 'Біла Церква', oblast: 'Kyiv oblast', lat: 49.7956, lng: 30.1167, tokens: ['біла церква', 'bila tserkva'] },
  { town: 'Бориспіль', oblast: 'Kyiv oblast', lat: 50.35, lng: 30.95, tokens: ['бориспі', 'boryspil'] },
  { town: 'Бровари', oblast: 'Kyiv oblast', lat: 50.5111, lng: 30.79, tokens: ['брова', 'brovary'] },
  // Bare 'буча' dropped — it's a homograph of the common noun 'буча'
  // (commotion/fuss); 'бучан' (adjectival/resident form) is specific enough.
  { town: 'Буча', oblast: 'Kyiv oblast', lat: 50.5486, lng: 30.2208, tokens: ['бучан', 'bucha'] },
  { town: 'Вишгород', oblast: 'Kyiv oblast', lat: 50.5833, lng: 30.4853, tokens: ['вишгор', 'vyshhorod'] },
  { town: 'Обухів', oblast: 'Kyiv oblast', lat: 50.1109, lng: 30.6269, tokens: ['обухі', 'obukhiv'] },
  { town: 'Фастів', oblast: 'Kyiv oblast', lat: 50.0747, lng: 29.9181, tokens: ['фасті', 'fastiv'] },
  { town: 'Голованівськ', oblast: 'Kirovohrad oblast', lat: 48.38, lng: 30.4472, tokens: ['голованівс', 'holovanivsk'] },
  { town: 'Кропивницький', oblast: 'Kirovohrad oblast', lat: 48.5103, lng: 32.2667, tokens: ['кропивницьк', 'kropyvnytskyi'] },
  { town: 'Новоукраїнка', oblast: 'Kirovohrad oblast', lat: 48.3156, lng: 31.5269, tokens: ['новоукраїн', 'novoukrainka'] },
  { town: 'Олександрія', oblast: 'Kirovohrad oblast', lat: 48.6667, lng: 33.1167, tokens: ['олександр', 'oleksandriia'] },
  { town: 'Алчевськ', oblast: 'Luhansk oblast', lat: 48.4672, lng: 38.7983, tokens: ['алчевс', 'alchevsk'] },
  { town: 'Довжанськ', oblast: 'Luhansk oblast', lat: 48.0846, lng: 39.6516, tokens: ['довжанс', 'dovzhansk'] },
  { town: 'Луганськ', oblast: 'Luhansk oblast', lat: 48.5717, lng: 39.2973, tokens: ['луганс', 'luhansk'] },
  { town: 'Ровеньки', oblast: 'Luhansk oblast', lat: 48.0833, lng: 39.3667, tokens: ['ровень', 'rovenky'] },
  { town: 'Сватове', oblast: 'Luhansk oblast', lat: 49.415, lng: 38.155, tokens: ['свато', 'svatove'] },
  { town: 'Сіверськодонецьк', oblast: 'Luhansk oblast', lat: 48.9481, lng: 38.4933, tokens: ['сіверськодонец', 'sievierodonetsk'] },
  { town: 'Старобільськ', oblast: 'Luhansk oblast', lat: 49.2829, lng: 38.8974, tokens: ['старобільс', 'starobilsk'] },
  // Cyrillic token omitted entirely — 'Щастя' is a full homograph of
  // 'щастя' (happiness), not fixable by lengthening the stem. Latin-only.
  { town: 'Щастя', oblast: 'Luhansk oblast', lat: 48.7372, lng: 39.2312, tokens: ['shchastia'] },
  { town: 'Дрогобич', oblast: 'Lviv oblast', lat: 49.35, lng: 23.5, tokens: ['дрогоб', 'drohobych'] },
  { town: 'Золочів', oblast: 'Lviv oblast', lat: 49.8075, lng: 24.9031, tokens: ['золоч', 'zolochiv'] },
  { town: 'Львів', oblast: 'Lviv oblast', lat: 49.8425, lng: 24.0322, tokens: ['льві', 'lviv'] },
  { town: 'Самбір', oblast: 'Lviv oblast', lat: 49.5167, lng: 23.2, tokens: ['самбі', 'sambir'] },
  // Bare 'стри' dropped — collides with 'стриманий'/'стриж'; full nominative
  // + genitive below are specific enough (matches the oblast-level token
  // convention already used for this same town at the top of this file).
  { town: 'Стрий', oblast: 'Lviv oblast', lat: 49.25, lng: 23.85, tokens: ['стрий', 'стрия', 'stryi'] },
  { town: 'Шептицький', oblast: 'Lviv oblast', lat: 50.3822, lng: 24.2275, tokens: ['шептицьк', 'sheptytskyi'] },
  { town: 'Яворів', oblast: 'Lviv oblast', lat: 49.9469, lng: 23.3931, tokens: ['яворі', 'yavoriv'] },
  { town: 'Баштанка', oblast: 'Mykolaiv oblast', lat: 47.4, lng: 32.45, tokens: ['баштан', 'bashtanka'] },
  { town: 'Вознесенськ', oblast: 'Mykolaiv oblast', lat: 47.5725, lng: 31.3119, tokens: ['вознесенс', 'voznesensk'] },
  { town: 'Миколаїв', oblast: 'Mykolaiv oblast', lat: 46.975, lng: 31.995, tokens: ['микола', 'mykolaiv'] },
  { town: 'Первомайськ', oblast: 'Mykolaiv oblast', lat: 48.0451, lng: 30.8884, tokens: ['первомайс', 'pervomaisk'] },
  { town: 'Березівка', oblast: 'Odesa oblast', lat: 47.2002, lng: 30.9075, tokens: ['березів', 'berezivka'] },
  { town: 'Білгород-Дністровський', oblast: 'Odesa oblast', lat: 46.1939, lng: 30.3411, tokens: ['білгород-дністровський', 'bilhorod-dnistrovskyi'] },
  { town: 'Болград', oblast: 'Odesa oblast', lat: 45.6828, lng: 28.61, tokens: ['болгр', 'bolhrad'] },
  { town: 'Ізмаїл', oblast: 'Odesa oblast', lat: 45.3511, lng: 28.8447, tokens: ['ізмаї', 'izmail'] },
  { town: 'Одеса', oblast: 'Odesa oblast', lat: 46.4775, lng: 30.7326, tokens: ['одес', 'odesa'] },
  { town: 'Подільськ', oblast: 'Odesa oblast', lat: 47.7531, lng: 29.5309, tokens: ['подільс', 'podilsk'] },
  { town: 'Роздільна', oblast: 'Odesa oblast', lat: 46.8542, lng: 30.0717, tokens: ['розділь', 'rozdilna'] },
  { town: 'Кременчук', oblast: 'Poltava oblast', lat: 49.0631, lng: 33.4039, tokens: ['кременч', 'kremenchuk'] },
  { town: 'Лубни', oblast: 'Poltava oblast', lat: 50.0186, lng: 32.9869, tokens: ['лубн', 'lubny'] },
  { town: 'Миргород', oblast: 'Poltava oblast', lat: 49.964, lng: 33.6124, tokens: ['миргор', 'myrhorod'] },
  { town: 'Полтава', oblast: 'Poltava oblast', lat: 49.5894, lng: 34.5514, tokens: ['полта', 'poltava'] },
  { town: 'Вараш', oblast: 'Rivne oblast', lat: 51.34, lng: 25.8508, tokens: ['вараш', 'varash'] },
  { town: 'Дубно', oblast: 'Rivne oblast', lat: 50.3931, lng: 25.735, tokens: ['дубн', 'dubno'] },
  { town: 'Рівне', oblast: 'Rivne oblast', lat: 50.6197, lng: 26.2514, tokens: ['рівне', 'rivne'] },
  // Bare 'сарн' dropped — collides with 'сарна' (roe deer); the full
  // nominative/locative forms below diverge from it at char 5.
  { town: 'Сарни', oblast: 'Rivne oblast', lat: 51.3269, lng: 26.6331, tokens: ['сарни', 'сарнах', 'sarny'] },
  { town: 'Конотоп', oblast: 'Sumy oblast', lat: 51.2375, lng: 33.2083, tokens: ['конот', 'konotop'] },
  { town: 'Охтирка', oblast: 'Sumy oblast', lat: 50.3074, lng: 34.9016, tokens: ['охтир', 'okhtyrka'] },
  { town: 'Ромни', oblast: 'Sumy oblast', lat: 50.7428, lng: 33.4879, tokens: ['ромн', 'romny'] },
  { town: 'Суми', oblast: 'Sumy oblast', lat: 50.9067, lng: 34.7992, tokens: ['сумськ', 'sumy'] },
  { town: 'Шостка', oblast: 'Sumy oblast', lat: 51.8657, lng: 33.4766, tokens: ['шостк', 'shostka'] },
  { town: 'Кременець', oblast: 'Ternopil oblast', lat: 50.1081, lng: 25.7275, tokens: ['кремене', 'kremenets'] },
  { town: 'Тернопіль', oblast: 'Ternopil oblast', lat: 49.5667, lng: 25.6, tokens: ['тернопі', 'ternopil'] },
  { town: 'Чортків', oblast: 'Ternopil oblast', lat: 49.0167, lng: 25.8, tokens: ['чортк', 'chortkiv'] },
  // Bare 'берест' dropped — collides with 'берестя' (birch bark); the full
  // nominative below is long enough that 'берестя' can't match it.
  { town: 'Берестин', oblast: 'Kharkiv oblast', lat: 49.3719, lng: 35.4569, tokens: ['берестин', 'berestyn'] },
  { town: 'Богодухів', oblast: 'Kharkiv oblast', lat: 50.1608, lng: 35.5164, tokens: ['богодух', 'bohodukhiv'] },
  { town: 'Ізюм', oblast: 'Kharkiv oblast', lat: 49.1958, lng: 37.2803, tokens: ['ізюм', 'izium'] },
  { town: 'Куп\'янськ', oblast: 'Kharkiv oblast', lat: 49.7114, lng: 37.6139, tokens: ['куп\'янс', 'kupiansk'] },
  { town: 'Лозова', oblast: 'Kharkiv oblast', lat: 48.8892, lng: 36.3161, tokens: ['лозов', 'lozova'] },
  { town: 'Харків', oblast: 'Kharkiv oblast', lat: 49.9925, lng: 36.2311, tokens: ['харкі', 'kharkiv'] },
  { town: 'Чугуїв', oblast: 'Kharkiv oblast', lat: 49.8372, lng: 36.6899, tokens: ['чугуї', 'chuhuiv'] },
  { town: 'Берислав', oblast: 'Kherson oblast', lat: 46.8333, lng: 33.4167, tokens: ['берисл', 'beryslav'] },
  { town: 'Генічеськ', oblast: 'Kherson oblast', lat: 46.1769, lng: 34.7989, tokens: ['генічес', 'henichesk'] },
  { town: 'Нова Каховка', oblast: 'Kherson oblast', lat: 46.755, lng: 33.375, tokens: ['нова каховка', 'nova kakhovka'] },
  { town: 'Скадовськ', oblast: 'Kherson oblast', lat: 46.1167, lng: 32.9167, tokens: ['скадовс', 'skadovsk'] },
  { town: 'Херсон', oblast: 'Kherson oblast', lat: 46.6425, lng: 32.625, tokens: ['херсо', 'kherson'] },
  { town: 'Кам\'янець-Подільський', oblast: 'Khmelnytskyi oblast', lat: 48.6806, lng: 26.5806, tokens: ['кам\'янець-подільський', 'kamianets-podilskyi'] },
  { town: 'Хмельницький', oblast: 'Khmelnytskyi oblast', lat: 49.423, lng: 26.9871, tokens: ['хмельницьк', 'khmelnytskyi'] },
  { town: 'Шепетівка', oblast: 'Khmelnytskyi oblast', lat: 50.1833, lng: 27.0667, tokens: ['шепетів', 'shepetivka'] },
  { town: 'Звенигородка', oblast: 'Cherkasy oblast', lat: 49.0833, lng: 30.9667, tokens: ['звенигород', 'zvenyhorodka'] },
  { town: 'Золотоноша', oblast: 'Cherkasy oblast', lat: 49.6667, lng: 32.0333, tokens: ['золотоно', 'zolotonosha'] },
  { town: 'Умань', oblast: 'Cherkasy oblast', lat: 48.75, lng: 30.2167, tokens: ['уман', 'uman'] },
  { town: 'Черкаси', oblast: 'Cherkasy oblast', lat: 49.4444, lng: 32.0597, tokens: ['черка', 'cherkasy'] },
  { town: 'Вижниця', oblast: 'Chernivtsi oblast', lat: 48.25, lng: 25.1917, tokens: ['вижни', 'vyzhnytsia'] },
  { town: 'Кельменці', oblast: 'Chernivtsi oblast', lat: 48.4615, lng: 26.836, tokens: ['кельмен', 'kelmentsi'] },
  { town: 'Чернівці', oblast: 'Chernivtsi oblast', lat: 48.2908, lng: 25.9344, tokens: ['чернів', 'chernivtsi'] },
  { town: 'Корюківка', oblast: 'Chernihiv oblast', lat: 51.7753, lng: 32.2497, tokens: ['корюків', 'koriukivka'] },
  { town: 'Ніжин', oblast: 'Chernihiv oblast', lat: 51.0474, lng: 31.8805, tokens: ['ніжи', 'nizhyn'] },
  { town: 'Новгород-Сіверський', oblast: 'Chernihiv oblast', lat: 51.9972, lng: 33.2667, tokens: ['новгород-сіверський', 'novhorod-siverskyi'] },
  { town: 'Прилуки', oblast: 'Chernihiv oblast', lat: 50.6, lng: 32.4, tokens: ['прилу', 'pryluky'] },
  { town: 'Чернігів', oblast: 'Chernihiv oblast', lat: 51.4939, lng: 31.2947, tokens: ['черніг', 'chernihiv'] },
  { town: 'Бахчисарай', oblast: 'Crimea', lat: 44.7528, lng: 33.8608, tokens: ['бахчисар', 'bakhchysarai'] },  // Crimea raion — no OBLAST_REFS("Crimea") entry today; kept for PLACE_COORDS pinning only
  { town: 'Білогірськ', oblast: 'Crimea', lat: 45.0544, lng: 34.6022, tokens: ['білогірс', 'bilohirsk'] },  // Crimea raion — no OBLAST_REFS("Crimea") entry today; kept for PLACE_COORDS pinning only
  { town: 'Джанкой', oblast: 'Crimea', lat: 45.7086, lng: 34.3933, tokens: ['джанк', 'dzhankoi'] },  // Crimea raion — no OBLAST_REFS("Crimea") entry today; kept for PLACE_COORDS pinning only
  { town: 'Євпаторія', oblast: 'Crimea', lat: 45.2, lng: 33.3583, tokens: ['євпатор', 'yevpatoria'] },  // Crimea raion — no OBLAST_REFS("Crimea") entry today; kept for PLACE_COORDS pinning only
  { town: 'Керч', oblast: 'Crimea', lat: 45.3607, lng: 36.4706, tokens: ['керч', 'kerch'] },  // Crimea raion — no OBLAST_REFS("Crimea") entry today; kept for PLACE_COORDS pinning only
  { town: 'Курман', oblast: 'Crimea', lat: 45.4978, lng: 34.295, tokens: ['курма', 'kurman'] },  // Crimea raion — no OBLAST_REFS("Crimea") entry today; kept for PLACE_COORDS pinning only
  { town: 'Яни Капу', oblast: 'Crimea', lat: 45.9675, lng: 33.8003, tokens: ['яни капу', 'yani kapu'] },  // Crimea raion — no OBLAST_REFS("Crimea") entry today; kept for PLACE_COORDS pinning only
  { town: 'Сімферополь', oblast: 'Crimea', lat: 44.9484, lng: 34.1, tokens: ['сімферопо', 'simferopol'] },  // Crimea raion — no OBLAST_REFS("Crimea") entry today; kept for PLACE_COORDS pinning only
  { town: 'Феодосія', oblast: 'Crimea', lat: 45.0333, lng: 35.3833, tokens: ['феодос', 'feodosia'] },  // Crimea raion — no OBLAST_REFS("Crimea") entry today; kept for PLACE_COORDS pinning only
  { town: 'Ялта', oblast: 'Crimea', lat: 44.4994, lng: 34.1553, tokens: ['ялт', 'yalta'] },  // Crimea raion — no OBLAST_REFS("Crimea") entry today; kept for PLACE_COORDS pinning only
  // ── hromada-center exceptions (see note above) — required by spec ──────────
  { town: 'Батурин', oblast: 'Chernihiv oblast', lat: 51.3413, lng: 32.8798, tokens: ['батури', 'baturyn'] },
  // 'короп' is a full homograph of the common noun 'короп' (carp, the fish)
  // — not fixable by lengthening, since the town's own nominative form IS
  // the colliding word. Accepted risk: this is one of the 4 towns confirmed
  // live (t.me/s/shahedchernihiv, "1 східніше Коропа") as a required case for
  // this feature, and the source corpus is exclusively war-alert channels
  // where "carp" essentially never appears.
  { town: 'Короп', oblast: 'Chernihiv oblast', lat: 51.5671, lng: 32.9520, tokens: ['короп', 'korop'] },
  { town: 'Сосниця', oblast: 'Chernihiv oblast', lat: 51.5223, lng: 32.5017, tokens: ['сосниц', 'sosnytsia'] },
  { town: 'Куликівка', oblast: 'Chernihiv oblast', lat: 51.3726, lng: 31.6466, tokens: ['куликів', 'kulykivka'] },
];

// Fold RAION_CENTERS tokens into their parent oblast's OBLAST_REFS entry so a
// message naming only a raion-center town (no oblast/city keyword) still
// resolves an oblast via matchOblasts(). MUST run before OBLAST_MATCHERS is
// compiled below — OBLAST_MATCHERS snapshots OBLAST_REFS.tokens at that point
// in time; reversing the order means raion tokens silently never match.
for (const r of RAION_CENTERS) {
  const target = OBLAST_REFS.find((o) => o.oblast === r.oblast);
  if (target) target.tokens.push(...r.tokens);
}

// Precompiled leading-boundary matchers per oblast (same technique as kab-threats).
// Leading boundary: must not be preceded by a letter/digit.
// Trailing letters are allowed because tokens are declension stems.
export const OBLAST_MATCHERS = OBLAST_REFS.map((ref) => ({
  ref,
  regexes: ref.tokens.map(
    (t) => new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu'),
  ),
}));

/**
 * Returns which UA oblasts are mentioned in a message.
 * Uses leading-boundary regexes compiled once at module load.
 */
export function matchOblasts(text: string): OblastRef[] {
  return OBLAST_MATCHERS
    .filter(({ regexes }) => regexes.some((re) => re.test(text)))
    .map(({ ref }) => ref);
}

// ── Unified event types ──────────────────────────────────────────────────────

export type Confidence = 'confirmed' | 'reported' | 'unverified';
export type EventType = 'battle' | 'strike' | 'unrest' | 'one-sided' | 'conflict' | 'political';

export interface ConflictEvent {
  id: string;
  lat: number;
  lng: number;
  name: string;
  url?: string;
  html?: string;
  eventType: EventType;
  sources: string[];
  confidence?: Confidence; // set by clusterEvents(); absent on raw pre-cluster events
  published?: string; // ISO 8601 UTC
  deaths?: number;
}

// ── HTML escaping for the `html` field ───────────────────────────────────────
// The `html` field is assembled from scraped RSS title/link. Escape it so the
// value stays inside the repo's "escape all external/scraped data" contract,
// even though no consumer renders it raw today (defense against a future sink).
export function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
// http(s)-only href, quote-escaped for the attribute (blocks javascript:/data:).
export function safeHref(u: string): string {
  const s = String(u ?? '').trim();
  return /^https?:\/\//i.test(s) ? escapeHtml(s) : '#';
}

// ── RSS feeds ────────────────────────────────────────────────────────────────

export const RSS_FEEDS = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',          source: 'BBC World' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml',            source: 'Al Jazeera' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', source: 'NYT World' },
  { url: 'https://kyivindependent.com/feed/',                    source: 'Kyiv Independent' },
  { url: 'https://www.ukrinform.ua/rss/block-lastnews',          source: 'Ukrinform' },
  { url: 'https://www.ukrinform.ua/rss/block-war',               source: 'Ukrinform War' },
  { url: 'https://www.unian.info/rss/war',                       source: 'UNIAN War' },
  { url: 'https://www.pravda.com.ua/eng/rss/',                   source: 'Ukrainska Pravda' },
  { url: 'https://euromaidanpress.com/feed/',                    source: 'Euromaidan Press' },
  { url: 'https://www.understandingwar.org/rss.xml',             source: 'ISW' },
  { url: 'https://meduza.io/rss/all',                            source: 'Meduza' },
  { url: 'https://www.rferl.org/api/z_yqpiiyu-qxq',             source: 'RFE/RL' },
];

// ── Geo dictionary ───────────────────────────────────────────────────────────
// Tuples are [lng, lat] (GeoJSON order).

export const GEO_DICT: Record<string, [number, number]> = {
  'ukraine':        [31.1656, 48.3794],
  'kyiv':           [30.5234, 50.4501],
  'russia':         [37.6173, 55.7558],
  'moscow':         [37.6173, 55.7558],
  'gaza':           [34.4668, 31.5017],
  'israel':         [34.8516, 31.0461],
  'tel aviv':       [34.7818, 32.0853],
  'palestine':      [35.2332, 31.9522],
  'iran':           [53.6880, 32.4279],
  'tehran':         [51.3890, 35.6892],
  'syria':          [38.9968, 34.8021],
  'lebanon':        [35.8623, 33.8547],
  'beirut':         [35.5018, 33.8938],
  'yemen':          [47.5868, 15.5527],
  'houthi':         [44.2066, 15.3694],
  'sudan':          [30.2176, 12.8628],
  'china':          [116.4074, 39.9042],
  'taiwan':         [120.9605, 23.6978],
  'korea':          [127.7669, 35.9078],
  'usa':            [-77.0369, 38.9072],
  'myanmar':        [95.9560, 21.9162],
  'haiti':          [-72.2852, 18.9712],
  'somalia':        [46.1996, 5.1521],
  'bulgaria':       [25.4858, 42.7339],
  'serbia':         [21.0059, 44.0165],
  'greece':         [21.8243, 39.0742],
  'turkey':         [35.2433, 38.9637],
  'macedonia':      [21.7453, 41.6086],
  'romania':        [24.9668, 45.9432],
  'france':         [2.2137, 46.2276],
  'germany':        [10.4515, 51.1657],
  'uk':             [-3.4359, 55.3781],
  'mexico':         [-102.5528, 23.6345],
  // Frontline cities
  'bakhmut':        [38.000, 48.596],
  'avdiivka':       [37.750, 47.967],
  'toretsk':        [37.820, 48.415],
  'chasiv yar':     [37.859, 48.577],
  'kupiansk':       [37.617, 49.709],
  'vovchansk':      [36.940, 50.291],
  'lyman':          [37.802, 48.984],
  'kostiantynivka': [37.700, 48.528],
  'pokrovsk':       [37.176, 48.279],
  'kurakhove':      [37.272, 47.988],
  'orikhiv':        [35.784, 47.568],
  'robotyne':       [35.843, 47.455],
  // Occupied / strategic
  'mariupol':       [37.549, 47.097],
  'melitopol':      [35.363, 46.847],
  'berdyansk':      [36.790, 46.756],
  'energodar':      [34.655, 47.500],
  'kramatorsk':     [37.556, 48.731],
  'sloviansk':      [37.616, 48.865],
  'kherson':        [32.601, 46.635],
  'zaporizhzhia':   [35.139, 47.838],
  'sumy':           [34.800, 50.910],
  'mykolaiv':       [31.994, 46.975],
  'odesa':          [30.723, 46.482],
  'dnipro':         [35.046, 48.465],
  'kharkiv':        [36.230, 49.990],
  'poltava':        [34.551, 49.588],
  // Russian border
  'belgorod':       [36.587, 50.595],
  'kursk':          [36.193, 51.730],
  'bryansk':        [34.364, 53.243],
  'voronezh':       [39.184, 51.672],
  // Russian interior / military airfields
  'rostov':         [39.702, 47.236],
  'krasnodar':      [38.975, 45.035],
  'novorossiysk':   [37.768, 44.724],
  'taganrog':       [38.897, 47.236],
  'volgograd':      [44.513, 48.708],
  'saratov':        [46.034, 51.533],
  'engels':         [46.209, 51.484],
  'morozovsk':      [41.791, 48.315],
  'millerovo':      [40.396, 48.922],
  'yeysk':          [38.277, 46.710],
  'ryazan':         [39.692, 54.627],
  'tula':           [37.617, 54.193],
  'smolensk':       [32.040, 54.782],
  'lipetsk':        [39.571, 52.603],
  'murmansk':       [33.083, 68.958],
  'kazan':          [49.109, 55.796],
  'samara':         [50.100, 53.196],
  'saint petersburg': [30.361, 59.931],
  'dzhankoi':       [34.393, 45.709],
  'saky':           [33.599, 45.134],
  // Crimea
  'crimea':         [34.102, 44.952],
  'sevastopol':     [33.522, 44.587],
  'kerch':          [36.470, 45.354],
  // Moldova / Belarus
  'chisinau':       [28.864, 47.010],
  'tiraspol':       [29.643, 46.843],
  'minsk':          [27.561, 53.904],
};

// ── Conflict keywords ────────────────────────────────────────────────────────

export const CONFLICT_KEYWORDS = [
  'attack', 'strike', 'missile', 'drone', 'war', 'troops', 'military',
  'protest', 'riot', 'police', 'clash', 'bomb', 'killed', 'forces',
  'mobilization', 'counterattack', 'offensive', 'ceasefire', 'shelling',
  'artillery', 'occupied', 'liberated', 'incursion', 'bridgehead',
  'shahed', 'himars', 'kab', 'glide bomb',
];

// ── Geo mapper ───────────────────────────────────────────────────────────────

// Pre-compiled at module load — avoids rebuilding 90+ RegExps on every call.
const GEO_MATCHERS: Array<[RegExp, [number, number]]> = Object.entries(GEO_DICT).map(
  ([loc, point]) => [new RegExp(`\\b${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), point],
);

/**
 * Scans text for the first GEO_DICT keyword using word-boundary matching.
 * Returns a raw [lng, lat] tuple or null if no keyword matches.
 * Callers that need map jitter must apply it themselves.
 */
export function geoMapText(text: string): [number, number] | null {
  const lower = text.toLowerCase();
  for (const [regex, point] of GEO_MATCHERS) {
    if (regex.test(lower)) return point;
  }
  return null;
}

// ── Deduplication + confidence tiering ───────────────────────────────────────

// Source families: sources within the same family share one upstream.
// 'confirmed' requires ≥2 distinct families, not just ≥2 source labels.
const SOURCE_FAMILY: Record<string, string> = {
  'gdelt':      'gdelt',
  'gdelt-rss':  'gdelt',   // same upstream as gdelt geo — not independent
  'telegram':   'telegram',
  'ucdp':       'ucdp',
  'reliefweb':  'reliefweb',
};

function bucketId(key: string): string {
  // btoa is Web-standard and edge-safe; avoids Node-only Buffer.
  return btoa(key).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c] ?? c)).slice(0, 12);
}

/**
 * Clusters raw ConflictEvents by 0.3° spatial proximity + sliding 2-hour
 * temporal window. Within each spatial cell, events are sorted by timestamp
 * and split into clusters whenever the gap between consecutive events exceeds
 * 2h — the same gap-based logic the threat-wave builder uses for Shahed waves.
 *
 * This replaces the old fixed-epoch bucket (Math.floor(ts / 7_200_000)) which
 * split events 10 min apart that straddled a wall-clock boundary into separate
 * markers, and fused unrelated events that happened to land in the same 2h slot.
 *
 * Confidence tiers (same as before):
 *   confirmed   — ≥ 2 distinct source families present
 *   unverified  — sole family is 'telegram'
 *   reported    — everything else
 */
export function clusterEvents(raw: ConflictEvent[]): ConflictEvent[] {
  const TWO_HOURS = 2 * 60 * 60 * 1_000;

  // Step 1: group by spatial cell (0.3° grid).
  const spatialGroups = new Map<string, ConflictEvent[]>();
  for (const ev of raw) {
    const spatialKey = `${Math.round(ev.lat / 0.3)}|${Math.round(ev.lng / 0.3)}`;
    const group = spatialGroups.get(spatialKey) ?? [];
    group.push(ev);
    spatialGroups.set(spatialKey, group);
  }

  const merged: ConflictEvent[] = [];

  const mergeCluster = (spatialKey: string, cluster: ConflictEvent[]) => {
    if (cluster.length === 0) return;

    let latSum = 0, lngSum = 0, totalDeaths = 0;
    let longestName = '';
    let earliestTs = Infinity;
    let firstUrl: string | undefined;
    let firstHtml: string | undefined;
    const firstEventType = cluster[0].eventType;
    const familySet = new Set<string>();
    const sourceSet = new Set<string>();

    for (const e of cluster) {
      latSum += e.lat;
      lngSum += e.lng;
      totalDeaths += e.deaths ?? 0;
      if (e.name.length > longestName.length) longestName = e.name;
      if (e.published) {
        const t = new Date(e.published).getTime();
        if (!Number.isNaN(t) && t < earliestTs) earliestTs = t;
      }
      if (!firstUrl && e.url) firstUrl = e.url;
      if (!firstHtml && e.html) firstHtml = e.html;
      for (const s of e.sources) {
        sourceSet.add(s);
        familySet.add(SOURCE_FAMILY[s] ?? s);
      }
    }

    const allSources = Array.from(sourceSet);
    const earliestPublished = isFinite(earliestTs) ? new Date(earliestTs).toISOString() : undefined;

    let confidence: Confidence;
    if (familySet.size >= 2) confidence = 'confirmed';
    else if (familySet.size === 1 && familySet.has('telegram')) confidence = 'unverified';
    else confidence = 'reported';

    // Stable ID: spatial cell + hour-floored earliest timestamp. Flooring to the
    // hour gives the same ID across consecutive API calls for the same cluster.
    const hourBucket = isFinite(earliestTs) ? Math.floor(earliestTs / 3_600_000) : Math.floor(Date.now() / 3_600_000);
    const key = `${spatialKey}|${hourBucket}`;

    merged.push({
      id: bucketId(key),
      lat: latSum / cluster.length,
      lng: lngSum / cluster.length,
      name: longestName || 'Conflict event',
      url: firstUrl,
      html: firstHtml,
      eventType: firstEventType,
      sources: allSources,
      confidence,
      published: earliestPublished,
      deaths: totalDeaths > 0 ? totalDeaths : undefined,
    });
  };

  // Step 2: within each spatial cell, sort by time then split on gaps > 2h.
  // Use ONE "now" fallback for undated events: calling Date.now() per comparison
  // made the sort comparator inconsistent (it could report a<b and b<a as the
  // clock advanced — an invalid total order) and shifted cluster boundaries
  // between iterations. A single value keeps the sort and gap-split deterministic.
  const nowFallback = Date.now();
  const tsOf = (e: ConflictEvent): number => (e.published ? new Date(e.published).getTime() : nowFallback);
  for (const [spatialKey, group] of spatialGroups) {
    group.sort((a, b) => tsOf(a) - tsOf(b));

    let currentCluster: ConflictEvent[] = [];
    for (const ev of group) {
      const ts = tsOf(ev);
      if (currentCluster.length === 0) {
        currentCluster.push(ev);
      } else {
        const lastEv = currentCluster[currentCluster.length - 1];
        const lastTs = tsOf(lastEv);
        if (ts - lastTs > TWO_HOURS) {
          mergeCluster(spatialKey, currentCluster);
          currentCluster = [ev];
        } else {
          currentCluster.push(ev);
        }
      }
    }
    mergeCluster(spatialKey, currentCluster);
  }

  return merged;
}

// ── Place geoparsing exports (used by conflict-events + telegram-threats) ─────
//
// PLACE_COORDS and the helpers below are copied from src/app/api/news/route.ts.
// Tuples are [lat, lng] — OPPOSITE of GEO_DICT which is [lng, lat].
// Do NOT modify news/route.ts — both files intentionally keep independent copies.

export const PLACE_COORDS: Record<string, [number, number]> = {
  'ukraine': [49.487, 31.272], 'kyiv': [50.450, 30.523], 'russia': [61.524, 105.318],
  'moscow': [55.755, 37.617], 'israel': [31.046, 34.851], 'gaza': [31.416, 34.333],
  'iran': [32.427, 53.688], 'lebanon': [33.854, 35.862], 'syria': [34.802, 38.996],
  'yemen': [15.552, 48.516], 'china': [35.861, 104.195], 'taiwan': [23.697, 120.960],
  'united states': [38.907, -77.036], 'europe': [48.800, 2.300], 'middle east': [31.500, 34.800],
  // Frontline cities
  'bakhmut': [48.596, 38.000], 'avdiivka': [47.967, 37.750], 'toretsk': [48.415, 37.820],
  'chasiv yar': [48.577, 37.859], 'chuhuiv': [49.836, 36.686], 'kupiansk': [49.709, 37.617],
  'vovchansk': [50.291, 36.940], 'lyman': [48.984, 37.802], 'kostiantynivka': [48.528, 37.700],
  'pokrovsk': [48.279, 37.176], 'kurakhove': [47.988, 37.272], 'velyka novosilka': [47.844, 36.797],
  'orikhiv': [47.568, 35.784], 'hulyaipole': [47.662, 36.264], 'robotyne': [47.455, 35.843],
  // Occupied/strategic
  'donetsk': [48.000, 37.800], 'luhansk': [48.566, 39.300], 'mariupol': [47.097, 37.549],
  'melitopol': [46.847, 35.363], 'berdyansk': [46.756, 36.790], 'tokmak': [47.255, 35.706],
  'nova kakhovka': [46.759, 33.388], 'energodar': [47.500, 34.655],
  'kramatorsk': [48.731, 37.556], 'sloviansk': [48.865, 37.616],
  'kherson': [46.635, 32.601], 'zaporizhzhia': [47.838, 35.139], 'sumy': [50.910, 34.800],
  'mykolaiv': [46.975, 31.994], 'odesa': [46.482, 30.723], 'dnipro': [48.465, 35.046],
  'kharkiv': [49.990, 36.230], 'kremenchuk': [49.066, 33.420], 'poltava': [49.588, 34.551],
  'cherkasy': [49.445, 32.060],
  // Russian border oblasts
  'belgorod': [50.595, 36.587], 'kursk': [51.730, 36.193], 'bryansk': [53.243, 34.364],
  'voronezh': [51.672, 39.184], 'rostov': [47.222, 39.719],
  // Crimea
  'crimea': [44.952, 34.102], 'sevastopol': [44.587, 33.522], 'kerch': [45.354, 36.470],
  'simferopol': [44.952, 34.102],
  // Moldova/Transnistria
  'chisinau': [47.010, 28.864], 'transnistria': [47.200, 29.400], 'tiraspol': [46.843, 29.643],
  // Belarus
  'minsk': [53.904, 27.561], 'grodno': [53.678, 23.829], 'brest': [52.097, 23.734],
  // Other Ukrainian oblast capitals / large cities
  'lviv': [49.840, 24.030], 'vinnytsia': [49.233, 28.468], 'zhytomyr': [50.255, 28.659],
  'rivne': [50.619, 26.252], 'ternopil': [49.554, 25.595], 'ivano-frankivsk': [48.923, 24.711],
  'uzhhorod': [48.621, 22.288], 'chernihiv': [51.494, 31.294], 'chernivtsi': [48.292, 25.935],
  'khmelnytskyi': [49.423, 26.987], 'lutsk': [50.747, 25.325], 'kropyvnytskyi': [48.508, 32.262],
  'kryvyi rih': [47.910, 33.391], 'nikopol': [47.567, 34.392], 'pavlohrad': [48.520, 35.870],
  'izyum': [49.212, 37.249], 'okhtyrka': [50.310, 34.899],
  // Wider hotspots
  'tel aviv': [32.085, 34.781], 'jerusalem': [31.769, 35.214], 'beirut': [33.888, 35.495],
  'damascus': [33.513, 36.292], 'tehran': [35.689, 51.389], 'sanaa': [15.369, 44.191],
  'red sea': [20.284, 38.512], 'saint petersburg': [59.931, 30.361], 'novorossiysk': [44.724, 37.768],
  // Russian cities, border oblasts and military airfields
  'krasnodar': [45.035, 38.975], 'taganrog': [47.236, 38.897], 'volgograd': [48.708, 44.513],
  'saratov': [51.533, 46.034], 'engels': [51.484, 46.209], 'morozovsk': [48.315, 41.791],
  'millerovo': [48.922, 40.396], 'yeysk': [46.710, 38.277], 'ryazan': [54.627, 39.692],
  'tula': [54.193, 37.617], 'smolensk': [54.782, 32.040], 'lipetsk': [52.603, 39.571],
  'murmansk': [68.958, 33.083], 'kazan': [55.796, 49.109], 'samara': [53.196, 50.100],
  'dzhankoi': [45.709, 34.393], 'saky': [45.134, 33.599],
  'kronstadt': [59.990, 29.760], 'кронштадт': [59.990, 29.760],
  // Ukrainian / slang spellings of Russian cities
  'пітер': [59.931, 30.361],
  'пітєр': [59.931, 30.361],
  'новоросійськ': [44.724, 37.768],
  // Russian cities absent from gazetteer (new UA strike targets)
  'кизилюрт': [43.209, 46.868],
  'чебоксар': [56.144, 47.249],
  'самар': [53.196, 50.100],
  'владімірськ': [56.130, 40.411],
  'владимирск': [56.130, 40.411],
  'ust-labinsk': [45.220, 39.710], 'усть-лабинск': [45.220, 39.710], 'усть-лабінськ': [45.220, 39.710],
  'zugres': [48.010, 38.510], 'зугрес': [48.010, 38.510], 'зугрэс': [48.010, 38.510],
  'зуївська тес': [48.010, 38.510],
  // Cyrillic -- broad (country/peninsula)
  'россия': [61.524, 105.318], 'украина': [49.487, 31.272], 'крым': [44.952, 34.102],
  // Cyrillic -- Russia
  'москва': [55.756, 37.617], 'петербург': [59.931, 30.361], 'белгород': [50.596, 36.587],
  'курск': [51.730, 36.193], 'брянск': [53.244, 34.364], 'воронеж': [51.672, 39.184],
  'ростов': [47.236, 39.702], 'краснодар': [45.035, 38.975], 'новороссийск': [44.724, 37.768],
  'таганрог': [47.236, 38.897], 'волгоград': [48.708, 44.513], 'саратов': [51.533, 46.034],
  'энгельс': [51.484, 46.209], 'морозовск': [48.315, 41.791], 'миллерово': [48.922, 40.396],
  'ейск': [46.710, 38.277], 'рязань': [54.627, 39.692], 'дягилево': [54.643, 39.570],
  'тула': [54.193, 37.617], 'смоленск': [54.782, 32.040], 'липецк': [52.603, 39.571],
  'мурманск': [68.958, 33.083], 'оленегорск': [68.152, 33.464], 'казань': [55.796, 49.109],
  'севастополь': [44.587, 33.522], 'джанкой': [45.709, 34.393], 'саки': [45.134, 33.599],
  // Cyrillic -- Ukraine / occupied
  'київ': [50.450, 30.523], 'киев': [50.450, 30.523], 'харків': [49.990, 36.230],
  'харьков': [49.990, 36.230], 'покровськ': [48.279, 37.176], 'покровск': [48.279, 37.176],
  'красноармейск': [48.279, 37.176], 'бахмут': [48.596, 38.000], 'артёмовск': [48.596, 38.000],
  'артемовск': [48.596, 38.000], 'авдіївка': [47.967, 37.750], 'авдеевка': [47.967, 37.750],
  'торецьк': [48.415, 37.820], 'торецк': [48.415, 37.820], 'купянск': [49.709, 37.617],
  'вовчанськ': [50.291, 36.940], 'вовчанск': [50.291, 36.940], 'запоріжжя': [47.838, 35.139],
  'запорожье': [47.838, 35.139], 'херсон': [46.635, 32.601], 'миколаїв': [46.975, 31.994],
  'николаев': [46.975, 31.994], 'одеса': [46.482, 30.723], 'одесса': [46.482, 30.723],
  'дніпро': [48.465, 35.046], 'днепр': [48.465, 35.046], 'суми': [50.910, 34.800],
  'сумы': [50.910, 34.800], 'маріуполь': [47.097, 37.549], 'мариуполь': [47.097, 37.549],
  'вугледар': [47.779, 37.250], 'угледар': [47.779, 37.250],
  'львів': [49.840, 24.030], 'львов': [49.840, 24.030], 'полтава': [49.588, 34.551],
  'черкаси': [49.445, 32.060], 'чернігів': [51.494, 31.294], 'чернигов': [51.494, 31.294],
  'краматорськ': [48.731, 37.556], 'краматорск': [48.731, 37.556], 'словянськ': [48.865, 37.616],
  'славянск': [48.865, 37.616], 'ізюм': [49.212, 37.249], 'изюм': [49.212, 37.249],
  'нікополь': [47.567, 34.392], 'никополь': [47.567, 34.392], 'кременчук': [49.066, 33.420],
  // Ukrainian oblique-case stems
  'києв': [50.450, 30.523], 'харков': [49.990, 36.230], 'чернігов': [51.494, 31.294],
  'дніпр': [48.465, 35.046], 'миколаєв': [46.975, 31.994],
  // Gazetteer refinement (2026): front-line towns + RU strike targets
  'часів яр': [48.577, 37.859], 'часов яр': [48.577, 37.859],
  'костянтинівк': [48.528, 37.700], 'константиновк': [48.528, 37.700],
  'курахов': [47.988, 37.272], 'новосілк': [47.844, 36.797], 'новоселк': [47.844, 36.797],
  'оріхів': [47.568, 35.784], 'гуляйпол': [47.662, 36.264],
  'роботин': [47.455, 35.843], 'работин': [47.455, 35.843],
  'енергодар': [47.500, 34.655], 'энергодар': [47.500, 34.655],
  'каховк': [46.759, 33.388], 'токмак': [47.255, 35.706],
  'бердянськ': [46.756, 36.790], 'бердянск': [46.756, 36.790],
  'чугуїв': [49.836, 36.686], 'чугуев': [49.836, 36.686],
  "куп'янськ": [49.709, 37.617], 'павлоград': [48.520, 35.870],
  'охтирк': [50.310, 34.899], 'ахтырк': [50.310, 34.899],
  // Active hotspots
  'sudzha': [51.198, 35.273], 'судж': [51.198, 35.273],
  'selydove': [48.146, 37.295], 'селидов': [48.146, 37.295],
  'myrnohrad': [48.308, 37.265], 'мирноград': [48.308, 37.265],
  'novohrodivka': [48.200, 37.353], 'новогродівк': [48.200, 37.353], 'новогродовк': [48.200, 37.353],
  'hrodivka': [48.279, 37.380], 'гродівк': [48.279, 37.380], 'гродовк': [48.279, 37.380],
  'krasnohorivka': [48.011, 37.500], 'красногорівк': [48.011, 37.500], 'красногоровк': [48.011, 37.500],
  'marinka': [47.948, 37.500], "мар'їнк": [47.948, 37.500], 'марьинк': [47.948, 37.500],
  'krynky': [46.700, 33.000], 'кринки': [46.700, 33.000],
  'vremivka': [47.770, 36.660], 'времівк': [47.770, 36.660], 'времевк': [47.770, 36.660],
  // RU strike targets
  'tuapse': [44.104, 39.080], 'туапсе': [44.104, 39.080],
  'syzran': [53.159, 48.474], 'сызран': [53.159, 48.474],
  'kstovo': [56.149, 44.197], 'кстов': [56.149, 44.197],
  'ust-luga': [59.668, 28.270], 'усть-луга': [59.668, 28.270],
  'feodosia': [45.040, 35.380], 'феодос': [45.040, 35.380],
  'novoshakhtinsk': [47.776, 39.934], 'новошахтинск': [47.776, 39.934],
  'primorsko-akhtarsk': [46.046, 38.150], 'приморско-ахтарск': [46.046, 38.150],
  'akhtubinsk': [48.285, 46.193], 'ахтубинск': [48.285, 46.193],
  'toropets': [56.500, 31.633], 'торопец': [56.500, 31.633], 'торопц': [56.500, 31.633],
  'tikhoretsk': [45.856, 40.126], 'тихорецк': [45.856, 40.126],
  'dyagilevo': [54.643, 39.570], 'olenya': [68.152, 33.464],
  // Krasnodar Krai refineries
  'poltavskaya': [45.26, 38.13], 'полтавська': [45.26, 38.13], 'полтавская': [45.26, 38.13],
  'slavyansk-na-kubani': [45.26, 38.13], 'славянськ': [45.26, 38.13], 'славянск-на-кубани': [45.26, 38.13],
  'taman': [45.201, 36.728], 'таман': [45.201, 36.728],
  'tamanneftegaz': [45.201, 36.728], 'таманнефтегаз': [45.201, 36.728], 'таманэфтегаз': [45.201, 36.728],
  // Nizhnekamsk industrial cluster
  'nizhnekamsk': [55.64, 51.83], 'нижнекамск': [55.64, 51.83], 'нижнєкамськ': [55.64, 51.83],
  'taneco': [55.77, 51.88], 'танеко': [55.77, 51.88],
  'taif-nk': [55.64, 51.82], 'таіф-нк': [55.64, 51.82], 'taif': [55.64, 51.82], 'таіф': [55.64, 51.82],
  // Maritime / sea areas
  'black sea': [43.300, 33.800], 'чорне море': [43.300, 33.800], 'чёрное море': [43.300, 33.800],
  'azov sea': [46.200, 37.500], 'azov': [46.200, 37.500],
  'азовське море': [46.200, 37.500], 'азовское море': [46.200, 37.500],
  // Romanian port
  'constanta': [44.175, 28.638], 'констанц': [44.175, 28.638],
  // Occupied ports
  'berdiansk': [46.756, 36.790], 'бердіянськ': [46.756, 36.790],
  // Active frontline towns -- Latin variants
  'vuhledar': [47.779, 37.250],
  // Active frontline towns -- Cyrillic variants
  'велика новосілка': [47.844, 36.797], 'велика новоселка': [47.844, 36.797],
  'ліпці': [50.16, 36.49], 'lyptsi': [50.16, 36.49],
  'білогорівка': [47.91, 38.09], 'bilohorivka': [47.91, 38.09],
  'урожайне': [47.51, 36.98], 'urozhaine': [47.51, 36.98],
};

// Fold RAION_CENTERS into PLACE_COORDS so findBestPlace()/findAllNamedPlaces()
// can pin the precise raion-town coordinate, not just the oblast centroid.
// MUST run before COMPILED_PLACE_GAZETTEER is built below (it reads
// PLACE_COORDS via Object.entries() at that exact point) — reversing the
// order means raion towns silently never make it into the compiled gazetteer.
// Raion towns get rank 2 (same as existing cities) — NOT added to
// BROAD_PLACE_KEYS, so they never outrank a more specific match.
for (const r of RAION_CENTERS) {
  for (const tok of r.tokens) PLACE_COORDS[tok] = [r.lat, r.lng];
}

// Country / sea area centroids -- only used as a last resort.
export const BROAD_PLACE_KEYS = new Set<string>([
  'ukraine', 'russia', 'israel', 'iran', 'lebanon', 'syria', 'yemen', 'china',
  'taiwan', 'united states', 'europe', 'middle east', 'crimea', 'transnistria',
  'россия', 'украина', 'крым',
  'black sea', 'azov sea', 'azov', 'чорне море', 'чёрное море', 'азовське море', 'азовское море',
]);

// Build a whole-word matcher for one gazetteer key.
// Unicode-aware boundaries; Cyrillic keys allow a short trailing case-suffix.
function placeKeywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isCyrillic = /[Ѐ-ӿ]/.test(keyword);
  const tail = isCyrillic ? '\\p{L}{0,6}(?![\\p{L}\\p{N}])' : '(?![\\p{L}\\p{N}])';
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${tail}`, 'iu');
}

// Compiled once at module load -- same shape as COMPILED_GAZETTEER in news/route.ts.
export const COMPILED_PLACE_GAZETTEER: Array<{
  re: RegExp;
  coords: [number, number];
  rank: number;
  keyword: string;
}> = Object.entries(PLACE_COORDS).map(([keyword, coords]) => ({
  re: placeKeywordRegex(keyword),
  coords,
  rank: BROAD_PLACE_KEYS.has(keyword) ? 1 : 2, // named city beats country
  keyword,
}));

/**
 * Resolve the most specific place a text is about, keeping the matched
 * gazetteer keyword alongside the coords (callers that only need the point
 * should use findPlaceCoords below).
 * Prefers city/town over country centroid; among equally specific matches
 * picks the one mentioned first.
 *
 * coords are [lat, lng] -- NOT GeoJSON order. Callers must not swap.
 */
export function findBestPlace(text: string): { coords: [number, number]; name: string } | null {
  const lower = text.toLowerCase();
  let best: { coords: [number, number]; name: string; rank: number; pos: number } | null = null;
  for (const { re, coords, rank, keyword } of COMPILED_PLACE_GAZETTEER) {
    const m = re.exec(lower);
    if (!m) continue;
    const pos = m.index;
    if (!best || rank > best.rank || (rank === best.rank && pos < best.pos)) {
      best = { coords, name: keyword, rank, pos };
    }
  }
  return best ? { coords: best.coords, name: best.name } : null;
}

/**
 * Resolve the most specific place a text is about.
 * Prefers city/town over country centroid; among equally specific matches
 * picks the one mentioned first.
 *
 * Returns [lat, lng] -- NOT GeoJSON order. Callers must not swap.
 */
export function findPlaceCoords(text: string): [number, number] | null {
  return findBestPlace(text)?.coords ?? null;
}

/**
 * Same resolution as findPlaceCoords() but also returns the matched place's
 * name/keyword — for callers that need to display or compare the place, not
 * just its coordinates (e.g. picking a pin location and its label together).
 */
export function findBestPlace(text: string): { coords: [number, number]; name: string } | null {
  const lower = text.toLowerCase();
  let best: { coords: [number, number]; name: string; rank: number; pos: number } | null = null;
  for (const { re, coords, rank, keyword } of COMPILED_PLACE_GAZETTEER) {
    const m = re.exec(lower);
    if (!m) continue;
    const pos = m.index;
    if (!best || rank > best.rank || (rank === best.rank && pos < best.pos)) {
      best = { coords, name: keyword, rank, pos };
    }
  }
  return best ? { coords: best.coords, name: best.name } : null;
}

/**
 * Returns every distinct specific place named in text (rank=2 city/town matches only;
 * broad country/sea centroids excluded).
 *
 * Coords are [lat, lng] -- same as PLACE_COORDS tuples.
 */
export function findAllNamedPlaces(text: string): { coords: [number, number]; name: string }[] {
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  const out: { coords: [number, number]; name: string }[] = [];
  for (const { re, coords, rank, keyword } of COMPILED_PLACE_GAZETTEER) {
    if (rank < 2) continue;
    const key = `${coords[0]},${coords[1]}`;
    if (!seen.has(key) && re.test(lower)) {
      seen.add(key);
      out.push({ coords, name: keyword });
    }
  }
  return out;
}
