import {
  getMetadataAdapter,
  getTorrentAdapter,
} from './adapters.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = buildCors(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    const cfg = readConfig(env);

    try {
      if (url.pathname === '/api/home' || url.pathname === '/api/latest') {
        return await withLimits(env, cfg, cors, () =>
          handleHome(env, cfg, url, cors));
      }

      if (url.pathname === '/api/movies') {
        return await withLimits(env, cfg, cors, () =>
          handleMovies(env, cfg, url, cors));
      }

      if (url.pathname === '/api/torrents') {
        return await withLimits(env, cfg, cors, () =>
          handleTorrents(env, cfg, url, cors));
      }

      if (url.pathname === '/api/trailer') {
        return await withLimits(env, cfg, cors, () =>
          handleTrailer(env, cfg, url, cors));
      }

      if (url.pathname === '/api/health') {
        return await handleHealth(env, cfg, cors);
      }

      if (!env.ASSETS) {
        return json({
          error: 'Static assets binding ASSETS is not configured',
        }, 500, cors);
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error('Worker error:', e && e.message);
      return json({
        error: e && e.message ? e.message : 'Internal error',
      }, (e && e.status) || 500, cors);
    }
  },
};

// ---------------- CORS ----------------

// ALLOWED_ORIGINS = "" (empty)  -> allow any origin ("*")
// ALLOWED_ORIGINS = "https://a.com,https://b.com" -> only those origins
function buildCors(env, request) {
  const base = {
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!allowed.length) {
    return { ...base, 'Access-Control-Allow-Origin': '*' };
  }

  const origin = request.headers.get('Origin') || '';

  if (allowed.includes(origin)) {
    return {
      ...base,
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
    };
  }

  return { ...base, Vary: 'Origin' };
}

// ---------------- CONFIG ----------------

function readConfig(env) {
  const primaryProvider = env.TORRENT_PROVIDER || 'yts';

  return {
    tmdbApiKey: env.TMDB_API_KEY || '',
    imageBase: env.IMAGE_BASE || 'https://image.tmdb.org/t/p/w500',
    cacheTtl: positiveInt(env.CACHE_TTL, 3600),
    torrentTtl: positiveInt(env.TORRENT_CACHE_TTL, 900),
    homeTtl: positiveInt(
      env.HOME_CACHE_TTL || env.LATEST_CACHE_TTL, 1800
    ),
    rlMax: positiveInt(env.RATE_LIMIT_MAX, 60),
    rlWindow: positiveInt(env.RATE_LIMIT_WINDOW, 60),
    torrentProvider: primaryProvider,
    // Providers that are not configured (jackett/prowlarr without
    // URL + key) are skipped automatically in handleTorrents.
    torrentFallbacks: [...new Set([
      primaryProvider,
      'prowlarr',
      'jackett',
      'tpb',
      'knaben',
      'torrentscsv',
    ])],
    torrentTimeoutMs: positiveInt(env.TORRENT_TIMEOUT_MS, 12000),
    torrentRetries: nonNegativeInt(env.TORRENT_RETRIES, 2),
    retryBaseMs: positiveInt(env.RETRY_BASE_MS, 600),
    cooldownTtl: Math.max(
      60, positiveInt(env.PROVIDER_COOLDOWN_TTL, 60)
    ),
    torrentMinResults: positiveInt(env.TORRENT_MIN_RESULTS, 10),
    torrentBackupTtl: positiveInt(
      env.TORRENT_BACKUP_TTL, 3369600
    ),
    jackettBase: env.JACKETT_BASE_URL || '',
    jackettKey: env.JACKETT_API_KEY || '',
    jackettIndexer: env.JACKETT_INDEXER || 'all',
    prowlarrBase: env.PROWLARR_BASE_URL || '',
    prowlarrKey: env.PROWLARR_API_KEY || '',
    // Home list: how many pages (30 titles each) can be browsed, and the
    // minimum TMDB vote count a title needs (filters out junk entries).
    homeMaxPages: positiveInt(env.HOME_MAX_PAGES, 10),
    homeMinVotes: nonNegativeInt(env.HOME_MIN_VOTES, 5),
    ytsBase: env.YTS_BASE_URL || '',
    // Comma-separated list, e.g. "https://yts.mx,https://yts.bz"
    ytsMirrors: String(env.YTS_MIRRORS || '')
      .split(',').map(s => s.trim()).filter(Boolean),
    tpbBase: env.TPB_BASE_URL || '',
  };
}

