// SkyTrack server: proxies OpenSky Network, caches, never exposes credentials.
// Run: node server.js   (Node 18+, no dependencies)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.OPENSKY_CLIENT_ID;       // optional, free account
const CLIENT_SECRET = process.env.OPENSKY_CLIENT_SECRET; // optional, higher limits
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const API = 'https://opensky-network.org/api';
const CACHE_MS = 10000;
const AIRLABS_KEY = process.env.AIRLABS_API_KEY; // optional, enables route info
const routeCache = new Map(); // callsign -> {t, body}

let token = null, tokenExp = 0;
async function authHeaders() {
  if (!CLIENT_ID || !CLIENT_SECRET) return {};
  if (!token || Date.now() > tokenExp - 30000) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    });
    if (!res.ok) throw new Error('OpenSky auth failed: ' + res.status);
    const j = await res.json();
    token = j.access_token;
    tokenExp = Date.now() + (j.expires_in || 1800) * 1000;
  }
  return { Authorization: 'Bearer ' + token };
}

const cache = new Map();
async function cached(key, url) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return { data: hit.data, fetchedAt: hit.t, cached: true };
  try {
    const res = await fetch(url, { headers: await authHeaders(), signal: AbortSignal.timeout(8000) });
    if (res.status === 429) throw new Error('Rate limit reached (OpenSky 429)');
    if (!res.ok) throw new Error('OpenSky error ' + res.status);
    const data = await res.json();
    cache.set(key, { t: Date.now(), data });
    return { data, fetchedAt: Date.now(), cached: false };
  } catch (e) {
    if (hit) return { data: hit.data, fetchedAt: hit.t, cached: true, error: e.message };
    throw e;
  }
}

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
function normalize(s) {
  return {
    icao24: s[0], callsign: (s[1] || '').trim() || null, country: s[2],
    lastContact: num(s[4]), lon: num(s[5]), lat: num(s[6]),
    altitudeM: num(s[7]) ?? num(s[13]), onGround: !!s[8], speedMs: num(s[9]),
    heading: num(s[10]), vertRateMs: num(s[11]), squawk: s[14] || null, source: 'OpenSky Network'
  };
}

// Route/aircraft lookup via adsbdb.com (free, no key). Cached 6h, including misses.
const detCache = new Map();
async function adsbdb(p) {
  const hit = detCache.get(p);
  if (hit && Date.now() - hit.t < 6 * 3600e3) return hit.v;
  const r = await fetch('https://api.adsbdb.com/v0/' + p);
  let v = null;
  if (r.ok) { const j = await r.json(); v = j && typeof j.response === 'object' ? j.response : null; }
  else if (r.status !== 404) throw new Error('adsbdb error ' + r.status);
  detCache.set(p, { t: Date.now(), v });
  return v;
}

