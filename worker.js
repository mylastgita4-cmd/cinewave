import {
  getMetadataAdapter,
  getTorrentAdapter,
} from './adapters.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const cfg = readConfig(env);

    try {
      if (url.pathname === '/api/home' || url.pathname === '/api/latest') {
        return await withLimits(env, cfg, cors, () => handleHome(env, cfg, cors));
      }
      if (url.pathname === '/api/movies') {
        return await withLimits(env, cfg, cors, () => handleMovies(env, cfg, url, cors));
      }
      if (url.pathname === '/api/torrents') {
        return await withLimits(env, cfg, cors, () => handleTorrents(env, cfg, url, cors));
      }
      if (url.pathname === '/api/trailer') {
        return await withLimits(env, cfg, cors, () => handleTrailer(env, cfg, url, cors));
      }
      if (url.pathname === '/api/health') {
        return await handleHealth(env, cfg, cors);
      }

      if (!env.ASSETS) {
        return json({ error: 'Static assets binding ASSETS is not configured' }, 500, cors);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error('Worker error:', e && e.message);
      return json({ error: e && e.message ? e.message : 'Internal error' },
        (e && e.status) || 500, cors);
    }
  },
};

function readConfig(env) {
  const primaryProvider = env.TORRENT_PROVIDER || 'yts';
  return {
    tmdbApiKey: env.TMDB_API_KEY || '',
    imageBase: env.IMAGE_BASE || 'https://image.tmdb.org/t/p/w500',
    cacheTtl: positiveInt(env.CACHE_TTL, 3600),
    torrentTtl: positiveInt(env.TORRENT_CACHE_TTL, 900),
    homeTtl: positiveInt(env.HOME_CACHE_TTL || env.LATEST_CACHE_TTL, 1800),
    rlMax: positiveInt(env.RATE_LIMIT_MAX, 60),
    rlWindow: positiveInt(env.RATE_LIMIT_WINDOW, 60),
    torrentProvider: primaryProvider,
    torrentFallbacks: [...new Set([primaryProvider, 'tpb', 'torrentscsv'])],
    torrentTimeoutMs: positiveInt(env.TORRENT_TIMEOUT_MS, 12000),
    torrentRetries: nonNegativeInt(env.TORRENT_RETRIES, 2),
    retryBaseMs: positiveInt(env.RETRY_BASE_MS, 600),
    cooldownTtl: positiveInt(env.PROVIDER_COOLDOWN_TTL, 300),
    torrentMinResults: positiveInt(env.TORRENT_MIN_RESULTS, 10),
    // 90 days. Override with TORRENT_BACKUP_TTL (seconds) if desired.
    torrentBackupTtl: positiveInt(env.TORRENT_BACKUP_TTL, 7776000),
    jackettBase: env.JACKETT_BASE_URL || '',
    jackettKey: env.JACKETT_API_KEY || '',
    jackettIndexer: env.JACKETT_INDEXER || 'all',
    prowlarrBase: env.PROWLARR_BASE_URL || '',
    prowlarrKey: env.PROWLARR_API_KEY || '',
    ytsBase: env.YTS_BASE_URL || '',
    tpbBase: env.TPB_BASE_URL || '',
  };
}