function positiveInt(value, fallback) {
  const n = parseInt(
    value == null || value === '' ? String(fallback) : String(value),
    10
  );
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  const n = parseInt(
    value == null || value === '' ? String(fallback) : String(value),
    10
  );
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------- RATE LIMIT ----------------

async function withLimits(env, cfg, cors, fn) {
  if (env.CACHE) {
    const bucket = Math.floor(Date.now() / 1000 / cfg.rlWindow);
    const key = 'rl:global:' + bucket;
    let count = 0;

    try {
      count = (parseInt((await env.CACHE.get(key)) || '0', 10) || 0) + 1;
      await env.CACHE.put(key, String(count), {
        expirationTtl: Math.max(60, cfg.rlWindow),
      });
    } catch {
      // Rate limiting storage is non-fatal.
    }

    if (count > cfg.rlMax) {
      return json({
        error: 'Rate limit exceeded. Please wait a minute.',
      }, 429, cors, { 'Retry-After': String(cfg.rlWindow) });
    }
  }

  return fn();
}

// ---------------- HEALTH ----------------

async function handleHealth(env, cfg, cors) {
  const names = [...new Set(
    cfg.torrentFallbacks.concat(['jackett', 'prowlarr'])
  )];

  const adapters = [];

  for (const name of names) {
    let available = false;
    let configured = true;

    try {
      getTorrentAdapter(name);
      available = true;
    } catch {
      available = false;
    }

    if (name === 'jackett' && !(cfg.jackettBase && cfg.jackettKey)) {
      configured = false;
    }

    if (name === 'prowlarr' && !(cfg.prowlarrBase && cfg.prowlarrKey)) {
      configured = false;
    }

    adapters.push({
      name,
      adapterAvailable: available,
      configured,
      cooldownActive: configured
        ? await isCoolingDown(env, name)
        : false,
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

// ---------------- COOLDOWN / RETRY ----------------

async function isCoolingDown(env, provider) {
  if (!env.CACHE) return false;

  const raw = await env.CACHE.get('cooldown:' + provider);
  if (!raw) return false;

  try {
    return JSON.parse(raw).until > Date.now();
  } catch {
    return false;
  }
}

async function setCooldown(env, provider, ttl, retryAfterSec) {
  if (!env.CACHE) return;

  let seconds = Math.max(60, ttl);

  if (retryAfterSec && Number.isFinite(retryAfterSec) &&
      retryAfterSec > 0) {
    seconds = Math.min(Math.max(retryAfterSec, 60), 900);
  }

  try {
    await env.CACHE.put(
      'cooldown:' + provider,
      JSON.stringify({ until: Date.now() + seconds * 1000 }),
      { expirationTtl: seconds }
    );
  } catch {
    // Non-fatal.
  }
}

async function clearCooldown(env, provider) {
  if (!env.CACHE) return;

  try {
    await env.CACHE.put(
      'cooldown:' + provider,
      JSON.stringify({ until: 0 }),
      { expirationTtl: 60 }
    );
  } catch {
    // Non-fatal.
  }
}

function isRetryableError(e) {
  if (!e) return false;
  if (e.name === 'AbortError' || /timed out/i.test(e.message || '')) {
    return true;
  }
  return e.retryable === true;
}

async function withProviderRetry(env, cfg, providerName, fn) {
  const attempts = Math.max(1, cfg.torrentRetries + 1);
  let lastError = null;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;

      if (!isRetryableError(e) || i === attempts - 1) break;

      await sleep(Math.min(cfg.retryBaseMs * Math.pow(2, i), 4000));
    }
  }

  if (lastError && lastError.cooldown) {
    await setCooldown(
      env, providerName, cfg.cooldownTtl, lastError.retryAfterSec
    );
  }

  throw lastError || new Error('Provider failed');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------- CONTENT TYPE (all / movie / tv) ----------------

const HOME_PAGE_SIZE = 30;   // titles shown per page on the home list
const TMDB_PAGE_SIZE = 20;   // TMDB always returns 20 per page

function parseType(value) {
  const t = String(value || '').toLowerCase();
  return t === 'movie' || t === 'tv' ? t : 'all';
}

function byDateDesc(a, b) {
  return String(b.releaseDate || '').localeCompare(String(a.releaseDate || ''));
}

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

function mapTmdbItem(m, cfg, kind) {
  const isTv = kind === 'tv';
  const date = (isTv ? m.first_air_date : m.release_date) || '';

  return {
    id: String(m.id),
    type: kind,
    title: (isTv ? m.name : m.title) || '',
    year: date.slice(0, 4),
    releaseDate: date,
    overview: m.overview || '',
    poster: m.poster_path ? cfg.imageBase + m.poster_path : null,
    rating: m.vote_average ?? null,
    genres: [],
    genreIds: m.genre_ids || [],
    trailerUrl: null,
    storeUrl: null,
    source: 'TMDB',
  };
}

// ---------------- HOME / LATEST ----------------
// GET /api/home?type=all|movie|tv&page=1
// Newest releases first, 30 titles per page.

async function handleHome(env, cfg, url, cors) {
  const type = parseType(url.searchParams.get('type'));
  const page = Math.min(
    cfg.homeMaxPages,
    Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
  );

  const result = cfg.tmdbApiKey
    ? await tmdbHome(env, cfg, type, page)
    : await itunesHome(env, cfg, type, page);

  const totalPages = Math.max(1, Math.min(
    cfg.homeMaxPages,
    Math.ceil((result.totalResults || 0) / HOME_PAGE_SIZE)
  ));

  return json({
    mode: cfg.tmdbApiKey ? 'tmdb' : 'itunes-keyless',
    type,
    page,
    perPage: HOME_PAGE_SIZE,
    totalPages,
    totalResults: result.totalResults || 0,
    items: result.items,
    source: result.source,
    notice: result.notice || '',
  }, 200, cors);
}

async function tmdbDiscoverPage(env, cfg, kind, tmdbPage) {
  const key = 'home:v2:tmdb:' + kind + ':' + cfg.homeMinVotes + ':' + tmdbPage;
  const cached = await cacheGet(env, key);
  if (cached) return cached;

  const isTv = kind === 'tv';
  const today = new Date().toISOString().slice(0, 10);

  const params = new URLSearchParams({
    api_key: cfg.tmdbApiKey,
    language: 'en-US',
    page: String(tmdbPage),
    include_adult: 'false',
    sort_by: isTv ? 'first_air_date.desc' : 'primary_release_date.desc',
    'vote_count.gte': String(cfg.homeMinVotes),
  });
  params.set(isTv ? 'first_air_date.lte' : 'primary_release_date.lte', today);

  const data = await fetchJSON(
    'https://api.themoviedb.org/3/discover/' + kind + '?' + params.toString()
  );

  const out = {
    items: (data.results || []).map(m => mapTmdbItem(m, cfg, kind)),
    totalResults: Math.min(data.total_results || 0, 10000),
  };

  if (out.items.length) await cachePut(env, key, out, cfg.homeTtl);
  return out;
}

async function tmdbHome(env, cfg, type, page) {
  const errors = [];

  const safe = async (kind, p) => {
    try {
      return await tmdbDiscoverPage(env, cfg, kind, p);
    } catch (e) {
      errors.push(kind + ': ' + (e.message || 'failed'));
      return { items: [], totalResults: 0 };
    }
  };

  let items = [];
  let totalResults = 0;

  if (type !== 'all') {
    const start = (page - 1) * HOME_PAGE_SIZE;
    const end = start + HOME_PAGE_SIZE;
    const first = Math.floor(start / TMDB_PAGE_SIZE) + 1;
    const last = Math.floor((end - 1) / TMDB_PAGE_SIZE) + 1;

    const pages = await Promise.all(range(first, last).map(p => safe(type, p)));
    const offset = start - (first - 1) * TMDB_PAGE_SIZE;

    items = pages.flatMap(p => p.items).slice(offset, offset + HOME_PAGE_SIZE);
    totalResults = Math.max(0, ...pages.map(p => p.totalResults));
  } else {
    // Merge two newest-first lists. The top (30 * page) of the merged list is
    // always inside the top (30 * page) of each source, so fetch that much.
    const lastTmdbPage = Math.ceil((page * HOME_PAGE_SIZE) / TMDB_PAGE_SIZE);
    const nums = range(1, lastTmdbPage);

    const [moviePages, tvPages] = await Promise.all([
      Promise.all(nums.map(p => safe('movie', p))),
      Promise.all(nums.map(p => safe('tv', p))),
    ]);

    const merged = [
      ...moviePages.flatMap(p => p.items),
      ...tvPages.flatMap(p => p.items),
    ].sort(byDateDesc);

    items = merged.slice((page - 1) * HOME_PAGE_SIZE, page * HOME_PAGE_SIZE);
    totalResults =
      Math.max(0, ...moviePages.map(p => p.totalResults)) +
      Math.max(0, ...tvPages.map(p => p.totalResults));
  }

  return {
    items,
    totalResults,
    source: 'tmdb',
    notice: !items.length && errors.length
      ? 'Movie data temporarily unavailable: ' + errors[0]
      : '',
  };
}

// Keyless fallback (no TMDB key): Apple's top charts, newest first.
async function itunesHome(env, cfg, type, page) {
  const kinds = type === 'all' ? ['movie', 'tv'] : [type];
  const errors = [];

  const lists = await Promise.all(kinds.map(async kind => {
    const key = 'home:v2:itunes:' + kind;
    let cached = await cacheGet(env, key);
    if (cached) return cached;

    try {
      const feed = kind === 'tv' ? 'toptvseasons' : 'topmovies';
      const data = await fetchJSON(
        'https://itunes.apple.com/us/rss/' + feed + '/limit=50/json'
      );

      const entries = (((data || {}).feed || {}).entry || []);
      const seen = new Set();

      const items = (Array.isArray(entries) ? entries : [entries])
        .map(e => {
          const rawName = e['im:name'] ? e['im:name'].label : '';
          const title = kind === 'tv'
            ? rawName.replace(/\s*[,\-–:]?\s*(Season|Series)\s*\d+.*$/i, '').trim()
            : rawName;
          const releaseDate = e['im:releaseDate']
            ? (e['im:releaseDate'].label || '')
            : '';

          return {
            id: e.id && e.id.attributes
              ? e.id.attributes['im:id']
              : (e.id && e.id.label) || '',
            type: kind,
            title,
            year: releaseDate.slice(0, 4),
            releaseDate,
            overview: e.summary ? e.summary.label : '',
            poster: e['im:image']
              ? e['im:image'][e['im:image'].length - 1].label
              : null,
            rating: null,
            genres: e.category
              ? [e.category.attributes?.label || '']
              : [],
            genreIds: [],
            trailerUrl: null,
            storeUrl: null,
            source: 'iTunes',
          };
        })
        .filter(m => {
          if (!m.title || seen.has(m.title.toLowerCase())) return false;
          seen.add(m.title.toLowerCase());
          return true;
        });

      cached = { items };
      if (items.length) await cachePut(env, key, cached, cfg.homeTtl);
      return cached;
    } catch (e) {
      errors.push(kind + ': ' + (e.message || 'failed'));
      return { items: [] };
    }
  }));

  const all = lists.flatMap(l => l.items).sort(byDateDesc);
  const start = (page - 1) * HOME_PAGE_SIZE;

  return {
    items: all.slice(start, start + HOME_PAGE_SIZE),
    totalResults: all.length,
    source: 'itunes-keyless',
    notice: !all.length && errors.length
      ? 'Movie data temporarily unavailable: ' + errors[0]
      : '',
  };
}

// ---------------- SEARCH (movies / tv / all) ----------------
// GET /api/movies?q=...&page=1&type=all|movie|tv

async function handleMovies(env, cfg, url, cors) {
  const q = (url.searchParams.get('q') || '').trim();
  const type = parseType(url.searchParams.get('type'));
  const page = Math.max(
    1, parseInt(url.searchParams.get('page') || '1', 10) || 1
  );

  if (!q) return json({ error: 'Missing search query' }, 400, cors);
  if (q.length > 100) return json({ error: 'Query too long' }, 400, cors);

  const provider = cfg.tmdbApiKey ? 'tmdb' : 'itunes';
  const adapter = getMetadataAdapter(provider);

  const key = 'movies:v2:' + provider + ':' + type + ':' + q.toLowerCase() +
    (provider === 'tmdb' ? ':' + page : '');

  let payload = await cacheGet(env, key);

  if (!payload) {
    payload = await adapter.search(cfg, q, page, type);
    await cachePut(env, key, payload, cfg.cacheTtl);
  }

  if (provider === 'tmdb') return json(payload, 200, cors);

  const perPage = payload.perPage || 20;
  const start = (page - 1) * perPage;

  return json({
    page,
    perPage,
    totalPages: payload.totalPages || 1,
    totalResults: payload.totalResults,
    results: (payload.results || []).slice(start, start + perPage),
    source: payload.source,
  }, 200, cors);
}

// ---------------- TORRENT SEARCH ----------------

async function handleTorrents(env, cfg, url, cors) {
  const q = (url.searchParams.get('q') || '').trim();
  const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
  const year = type === 'tv'
    ? 0
    : (parseInt(url.searchParams.get('year') || '0', 10) || 0);
  const kp = type === 'tv' ? 'tv:' : '';

  if (!q) return json({ error: 'Missing query' }, 400, cors);
  if (q.length > 200) return json({ error: 'Query too long' }, 400, cors);

  const normTitle = normalizeTitle(q);
  const key = 'torrents:multi:' + kp + normTitle + ':' + year;
  const cached = await cacheGet(env, key);

  if (cached) return json(cached, 200, cors);

  const errors = [];
  const merged = [];
  const usedProviders = [];

  for (const providerName of cfg.torrentFallbacks) {
    if (merged.length >= cfg.torrentMinResults) break;

    let adapter;
    try {
      adapter = getTorrentAdapter(providerName);
    } catch {
      continue;
    }

    // Skip providers that are not configured (no error noise).
    // YTS only carries movies.
    if (type === 'tv' && providerName === 'yts') continue;

    if (providerName === 'jackett' &&
        !(cfg.jackettBase && cfg.jackettKey)) continue;

    if (providerName === 'prowlarr' &&
        !(cfg.prowlarrBase && cfg.prowlarrKey)) continue;

    if (await isCoolingDown(env, providerName)) {
      errors.push(providerName + ': cooling down after a recent failure');
      continue;
    }

    try {
      const data = await withProviderRetry(env, cfg, providerName, () =>
        withTimeout(
          adapter.search(cfg, q, 1, { type }),
          cfg.torrentTimeoutMs
        )
      );

      const items = data && Array.isArray(data.torrents)
        ? data.torrents
        : [];

      if (items.length) {
        merged.push(...items);
        usedProviders.push(providerName);

        await clearCooldown(env, providerName);

        if (merged.length >= cfg.torrentMinResults) break;
        continue;
      }

      if (!usedProviders.includes(providerName)) {
        usedProviders.push(providerName);
      }

      errors.push(providerName + ': no results');
    } catch (e) {
      errors.push(providerName + ': ' + (e.message || 'failed'));
    }
  }

  const backupKey = 'torrents:backup:' + kp + normTitle + ':' + year;

  if (!merged.length) {
    const backup = await getBackup(env, backupKey);

    if (backup) {
      return json({
        ...backup,
        stale: true,
        providerError:
          'Current torrent providers did not return results; showing saved backup.' +
          (errors.length ? ' Details: ' + errors.join(' | ') : ''),
      }, 200, cors);
    }

    const empty = {
      query: q,
      year,
      torrents: [],
      totalResults: 0,
      provider: cfg.torrentProvider,
      providerError: 'Torrent index temporarily unavailable (' +
        (errors.join(' | ') || 'no response') + ')',
    };

    await cachePut(env, key, empty, 120);
    return json(empty, 200, cors);
  }

  const seen = new Set();

  const torrents = merged.filter(t => {
    const title = String(t.title || '');
    const hash = String(t.infoHash || '').toLowerCase();

    const uniqueKey = hash ||
      (
        title.toLowerCase().replace(/\W+/g, '') +
        '|' + (t.sizeBytes || t.size || '')
      ).toLowerCase();

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

  if (!torrents.length) {
    const backup = await getBackup(env, backupKey);

    if (backup) {
      return json({
        ...backup,
        stale: true,
        providerError:
          'Current results were unusable after filtering; showing saved backup.',
      }, 200, cors);
    }
  }

  const payload = {
    query: q,
    year,
    torrents,
    totalResults: torrents.length,
    provider: usedProviders.join('+') || cfg.torrentProvider,
  };

  if (!torrents.length && errors.length) {
    payload.providerError =
      'Torrent index temporarily unavailable (' + errors.join(' | ') + ')';
  }

  if (torrents.length) {
    const backupPayload = {
      query: q,
      year,
      torrents,
      totalResults: torrents.length,
      provider: payload.provider,
      savedAt: new Date().toISOString(),
    };

    await cachePut(env, backupKey, backupPayload, cfg.torrentBackupTtl);
  }

  await cachePut(
    env,
    key,
    payload,
    payload.providerError ? 120 : cfg.torrentTtl
  );

  return json(payload, 200, cors);
}

function normalizeTitle(value) {
  return String(value || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

// ---------------- TRAILERS ----------------

async function handleTrailer(env, cfg, url, cors) {
  if (!cfg.tmdbApiKey) {
    return json({ trailerUrl: null }, 200, cors);
  }

  const id = (url.searchParams.get('id') || '').trim();

  if (!/^\d+$/.test(id)) {
    return json({ trailerUrl: null }, 200, cors);
  }

  const kind = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
  const key = 'trailer:' + (kind === 'tv' ? 'tv:' : '') + id;
  const cached = await cacheGet(env, key);

  if (cached) return json(cached, 200, cors);

  let payload = { trailerUrl: null };

  try {
    const data = await fetchJSON(
      'https://api.themoviedb.org/3/' + kind + '/' + id +
      '/videos?api_key=' + encodeURIComponent(cfg.tmdbApiKey) +
      '&language=en-US'
    );

    const vids = data.results || [];

    const yt = vids.find(v =>
      v.site === 'YouTube' && v.type === 'Trailer' && v.official
    ) || vids.find(v =>
      v.site === 'YouTube' && v.type === 'Trailer'
    ) || vids.find(v => v.site === 'YouTube');

    if (yt) {
      payload = {
        trailerUrl: 'https://www.youtube.com/watch?v=' + yt.key,
      };
    }
  } catch {
    // Trailer is optional.
  }

  await cachePut(env, key, payload, cfg.cacheTtl);
  return json(payload, 200, cors);
}

// ---------------- CACHE ----------------

const mem = new Map();

async function cacheGet(env, key) {
  const hit = mem.get(key);

  if (hit && hit.exp > Date.now()) return hit.value;
  if (hit) mem.delete(key);

  if (env.CACHE) {
    try {
      const raw = await env.CACHE.get('cw:' + key, 'json');

      if (raw && raw.exp > Date.now()) {
        mem.set(key, { value: raw.value, exp: raw.exp });
        return raw.value;
      }
    } catch (e) {
      console.error('KV get failed:', e && e.message);
    }
  }

  return null;
}

async function cachePut(env, key, value, ttl) {
  const safeTtl = Math.max(60, positiveInt(ttl, 60));
  const exp = Date.now() + safeTtl * 1000;

  mem.set(key, { value, exp });

  if (env.CACHE) {
    try {
      await env.CACHE.put(
        'cw:' + key,
        JSON.stringify({ value, exp }),
        { expirationTtl: safeTtl }
      );
    } catch (e) {
      console.error(
        'KV put failed (memory cache still holds value):',
        e && e.message
      );
    }
  }
}

async function getBackup(env, key) {
  const backup = await cacheGet(env, key);

  if (!backup || !Array.isArray(backup.torrents) ||
      backup.torrents.length === 0) {
    return null;
  }

  return backup;
}

// ---------------- FETCH HELPERS ----------------

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
  });

  if (!res.ok) {
    throw Object.assign(
      new Error('Upstream returned ' + res.status),
      {
        status: 502,
        retryable: res.status === 429 || res.status >= 500,
        cooldown: res.status === 429 ||
          res.status === 530 ||
          res.status >= 500,
        retryAfterSec:
          parseInt(res.headers.get('Retry-After') || '', 10) || null,
      }
    );
  }

  const body = await res.text();

  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(
      new Error('Upstream returned invalid data'),
      { status: 502, retryable: false }
    );
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
