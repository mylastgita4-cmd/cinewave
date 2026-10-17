import { getMetadataAdapter, getTorrentAdapter } from './adapters.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const cfg = readConfig(env);

    try {
      if (url.pathname === '/api/movies') {
        return await withLimits(env, cfg, cors, () => handleMovies(env, cfg, url, cors));
      }
      if (url.pathname === '/api/latest') {
        return await withLimits(env, cfg, cors, () => handleLatest(env, cfg, cors));
      }
      if (url.pathname === '/api/torrents') {
        return await withLimits(env, cfg, cors, () => handleTorrents(env, cfg, url, cors));
      }
      if (url.pathname === '/api/health') {
        return json({
          ok: true,
          metadataProvider: cfg.metadataProvider,
          torrentProvider: cfg.torrentProvider,
          kvBound: !!env.CACHE,
        }, 200, cors);
      }
      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      console.error('Worker error:', e && e.message);
      return json({ error: e.message || 'Internal error' }, e.status || 500, cors);
    }
  },
};

function readConfig(env) {
  return {
    // Frontend normally calls providers directly from the visitor's device;
    // these Worker routes are the cached fallback. 'itunes' kept as name for
    // the proxy adapter; set METADATA_PROVIDER in wrangler.toml if preferred.
    metadataProvider: env.METADATA_PROVIDER || 'itunes',
    torrentProvider: env.TORRENT_PROVIDER || 'yts',
    tmdbApiKey: env.TMDB_API_KEY || '',
    imageBase: env.IMAGE_BASE || 'https://image.tmdb.org/t/p/w500',
    cacheTtl: parseInt(env.CACHE_TTL || '3600', 10),
    torrentTtl: parseInt(env.TORRENT_CACHE_TTL || '900', 10),
    latestTtl: parseInt(env.LATEST_CACHE_TTL || '1800', 10),
    rlMax: parseInt(env.RATE_LIMIT_MAX || '30', 10),
    rlWindow: parseInt(env.RATE_LIMIT_WINDOW || '60', 10),
    jackettBase: env.JACKETT_BASE_URL || '',
    jackettKey: env.JACKETT_API_KEY || '',
    jackettIndexer: env.JACKETT_INDEXER || 'all',
    prowlarrBase: env.PROWLARR_BASE_URL || '',
    prowlarrKey: env.PROWLARR_API_KEY || '',
  };
}

async function withLimits(env, cfg, cors, fn) {
  if (env.CACHE) {
    const bucket = Math.floor(Date.now() / 1000 / cfg.rlWindow);
    const key = 'rl:global:' + bucket;
    const count = parseInt((await env.CACHE.get(key)) || '0', 10) + 1;
    await env.CACHE.put(key, String(count), { expirationTtl: cfg.rlWindow });
    if (count > cfg.rlMax) {
      return json({ error: 'Rate limit exceeded. Please wait a minute.' }, 429, cors,
        { 'Retry-After': String(cfg.rlWindow) });
    }
  }
  return fn();
}

async function handleMovies(env, cfg, url, cors) {
  const q = (url.searchParams.get('q') || '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  if (!q) return json({ error: 'Missing search query' }, 400, cors);

  // iTunes Search API has no pagination parameter: fetch full window once, cache, slice.
  const baseKey = 'movies:' + cfg.metadataProvider + ':' + q.toLowerCase();
  let full = await cacheGet(env, baseKey);
  if (!full) {
    const adapter = getMetadataAdapter(cfg.metadataProvider);
    full = await adapter.search(cfg, q, 1);
    await cachePut(env, baseKey, full, cfg.cacheTtl);
  }

  const perPage = full.perPage || 20;
  const totalPages = full.totalPages || 1;
  const start = (page - 1) * perPage;

  return json({
    page: page,
    perPage: perPage,
    totalPages: totalPages,
    totalResults: full.totalResults,
    results: (full.results || []).slice(start, start + perPage),
    source: full.source,
  }, 200, cors);
}

// Latest movies via YTS documented parameter sort_by=date_added (keyless).
async function handleLatest(env, cfg, cors) {
  const key = 'latest:' + cfg.torrentProvider;
  const cached = await cacheGet(env, key);
  if (cached) return json(cached, 200, cors);

  const data = await fetchJSON(
    'https://yts.mx/api/v2/list_movies.json?limit=20&sort_by=date_added&order_by=desc'
  );
  const movies = (data && data.data && data.data.movies) || [];
  const results = movies.map(m => ({
    id: m.imdb_code || String(m.id),
    title: m.title,
    year: m.year ? String(m.year) : '',
    overview: m.synopsis || m.description_full || '',
    genres: m.genres || [],
    poster: m.medium_cover_image || null,
    rating: m.rating,
    trailerUrl: null,
    storeUrl: null,
    artist: null,
    source: 'YTS',
    _ytsTitle: m.title,
    _ytsYear: m.year,
  }));
  const payload = { results: results, totalResults: results.length, source: 'yts' };
  await cachePut(env, key, payload, cfg.latestTtl);
  return json(payload, 200, cors);
}

async function handleTorrents(env, cfg, url, cors) {
  const q = (url.searchParams.get('q') || '').trim();
  const year = url.searchParams.get('year') || '';
  if (!q) return json({ error: 'Missing query' }, 400, cors);

  const query = year ? (q + ' ' + year) : q;
  const key = 'torrents:' + cfg.torrentProvider + ':' + query.toLowerCase();
  const cached = await cacheGet(env, key);
  if (cached) return json(cached, 200, cors);

  const adapter = getTorrentAdapter(cfg.torrentProvider);
  const data = await adapter.search(cfg, query, 1);

  const seen = new Set();
  const torrents = (data.torrents || []).filter(t => {
    const k = (t.infoHash ||
      (t.title || '').toLowerCase().replace(/\W+/g, '') + '|' + (t.sizeBytes || t.size)).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => (b.seeds || 0) - (a.seeds || 0));

  const payload = { query: query, torrents: torrents, totalResults: torrents.length,
    provider: cfg.torrentProvider };
  await cachePut(env, key, payload, cfg.torrentTtl);
  return json(payload, 200, cors);
}

// ---- Caching: uses the existing CACHE KV binding; falls back to in-memory ----
const mem = new Map();
async function cacheGet(env, key) {
  const hit = mem.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  if (env.CACHE) {
    const raw = await env.CACHE.get('cw:' + key, 'json');
    if (raw && raw.exp > Date.now()) {
      mem.set(key, { value: raw.value, exp: raw.exp });
      return raw.value;
    }
  }
  return null;
}
async function cachePut(env, key, value, ttl) {
  const exp = Date.now() + ttl * 1000;
  mem.set(key, { value: value, exp: exp });
  if (env.CACHE) {
    await env.CACHE.put('cw:' + key, JSON.stringify({ value: value, exp: exp }),
      { expirationTtl: ttl });
  }
}

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: {
      // Browser-like UA improves odds against provider bot filters on proxy calls
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36',
      'Accept': 'application/json',
    },
  });
  if (res.status === 403) {
    throw Object.assign(new Error(
      'The upstream provider refused this server-side request (HTTP 403). ' +
      'This provider blocks datacenter IPs — the site will use browser-direct requests instead.'
    ), { status: 502 });
  }
  if (!res.ok) throw Object.assign(new Error('Upstream returned ' + res.status), { status: 502 });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { throw Object.assign(new Error('Upstream returned invalid data'), { status: 502 }); }
}

function json(obj, status, extra, more) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' },
      extra || {}, more || {}),
  });
}
