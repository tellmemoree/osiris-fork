import { NextRequest, NextResponse } from 'next/server';

/**
 * Server-side IP geolocation proxy (avoids mixed-content block on HTTPS pages).
 *
 * SCALE DESIGN (≈333K visitors/month): a visitor's location is stable, so each
 * IP is resolved at most once per hour and cached in-process — repeat page loads
 * cost nothing and never re-hit the providers' per-IP daily limits. The three
 * providers race in PARALLEL (first success wins) so a slow/dead provider can't
 * add latency, and failures are negative-cached briefly to stop retry storms.
 */

type Geo = Record<string, unknown>;
const cache = new Map<string, { data: Geo; expiry: number }>();
const OK_TTL = 60 * 60 * 1000;   // 1h — geo is stable
const FAIL_TTL = 30 * 1000;      // 30s — don't hammer on failure
const FAIL = { __fail: true } as Geo;

async function ipapiCo(ip: string): Promise<Geo | null> {
  const url = ip ? `https://ipapi.co/${ip}/json/` : 'https://ipapi.co/json/';
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store', headers: { 'User-Agent': 'OSIRIS/5.0' } });
  if (!res.ok) throw new Error('ipapi.co');
  const d = await res.json();
  if (d.error || !d.latitude) throw new Error('ipapi.co empty');
  return { status: 'success', query: d.ip, lat: d.latitude, lon: d.longitude, city: d.city, regionName: d.region, country: d.country_name, isp: d.org || 'Unknown', org: d.org || 'Unknown', as: d.asn ? `AS${d.asn} ${d.org}` : 'Unknown' };
}
async function freeIpApi(ip: string): Promise<Geo | null> {
  const url = ip ? `https://freeipapi.com/api/json/${ip}` : 'https://freeipapi.com/api/json';
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
  if (!res.ok) throw new Error('freeipapi');
  const d = await res.json();
  if (!d.latitude) throw new Error('freeipapi empty');
  return { status: 'success', query: d.ipAddress || ip || 'auto', lat: d.latitude, lon: d.longitude, city: d.cityName || 'Unknown', regionName: d.regionName || 'Unknown', country: d.countryName || 'Unknown', isp: d.isp || 'Unknown', org: d.isp || 'Unknown', as: 'Unknown' };
}
async function ipApiCom(ip: string): Promise<Geo | null> {
  const q = 'fields=status,lat,lon,city,regionName,country,query,isp,org,as';
  const url = ip ? `http://ip-api.com/json/${ip}?${q}` : `http://ip-api.com/json/?${q}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
  if (!res.ok) throw new Error('ip-api');
  const d = await res.json();
  if (d.status !== 'success') throw new Error('ip-api empty');
  return d;
}

export async function GET(request: NextRequest) {
  const clientIp =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '';
  const isPrivate = !clientIp || clientIp === '::1' || clientIp === '127.0.0.1' || clientIp.startsWith('192.168.') || clientIp.startsWith('10.') || clientIp.startsWith('172.');
  const ip = isPrivate ? '' : clientIp;
  const key = ip || 'auto';

  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) {
    if ((hit.data as any).__fail) {
      return NextResponse.json({ error: 'All geolocation providers failed (cached)' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(hit.data, { headers: { 'Cache-Control': 'private, max-age=3600' } });
  }

  try {
    // Race all providers — first valid answer wins, dead providers can't add latency.
    const data = await Promise.any([ipapiCo(ip), freeIpApi(ip), ipApiCom(ip)]);
    cache.set(key, { data: data!, expiry: Date.now() + OK_TTL });
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, max-age=3600' } });
  } catch {
    cache.set(key, { data: FAIL, expiry: Date.now() + FAIL_TTL });
    return NextResponse.json({ error: 'All geolocation providers failed' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
