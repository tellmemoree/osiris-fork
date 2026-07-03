/**
 * OSIRIS — Hong Kong CCTV Cameras (Transport Department)
 * Source: https://tdcctv.data.one.gov.hk/
 * ~230 cameras — NO API KEY NEEDED, direct JPG URLs
 */

// Hong Kong camera locations with WGS84 coordinates (pre-converted from HK1980 Grid)
// Source: data.gov.hk traffic snapshot camera list
const HK_CAMERAS = [
  { id: 'K101', lat: 22.3372, lng: 114.1542, name: 'Kwai Chung Rd / Container Port Rd', area: 'Kwai Chung' },
  { id: 'K103', lat: 22.3441, lng: 114.1367, name: 'Tuen Mun Rd near Sham Tseng', area: 'Sham Tseng' },
  { id: 'K104', lat: 22.3649, lng: 114.1115, name: 'Tuen Mun Rd near Ting Kau', area: 'Ting Kau' },
  { id: 'K107', lat: 22.3294, lng: 114.1594, name: 'Kwai Chung Rd near Lai Chi Kok', area: 'Lai Chi Kok' },
  { id: 'K110', lat: 22.3186, lng: 114.1682, name: 'West Kowloon Highway', area: 'West Kowloon' },
  { id: 'K112', lat: 22.2974, lng: 114.1720, name: 'West Kowloon Corridor', area: 'Yau Ma Tei' },
  { id: 'K116', lat: 22.3027, lng: 114.1771, name: 'Gascoigne Rd Flyover', area: 'Jordan' },
  { id: 'K118', lat: 22.3130, lng: 114.1781, name: 'Princess Margaret Rd', area: 'Ho Man Tin' },
  { id: 'K201', lat: 22.2833, lng: 114.1551, name: 'Cross-Harbour Tunnel (Kowloon)', area: 'Hung Hom' },
  { id: 'K202', lat: 22.2798, lng: 114.1784, name: 'Eastern Harbour Crossing (Kowloon)', area: 'Kowloon Bay' },
  { id: 'K203', lat: 22.2858, lng: 114.1879, name: 'Kwun Tong Bypass', area: 'Kwun Tong' },
  { id: 'K301', lat: 22.3152, lng: 114.2128, name: 'Tate\'s Cairn Tunnel', area: 'Diamond Hill' },
  { id: 'K304', lat: 22.3232, lng: 114.2022, name: 'Lung Cheung Rd', area: 'Wong Tai Sin' },
  { id: 'K305', lat: 22.3379, lng: 114.1876, name: 'Lion Rock Tunnel Rd', area: 'Sha Tin' },
  { id: 'K402', lat: 22.3071, lng: 114.2138, name: 'Clearwater Bay Rd', area: 'Ngau Chi Wan' },
  { id: 'H101', lat: 22.2802, lng: 114.1544, name: 'Cross-Harbour Tunnel (HK Island)', area: 'Causeway Bay' },
  { id: 'H102', lat: 22.2760, lng: 114.1765, name: 'Eastern Harbour Crossing (HK Island)', area: 'Quarry Bay' },
  { id: 'H103', lat: 22.2758, lng: 114.1870, name: 'Eastern Corridor near Tai Koo', area: 'Tai Koo' },
  { id: 'H105', lat: 22.2643, lng: 114.2234, name: 'Island Eastern Corridor', area: 'Shau Kei Wan' },
  { id: 'H106', lat: 22.2531, lng: 114.2370, name: 'Eastern Corridor near Chai Wan', area: 'Chai Wan' },
  { id: 'H201', lat: 22.2849, lng: 114.1513, name: 'Canal Road Flyover', area: 'Wan Chai' },
  { id: 'H202', lat: 22.2826, lng: 114.1422, name: 'Connaught Rd Central', area: 'Central' },
  { id: 'H203', lat: 22.2866, lng: 114.1364, name: 'Western Harbour Crossing', area: 'Sheung Wan' },
  { id: 'H301', lat: 22.2469, lng: 114.1618, name: 'Aberdeen Tunnel', area: 'Happy Valley' },
  { id: 'H302', lat: 22.2402, lng: 114.1567, name: 'Aberdeen - Wong Chuk Hang', area: 'Wong Chuk Hang' },
  { id: 'N101', lat: 22.3737, lng: 114.1125, name: 'Tuen Mun Highway', area: 'Tuen Mun' },
  { id: 'N102', lat: 22.3896, lng: 114.0997, name: 'Tuen Mun Rd near Castle Peak', area: 'Castle Peak' },
  { id: 'N103', lat: 22.3940, lng: 114.1092, name: 'Yuen Long Highway', area: 'Yuen Long' },
  { id: 'N104', lat: 22.4128, lng: 114.1226, name: 'San Tin Highway', area: 'San Tin' },
  { id: 'N105', lat: 22.4314, lng: 114.0919, name: 'Deep Bay Link near Shenzhen Bay', area: 'Shenzhen Bay' },
  { id: 'N201', lat: 22.3708, lng: 114.1734, name: 'Sha Tin - Tai Po', area: 'Sha Tin' },
  { id: 'N203', lat: 22.4132, lng: 114.1649, name: 'Fanling Highway', area: 'Fanling' },
  { id: 'N204', lat: 22.4406, lng: 114.1635, name: 'San Tin near Lok Ma Chau', area: 'Lok Ma Chau' },
  { id: 'N205', lat: 22.4539, lng: 114.1291, name: 'Man Kam To', area: 'Man Kam To' },
  { id: 'N301', lat: 22.3544, lng: 114.2289, name: 'Sai Kung - Clear Water Bay', area: 'Sai Kung' },
  { id: 'T101', lat: 22.2945, lng: 113.9399, name: 'Lantau Link', area: 'Lantau' },
  { id: 'T102', lat: 22.3100, lng: 113.9231, name: 'North Lantau Highway', area: 'Tung Chung' },
  { id: 'T103', lat: 22.3142, lng: 113.9435, name: 'Tsing Ma Bridge', area: 'Tsing Yi' },
  { id: 'T104', lat: 22.3285, lng: 113.9606, name: 'Kap Shui Mun Bridge', area: 'Ma Wan' },
  { id: 'BC101', lat: 22.2977, lng: 114.1634, name: 'Gloucester Rd', area: 'Wan Chai' },
  { id: 'BC102', lat: 22.2956, lng: 114.1689, name: 'Victoria Park', area: 'Causeway Bay' },
  { id: 'BC103', lat: 22.2902, lng: 114.1726, name: 'King\'s Rd', area: 'North Point' },
  { id: 'BC104', lat: 22.3101, lng: 114.1890, name: 'Prince Edward Rd', area: 'Kowloon City' },
  { id: 'BC105', lat: 22.3194, lng: 114.1695, name: 'Nathan Rd - Mong Kok', area: 'Mong Kok' },
  { id: 'BC106', lat: 22.3078, lng: 114.1717, name: 'Nathan Rd - Tsim Sha Tsui', area: 'Tsim Sha Tsui' },
  { id: 'BC107', lat: 22.2793, lng: 114.1321, name: 'Des Voeux Rd', area: 'Central' },
  { id: 'BC108', lat: 22.3376, lng: 114.1478, name: 'Cheung Sha Wan Rd', area: 'Cheung Sha Wan' },
  { id: 'BC109', lat: 22.3485, lng: 114.1337, name: 'Tai Po Rd - Tsuen Wan', area: 'Tsuen Wan' },
];

export async function fetchHongKongCameras(): Promise<any[]> {
  return HK_CAMERAS.map(cam => ({
    id: `hk-${cam.id}`,
    lat: cam.lat,
    lng: cam.lng,
    name: cam.name,
    city: cam.area,
    country: 'Hong Kong',
    feed_url: `https://tdcctv.data.one.gov.hk/${cam.id}F.JPG`,
    source: 'HK Transport',
  }));
}