// Backup source: adsb.lol (free, community ADS-B). Used when OpenSky is unreachable (common from cloud hosts).
let osDownUntil = 0;
const hav = (a, b, c, d) => { const r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const mul = (v, k) => (num(v) === null ? null : v * k);
async function adsbLol(lamin, lomin, lamax, lomax) {
  const clat = (lamin + lamax) / 2, clon = (lomin + lomax) / 2;
  const radius = Math.min(250, Math.max(10, Math.ceil(Math.max(hav(clat, clon, lamin, lomin), hav(clat, clon, lamax, lomax)) / 1.852)));
  const key = `adsb:${clat.toFixed(1)},${clon.toFixed(1)},${radius}`;
  const hit = cache.get(key);
  let data, t;
  if (hit && Date.now() - hit.t < CACHE_MS) { data = hit.data; t = hit.t; }
  else {
    const r = await fetch(`https://api.adsb.lol/v2/point/${clat.toFixed(3)}/${clon.toFixed(3)}/${radius}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('adsb.lol error ' + r.status);
    data = await r.json(); t = Date.now(); cache.set(key, { t, data });
  }
  const nowMs = num(data.now) || t;
  const aircraft = (data.ac || [])
    .filter(a => /^[0-9a-f]{6}$/i.test(a.hex || '') && num(a.lat) !== null && num(a.lon) !== null && a.lat >= lamin && a.lat <= lamax && a.lon >= lomin && a.lon <= lomax)
    .map(a => { const gnd = a.alt_baro === 'ground';
      return { icao24: a.hex.toLowerCase(), callsign: (a.flight || '').trim() || null, country: 'Unavailable',
        lastContact: Math.round(nowMs / 1000 - (num(a.seen_pos) ?? num(a.seen) ?? 0)), lon: a.lon, lat: a.lat,
        altitudeM: gnd ? 0 : mul(num(a.alt_baro) ?? num(a.alt_geom), 0.3048), onGround: gnd, speedMs: mul(a.gs, 1 / 1.944),
        heading: num(a.track), vertRateMs: mul(a.baro_rate, 0.00508), squawk: a.squawk || null, source: 'adsb.lol' }; });
  return { apiTime: nowMs, fetchedAt: t, cached: !!hit && t === hit.t, warning: null, count: aircraft.length, aircraft, provider: 'adsb.lol' };
}

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const inRange = (v, lo, hi) => isFinite(v) && v >= lo && v <= hi;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/aircraft') {
      const q = ['lamin', 'lomin', 'lamax', 'lomax'].map(k => Number(u.searchParams.get(k)));
      if (!inRange(q[0], -90, 90) || !inRange(q[2], -90, 90) || !inRange(q[1], -180, 180) || !inRange(q[3], -180, 180))
        return json(res, 400, { error: 'Invalid bounding box' });
      const [lamin, lomin, lamax, lomax] = q.map(n => n.toFixed(1)); // round so nearby views share cache
      let body = null;
      if (Date.now() >= osDownUntil) {
        try {
          const r = await cached(`bb:${lamin},${lomin},${lamax},${lomax}`,
            `${API}/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`);
          if (r.error) throw new Error(r.error);
          const aircraft = (r.data.states || []).map(normalize).filter(a => a.lat !== null && a.lon !== null);
          body = { apiTime: r.data.time * 1000, fetchedAt: r.fetchedAt, cached: r.cached, warning: null, count: aircraft.length, aircraft, provider: 'OpenSky Network' };
        } catch (e) { osDownUntil = Date.now() + 120000; console.log('OpenSky failed (' + e.message + '), using adsb.lol for 2 min'); }
      }
      if (!body) body = await adsbLol(q[0], q[1], q[2], q[3]);
      return json(res, 200, body);
    }
    if (u.pathname === '/api/track') {
      const id = (u.searchParams.get('icao24') || '').toLowerCase();
      if (!/^[0-9a-f]{6}$/.test(id)) return json(res, 400, { error: 'Invalid ICAO24' });
      if (Date.now() < osDownUntil) return json(res, 200, { path: [] });
      const r = await cached('tr:' + id, `${API}/tracks/all?icao24=${id}&time=0`);
      return json(res, 200, { callsign: r.data.callsign, start: r.data.startTime, end: r.data.endTime, path: (r.data.path || []).map(p => ({ t: p[0], lat: p[1], lon: p[2], altM: p[3], heading: p[4], onGround: p[5] })) });
    }
    if (u.pathname === '/api/route') {
      if (!AIRLABS_KEY) return json(res, 200, { available: false, reason: 'No AirLabs key set (AIRLABS_API_KEY).' });
      const cs = (u.searchParams.get('callsign') || '').toUpperCase();
      const hex = (u.searchParams.get('icao24') || '').toLowerCase();
      if (!/^[A-Z0-9]{3,8}$/.test(cs)) return json(res, 200, { available: false, reason: 'Aircraft has no callsign.' });
      const hit = routeCache.get(cs);
      if (hit && Date.now() - hit.t < 300000) return json(res, 200, hit.body);
      const r = await fetch(`https://airlabs.co/api/v9/flight?flight_icao=${cs}&api_key=${AIRLABS_KEY}`);
      const j = await r.json();
      const f = j.response;
      let body;
      if (j.error || !f) body = { available: false, reason: (j.error && j.error.message) || 'No route found for this callsign.' };
      else if ((f.hex || '').toLowerCase() !== hex) body = { available: false, reason: 'Provider returned a different aircraft for this flight number, so route is not shown.' };
      else body = { available: true, source: 'AirLabs', airline: f.airline_iata, flight: f.flight_iata, aircraft: f.model || f.aircraft_icao, reg: f.reg_number,
        dep: f.dep_iata || f.dep_icao, arr: f.arr_iata || f.arr_icao, depTime: f.dep_actual || f.dep_estimated || f.dep_time, arrTime: f.arr_estimated || f.arr_time, status: f.status };
      routeCache.set(cs, { t: Date.now(), body });
      return json(res, 200, body);
    }
    if (u.pathname === '/api/details') {
      const id = (u.searchParams.get('icao24') || '').toLowerCase();
      const cs = (u.searchParams.get('callsign') || '').trim().toUpperCase();
      if (!/^[0-9a-f]{6}$/.test(id)) return json(res, 400, { error: 'Invalid ICAO24' });
      const [ac, rt] = await Promise.all([
        adsbdb('aircraft/' + id).catch(() => null),
        /^[A-Z0-9]{2,8}$/.test(cs) ? adsbdb('callsign/' + cs).catch(() => null) : null
      ]);
      return json(res, 200, { aircraft: (ac && ac.aircraft) || null, route: (rt && rt.flightroute) || null, source: 'adsbdb.com' });
    }
    // static files
    const file = u.pathname === '/' ? '/index.html' : u.pathname;
    const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(path.join(__dirname, 'public'))) return json(res, 403, { error: 'Forbidden' });
    fs.readFile(full, (err, buf) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': full.endsWith('.html') ? 'text/html' : 'text/plain' });
      res.end(buf);
    });
  } catch (e) {
    json(res, 502, { error: e.message });
  }
});
server.listen(PORT, () => console.log(`SkyTrack running at http://localhost:${PORT}` + (CLIENT_ID ? ' (authenticated)' : ' (anonymous: low quota)') + (AIRLABS_KEY ? ' | routes: AirLabs on' : ' | routes: off (no AIRLABS_API_KEY)')));
