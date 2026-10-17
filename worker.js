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
        return await withLimits(env, cfg, cors, () => handleHome(env, cfg, cors));
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
          tmdbKeyPresent: !!env.TMDB_API_KEY,
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
    metadataProvider: env.METADATA_PROVIDER || 'tmdb',
    torrentProvider: env.TORRENT_PROVIDER || 'yts',
    tmdbApiKey: env.TMDB_API_KEY || '',
    imageBase: env.IMAGE_BASE || 'https://image.tmdb.org/t/p/w500',
    cacheTtl: parseInt(env.CACHE_TTL || '3600', 10),
    torrentTtl: parseInt(env.TORRENT_CACHE_TTL || '900', 10),
    homeTtl: parseInt(env.HOME_CACHE_TTL || '1800', 10),
    rlMax: parseInt(env.RATE_LIMIT_MAX || '60', 10),
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

// ---- Homepage: Latest (now_playing) + Popular, TMDB, KV-cached ----
async function handleHome(env, cfg, cors) {
  if (!cfg.tmdbApiKey) {
    return json({
      error: 'TMDB_API_KEY is not set. The previous homepage source (yts.mx) is offline ' +
        '(Cloudflare 530 / origin DNS failure), so TMDB is now required. ' +
        'Fix: get a free key at themoviedb.org, then run: npx wrangler secret put TMDB_API_KEY',
      needsSetup: true,
    }, 503, cors);
  }

  const [latest, popular] = await Promise.all([
    loadHomeSection(env, cfg, 'now_playing'),
    loadHomeSection(env, cfg, 'popular'),
  ]);

  // If now_playing failed, popular is already the fallback inside loadHomeSection;
  // still return popular so the homepage is never empty.
  return json({
    latest: latest.movies,
    latestSource: latest.source,
    popular: popular.movies,
    popularSource: popular.source,
  }, 200, cors);
}

async function loadHomeSection(env, cfg, section) {
  const key = 'home:' + section;
  const cached = await cacheGet(env, key);
  if (cached) return { movies: cached, source: 'tmdb (cache)' };

  let movies = [];
  let source = 'tmdb';
  try {
    const data = await fetchJSON(
      'https://api.themoviedb.org/3/movie/' + section +
      '?api_key=' + cfg.tmdbApiKey + '&language=en-US&page=1'
    );
    movies = (data.results || []).map(m => ({
      id: String(m.id),
      title: m.title,
      year: (m.release_date || '').slice(0, 4),
      releaseDate: m.release_date || '',
      overview: m.overview || '',
      poster: m.poster_path ? cfg.imageBase + m.poster_path : null,
      rating: m.vote_average,
      genres: [], // ids resolved client-side against the static genre map
      genreIds: m.genre_ids || [],
      trailerUrl: null,
      storeUrl: null,
      source: 'TMDB',
    }));
  } catch (e) {
    if (section === 'now_playing') {
      // Requirement: never leave the homepage stuck. Fall back to popular data.
      const popKey = 'home:popular';
      const pop = await cacheGet(env, popKey);
      if (pop) return { movies: pop, source: 'tmdb popular (fallback)' };
      const data = await fetchJSON(
        'https://api.themoviedb.org/3/movie/popular?api_key=' + cfg.tmdbApiKey + '&language=en-US&page=1'
      );
      movies = (data.results || []).map(m => ({
        id: String(m.id), title: m.title,
        year: (m.release_date || '').slice(0, 4),
        releaseDate: m.release_date || '',
        overview: m.overview || '',
        poster: m.poster_path ? cfg.imageBase + m.poster_path : null,
        rating: m.vote_average,
        genres: [], genreIds: m.genre_ids || [],
        trailerUrl: null, storeUrl: null, source: 'TMDB',
      }));
      source = 'tmdb popular (fallback)';
    }
    // If 'popular' itself fails here, empty array is returned and the
    // frontend shows a clear retry message — not a stuck loader.
  }

  if (movies.length) await cachePut(env, key, movies, cfg.homeTtl);
  return { movies: movies, source: source };
}

// ---- Search: TMDB when key present (primary), iTunes adapter as keyless fallback ----
async function handleMovies(env, cfg, url, cors) {
  const q = (url.searchParams.get('q') || '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  if (!q) return json({ error: 'Missing search query' }, 400, cors);
  if (q.length > 100) return json({ error: 'Query too long' }, 400, cors);

  // Prefer TMDB when configured; else keyless iTunes (fetch-full-window + slice).
  const provider = cfg.tmdbApiKey ? 'tmdb' : cfg.metadataProvider;
  const key = 'movies:' + provider + ':' + q.toLowerCase() + (provider === 'tmdb' ? ':' + page : '');

  let payload = await cacheGet(env, key);
  if (!payload) {
    const adapter = getMetadataAdapter(provider);
    payload = await adapter.search(cfg, q, page);
    await cachePut(env, key, payload, cfg.cacheTtl);
  }

  if (provider === 'tmdb') {
    return json(payload, 200, cors); // TMDB adapter already returns correct page shape
  }
  // iTunes-style full-window payload: slice server-side
  const perPage = payload.perPage || 20;
  const totalPages = payload.totalPages || 1;
  const start = (page - 1) * perPage;
  return json({
    page: page, perPage: perPage, totalPages: totalPages,
    totalResults: payload.totalResults,
    results: (payload.results || []).slice(start, start + perPage),
    source: payload.source,
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

// ---- Caching: existing CACHE KV binding; in-memory fallback ----
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
  const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'CineWave/1.0' } });
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