function positiveInt(value, fallback) {
  const n = parseInt(value == null || value === '' ? String(fallback) : String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function nonNegativeInt(value, fallback) {
  const n = parseInt(value == null || value === '' ? String(fallback) : String(value), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function withLimits(env, cfg, cors, fn) {
  if (env.CACHE) {
    const bucket = Math.floor(Date.now() / 1000 / cfg.rlWindow);
    const key = 'rl:global:' + bucket;
    const count = (parseInt((await env.CACHE.get(key)) || '0', 10) || 0) + 1;
    await env.CACHE.put(key, String(count), { expirationTtl: cfg.rlWindow });
    if (count > cfg.rlMax) {
      return json({ error: 'Rate limit exceeded. Please wait a minute.' },
        429, cors, { 'Retry-After': String(cfg.rlWindow) });
    }
  }
  return fn();
}

async function handleHealth(env, cfg, cors) {
  const names = [...new Set(cfg.torrentFallbacks.concat(['jackett', 'prowlarr']))];
  const adapters = [];
  for (const name of names) {
    let available = false;
    let configured = true;
    try { getTorrentAdapter(name); available = true; } catch { available = false; }
    if (name === 'jackett' && !(cfg.jackettBase && cfg.jackettKey)) configured = false;
    if (name === 'prowlarr' && !(cfg.prowlarrBase && cfg.prowlarrKey)) configured = false;
    adapters.push({
      name, adapterAvailable: available, configured,
      cooldownActive: configured ? await isCoolingDown(env, name) : false,
    });
  }
  return json({
    ok: true,
    tmdbKeyPresent: !!env.TMDB_API_KEY,
    homepageMode: cfg.tmdbApiKey ? 'tmdb' : 'itunes-keyless',
    kvBound: !!env.CACHE,
    torrentProvider: cfg.torrentProvider,
    torrentFallbacks: cfg.torrentFallbacks,
    torrentTimeoutMs: cfg.torrentTimeoutMs,
    torrentRetries: cfg.torrentRetries,
    torrentBackupTtl: cfg.torrentBackupTtl,
    torrentBackupDays: Math.floor(cfg.torrentBackupTtl / 86400),
    adapters,
    jackettConfigured: !!(cfg.jackettBase && cfg.jackettKey),
    prowlarrConfigured: !!(cfg.prowlarrBase && cfg.prowlarrKey),
  }, 200, cors);
}

async function isCoolingDown(env, provider) {
  if (!env.CACHE) return false;
  const raw = await env.CACHE.get('cooldown:' + provider);
  if (!raw) return false;
  try { return JSON.parse(raw).until > Date.now(); } catch { return false; }
}

async function setCooldown(env, provider, ttl, retryAfterSec) {
  if (!env.CACHE) return;
  let seconds = ttl;
  if (retryAfterSec && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    seconds = Math.min(Math.max(retryAfterSec, ttl), 900);
  }
  await env.CACHE.put('cooldown:' + provider,
    JSON.stringify({ until: Date.now() + seconds * 1000 }),
    { expirationTtl: seconds });
}
async function clearCooldown(env, provider) {
  if (!env.CACHE) return;
  await env.CACHE.put('cooldown:' + provider, JSON.stringify({ until: 0 }), { expirationTtl: 60 });
}
function isRetryableError(e) {
  if (!e) return false;
  if (e.name === 'AbortError' || /timed out/i.test(e.message || '')) return true;
  return e.retryable === true;
}
async function withProviderRetry(env, cfg, providerName, fn) {
  const attempts = Math.max(1, cfg.torrentRetries + 1);
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastError = e;
      if (!isRetryableError(e) || i === attempts - 1) break;
      await sleep(Math.min(cfg.retryBaseMs * Math.pow(2, i), 4000));
    }
  }
  if (lastError && lastError.cooldown) {
    await setCooldown(env, providerName, cfg.cooldownTtl, lastError.retryAfterSec);
  }
  throw lastError || new Error('Provider failed');
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function handleHome(env, cfg, cors) {
  if (cfg.tmdbApiKey) {
    const [latest, popular] = await Promise.all([
      tmdbSection(env, cfg, 'now_playing', cfg.homeTtl),
      tmdbSection(env, cfg, 'popular', cfg.homeTtl),
    ]);
    return json({
      mode: 'tmdb', latest: latest.movies, latestSource: latest.source,
      popular: popular.movies, popularSource: popular.source,
    }, 200, cors);
  }
  const key = 'home:itunes';
  let cached = await cacheGet(env, key);
  if (!cached) {
    try {
      const data = await fetchJSON('https://itunes.apple.com/us/rss/topmovies/limit=50/json');
      const entries = (((data || {}).feed || {}).entry || []);
      const movies = (Array.isArray(entries) ? entries : [entries]).map(e => ({
        id: e.id && e.id.attributes ? e.id.attributes['im:id'] : (e.id && e.id.label) || '',
        title: e['im:name'] ? e['im:name'].label : '',
        year: e['im:releaseDate'] ? (e['im:releaseDate'].label || '').slice(0, 4) : '',
        releaseDate: e['im:releaseDate'] ? e['im:releaseDate'].label : '',
        overview: e.summary ? e.summary.label : '',
        poster: e['im:image'] ? e['im:image'][e['im:image'].length - 1].label : null,
        rating: null,
        genres: e.category ? [e.category.attributes?.label || ''] : [],
        genreIds: [], trailerUrl: null, storeUrl: null, source: 'iTunes',
      })).filter(m => m.title);
      cached = { movies, source: 'itunes-keyless' };
      await cachePut(env, key, cached, cfg.homeTtl);
    } catch (e) {
      cached = { movies: [], source: 'itunes-keyless', error: e.message };
    }
  }
  return json({
    mode: 'itunes-keyless', latest: cached.movies || [],
    latestSource: cached.source || 'itunes-keyless', popular: [], popularSource: '',
    notice: cached.error ? 'Movie data temporarily unavailable: ' + cached.error
      : 'The homepage is using the Apple movie feed.',
  }, 200, cors);
}

async function tmdbSection(env, cfg, section, ttl) {
  const key = 'home:tmdb:' + section;
  const cached = await cacheGet(env, key);
  if (cached) return { movies: cached, source: 'tmdb (cache)' };
  try {
    const data = await fetchJSON('https://api.themoviedb.org/3/movie/' + section +
      '?api_key=' + encodeURIComponent(cfg.tmdbApiKey) + '&language=en-US&page=1');
    const movies = (data.results || []).map(m => ({
      id: String(m.id), title: m.title, year: (m.release_date || '').slice(0, 4),
      releaseDate: m.release_date || '', overview: m.overview || '',
      poster: m.poster_path ? cfg.imageBase + m.poster_path : null,
      rating: m.vote_average, genres: [], genreIds: m.genre_ids || [],
      trailerUrl: null, storeUrl: null, source: 'TMDB',
    }));
    if (movies.length) await cachePut(env, key, movies, ttl);
    return { movies, source: 'tmdb' };
  } catch (e) { return { movies: [], source: 'tmdb (' + e.message + ')' }; }
}

async function handleMovies(env, cfg, url, cors) {
  const q = (url.searchParams.get('q') || '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const typeRaw = (url.searchParams.get('type') || 'all').toLowerCase();
  const type = ['all','movie','tv'].includes(typeRaw) ? typeRaw : 'all';
  if (!q) return json({ error: 'Missing search query' }, 400, cors);
  if (q.length > 100) return json({ error: 'Query too long' }, 400, cors);
  const provider = cfg.tmdbApiKey ? 'tmdb' : 'itunes';
  const adapter = getMetadataAdapter(provider);
  if (provider === 'itunes' && type === 'tv') return json({ page, perPage: 30, totalPages: 1, totalResults: 0, results: [], source: 'itunes', notice: 'TV Series search requires TMDB_API_KEY.' }, 200, cors);
  const perPage = 30;
  const upstreamPage = Math.max(1, Math.floor(((page - 1) * perPage) / 20) + 1);
  const offset = ((page - 1) * perPage) % 20;
  const cacheKey = 'movies:' + provider + ':' + type + ':' + q.toLowerCase() + ':' + page;
  let payload = await cacheGet(env, cacheKey);
  if (!payload) {
    if (provider === 'tmdb') {
      const first = await adapter.search(cfg, q, upstreamPage, type);
      let combined = first.results || [];
      if (first.totalPages > upstreamPage) {
        const second = await adapter.search(cfg, q, upstreamPage + 1, type);
        combined = combined.concat(second.results || []);
      }
      combined.sort((a,b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));
      const results = combined.slice(offset, offset + perPage);
      payload = { page, perPage, totalPages: Math.max(1, Math.ceil((first.totalResults || 0) / perPage)), totalResults: first.totalResults || 0, results, source: 'tmdb' };
    } else {
      const all = await adapter.search(cfg, q, 1, 'movie');
      const sorted = (all.results || []).sort((a,b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));
      payload = { page, perPage, totalPages: Math.max(1, Math.ceil(sorted.length / perPage)), totalResults: sorted.length, results: sorted.slice((page-1)*perPage, page*perPage), source: all.source };
    }
    await cachePut(env, cacheKey, payload, cfg.cacheTtl);
  }
  return json(payload, 200, cors);
}

async function handleTorrents(env, cfg, url, cors) {
  const q = (url.searchParams.get('q') || '').trim();
  const year = parseInt(url.searchParams.get('year') || '0', 10) || 0;
  if (!q) return json({ error: 'Missing query' }, 400, cors);
  if (q.length > 200) return json({ error: 'Query too long' }, 400, cors);

  const normTitle = normalizeTitle(q);
  const key = 'torrents:multi:' + normTitle + ':' + year;
  const cached = await cacheGet(env, key);
  if (cached) return json(cached, 200, cors);

  const errors = [];
  const merged = [];
  const usedProviders = [];

  for (const providerName of cfg.torrentFallbacks) {
    if (merged.length >= cfg.torrentMinResults) break;
    let adapter;
    try { adapter = getTorrentAdapter(providerName); } catch { continue; }

    if (providerName === 'jackett' && !(cfg.jackettBase && cfg.jackettKey)) continue;
    if (providerName === 'prowlarr' && !(cfg.prowlarrBase && cfg.prowlarrKey)) continue;

    if (await isCoolingDown(env, providerName)) {
      errors.push(providerName + ': cooling down after a recent failure');
      continue;
    }

    try {
      const data = await withProviderRetry(env, cfg, providerName, () =>
        withTimeout(adapter.search(cfg, q, 1), cfg.torrentTimeoutMs));
      const items = data && Array.isArray(data.torrents) ? data.torrents : [];
      if (items.length) {
        merged.push(...items);
        usedProviders.push(providerName);
        await clearCooldown(env, providerName);
        if (merged.length >= cfg.torrentMinResults) break;
        continue;
      }
      if (!usedProviders.includes(providerName)) usedProviders.push(providerName);
      errors.push(providerName + ': no results');
    } catch (e) {
      errors.push(providerName + ': ' + (e.message || 'failed'));
    }
  }

  const backupKey = 'torrents:backup:' + normTitle + ':' + year;

  // If every provider failed or returned nothing, prefer the last good backup.
  if (!merged.length) {
    const backup = await getBackup(env, backupKey);
    if (backup) {
      return json({
        ...backup, stale: true,
        providerError: 'Current torrent providers did not return results; showing saved backup.' +
          (errors.length ? ' Details: ' + errors.join(' | ') : ''),
      }, 200, cors);
    }
    const empty = {
      query: q, year, torrents: [], totalResults: 0,
      provider: cfg.torrentProvider,
      providerError: 'Torrent index temporarily unavailable (' +
        (errors.join(' | ') || 'no response') + ')',
    };
    // Do not let an empty/error response replace a good backup.
    await cachePut(env, key, empty, 120);
    return json(empty, 200, cors);
  }

  const seen = new Set();
  const torrents = merged.filter(t => {
    const title = String(t.title || '');
    const hash = String(t.infoHash || '').toLowerCase();
    const uniqueKey = hash ||
      (title.toLowerCase().replace(/\W+/g, '') + '|' + (t.sizeBytes || t.size || '')).toLowerCase();
    if (seen.has(uniqueKey)) return false;
    seen.add(uniqueKey);

    if (normTitle && !normalizedContains(title, normTitle)) return false;
    if (year) {
      const releaseYear = extractYear(title);
      if (releaseYear && Math.abs(releaseYear - year) > 1) return false;
    }
    if (!t.magnet && !t.torrentUrl) return false;
    return true;
  });

  torrents.sort((a, b) =>
    qualityRank(b.resolution) - qualityRank(a.resolution) ||
    ((b.seeds || 0) - (a.seeds || 0))
  );

  // Critical backup fix: filtering can remove all fresh results.
  // In that case, return the previous last-known-good backup.
  if (!torrents.length) {
    const backup = await getBackup(env, backupKey);
    if (backup) {
      return json({
        ...backup, stale: true,
        providerError: 'Current results were unusable after filtering; showing saved backup.',
      }, 200, cors);
    }
  }

  const payload = {
    query: q, year, torrents, totalResults: torrents.length,
    provider: usedProviders.join('+') || cfg.torrentProvider,
  };
  if (!torrents.length && errors.length) {
    payload.providerError = 'Torrent index temporarily unavailable (' + errors.join(' | ') + ')';
  }

  // Only save non-empty, validated results. Keep the prior backup intact otherwise.
  if (torrents.length) {
    const backupPayload = {
      query: q, year, torrents, totalResults: torrents.length,
      provider: payload.provider, savedAt: new Date().toISOString(),
    };
    await cachePut(env, backupKey, backupPayload, cfg.torrentBackupTtl);
  }

  // Do not store a fresh empty result over an existing cache entry for long.
  await cachePut(env, key, payload, payload.providerError ? 120 : cfg.torrentTtl);
  return json(payload, 200, cors);
}

function normalizeTitle(value) {
  return String(value || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function normalizedContains(haystack, needle) {
  return normalizeTitle(haystack).includes(needle);
}
function extractYear(title) {
  const match = /\b(19\d{2}|20\d{2})\b/.exec(String(title || ''));
  return match ? parseInt(match[1], 10) : 0;
}
function qualityRank(resolution) {
  const r = String(resolution || '');
  if (/2160|4k/i.test(r)) return 4;
  if (/1080/i.test(r)) return 3;
  if (/720/i.test(r)) return 2;
  if (/480/i.test(r)) return 1;
  return 0;
}
async function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(
        new Error('Timed out after ' + (ms / 1000) + 's'),
        { retryable: true }
      )), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function handleTrailer(env, cfg, url, cors) {
  if (!cfg.tmdbApiKey) return json({ trailerUrl: null }, 200, cors);
  const id = (url.searchParams.get('id') || '').trim();
  const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
  if (!/^\d+$/.test(id)) return json({ trailerUrl: null }, 200, cors);
  const key = 'trailer:' + type + ':' + id;
  const cached = await cacheGet(env, key);
  if (cached) return json(cached, 200, cors);
  let payload = { trailerUrl: null };
  try {
    const data = await fetchJSON('https://api.themoviedb.org/3/' + type + '/' + id +
      '/videos?api_key=' + encodeURIComponent(cfg.tmdbApiKey) + '&language=en-US');
    const vids = data.results || [];
    const yt = vids.find(v => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ||
      vids.find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
      vids.find(v => v.site === 'YouTube');
    if (yt) payload = { trailerUrl: 'https://www.youtube.com/watch?v=' + yt.key };
  } catch { /* Trailer is optional. */ }
  await cachePut(env, key, payload, cfg.cacheTtl);
  return json(payload, 200, cors);
}

// KV-backed cache. KV values use a wrapper to preserve application expiry.
const mem = new Map();
async function cacheGet(env, key) {
  const hit = mem.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  if (hit) mem.delete(key);

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
  const safeTtl = positiveInt(ttl, 1);
  const exp = Date.now() + safeTtl * 1000;
  mem.set(key, { value, exp });

  if (env.CACHE) {
    await env.CACHE.put('cw:' + key, JSON.stringify({ value, exp }), {
      expirationTtl: safeTtl,
    });
  }
}

async function getBackup(env, key) {
  const backup = await cacheGet(env, key);
  if (!backup || !Array.isArray(backup.torrents) || backup.torrents.length === 0) {
    return null;
  }
  return backup;
}

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'CineXZone/1.0' },
  });
  if (!res.ok) {
    throw Object.assign(new Error('Upstream returned ' + res.status), {
      status: 502,
      retryable: res.status === 429 || res.status >= 500,
      cooldown: res.status === 429 || res.status === 530 || res.status >= 500,
      retryAfterSec: parseInt(res.headers.get('Retry-After') || '', 10) || null,
    });
  }
  const body = await res.text();
  try { return JSON.parse(body); }
  catch {
    throw Object.assign(new Error('Upstream returned invalid data'), {
      status: 502, retryable: false,
    });
  }
}

function json(obj, status, extra, more) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
    }, extra || {}, more || {}),
  });
}
