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

    let cfg;
    try {
      cfg = readConfig(env);
    } catch (e) {
      return json({ error: e.message || 'Bad configuration' }, 500, cors);
    }

    try {
      if (url.pathname === '/api/movies') {
        return await withLimits(env, cfg, cors, () => handleMovies(env, cfg, url, cors));
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
          tmdbSecretPresent: !!env.TMDB_API_KEY,
        }, 200, cors);
      }
      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      console.error('Worker error:', e && e.message, e && e.stack);
      return json({ error: e.message || 'Internal error' }, e.status || 500, cors);
    }
  },
};

function readConfig(env) {
  const metadataProvider = env.METADATA_PROVIDER || 'itunes';
  // Guard: if config still says tmdb but no secret exists, fall back to keyless
  // provider instead of erroring on every search.
  if (metadataProvider === 'tmdb' && !env.TMDB_API_KEY) {
    console.warn('METADATA_PROVIDER is "tmdb" but TMDB_API_KEY missing; falling back to itunes.');
    return buildConfig(env, 'itunes');
  }
  return buildConfig(env, metadataProvider);
}

function buildConfig(env, metadataProvider) {
  return {
    metadataProvider: metadataProvider,
    torrentProvider: env.TORRENT_PROVIDER || 'yts',
    tmdbApiKey: env.TMDB_API_KEY || '',
    imageBase: env.IMAGE_BASE || 'https://image.tmdb.org/t/p/w500',
    cacheTtl: parseInt(env.CACHE_TTL || '3600', 10),
    torrentTtl: parseInt(env.TORRENT_CACHE_TTL || '900', 10),
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
    const ip = 'global'; // per-IP needs the request; kept simple and KV-efficient
    const bucket = Math.floor(Date.now() / 1000 / cfg.rlWindow);
    const key = 'rl:' + ip + ':' + bucket;
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
  if (q.length > 100) return json({ error: 'Query too long' }, 400, cors);

  // Cache the FULL result window once, then slice pages from it.
  // (iTunes Search API has no server-side pagination parameter.)
  const baseKey = 'movies:' + cfg.metadataProvider + ':' + q.toLowerCase();
  let full = await cacheGet(env, baseKey);
  if (!full) {
    const adapter = getMetadataAdapter(cfg.metadataProvider);
    full = await adapter.search(cfg, q, 1); // adapters fetch their full window
    await cachePut(env, baseKey, full, cfg.cacheTtl);
  }

  const perPage = full.perPage || 20;
  const totalPages = full.totalPages || 1;

  if (page > totalPages) {
    return json({ page: page, perPage: perPage, totalPages: totalPages,
      totalResults: full.totalResults, results: [], source: full.source }, 200, cors);
  }

  const start = (page - 1) * perPage;
  const sliced = (full.results || []).slice(start, start + perPage);

  return json({
    page: page,
    perPage: perPage,
    totalPages: totalPages,
    totalResults: full.totalResults,
    results: sliced,
    source: full.source,
  }, 200, cors);
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

  // Duplicate detection: dedupe by infohash, fallback to normalized title+size
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

// ---- Caching (KV if bound, otherwise in-memory per isolate) ----
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

function json(obj, status, extra, more) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' },
      extra || {}, more || {}),
  });
}
