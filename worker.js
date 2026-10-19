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
      // Homepage and latest movies
      if (
        url.pathname === '/api/home' ||
        url.pathname === '/api/latest'
      ) {
        return await withLimits(
          env, cfg, cors,
          () => handleHome(env, cfg, cors)
        );
      }

      // Movie search
      if (url.pathname === '/api/movies') {
        return await withLimits(
          env, cfg, cors,
          () => handleMovies(env, cfg, url, cors)
        );
      }

      // Torrent search
      if (url.pathname === '/api/torrents') {
        return await withLimits(
          env, cfg, cors,
          () => handleTorrents(env, cfg, url, cors)
        );
      }

      // Movie trailer
      if (url.pathname === '/api/trailer') {
        return await withLimits(
          env, cfg, cors,
          () => handleTrailer(env, cfg, url, cors)
        );
      }

      // Health check
      if (url.pathname === '/api/health') {
        return await handleHealth(env, cfg, cors);
      }

      // Serve the existing website and static assets
      return env.ASSETS.fetch(request);

    } catch (e) {
      console.error(
        'Worker error:',
        e && e.message
      );

      return json({
        error: e.message || 'Internal error',
      }, e.status || 500, cors);
    }
  },
};

// ================= Configuration =================

function readConfig(env) {
  const primaryProvider =
    env.TORRENT_PROVIDER || 'yts';

  return {
    tmdbApiKey: env.TMDB_API_KEY || '',

    imageBase:
      env.IMAGE_BASE ||
      'https://image.tmdb.org/t/p/w500',

    cacheTtl: parseInt(
      env.CACHE_TTL || '3600', 10
    ),

    torrentTtl: parseInt(
      env.TORRENT_CACHE_TTL || '900', 10
    ),

    homeTtl: parseInt(
      env.HOME_CACHE_TTL ||
      env.LATEST_CACHE_TTL ||
      '1800', 10
    ),

    rlMax: parseInt(
      env.RATE_LIMIT_MAX || '60', 10
    ),

    rlWindow: parseInt(
      env.RATE_LIMIT_WINDOW || '60', 10
    ),

    torrentProvider: primaryProvider,

    // Keyless fallback chain, tried in order after the
    // primary provider. tpb and torrentscsv need no keys.
    torrentFallbacks: [
      primaryProvider,
      'tpb',
      'torrentscsv',
    ],

    torrentTimeoutMs: parseInt(
      env.TORRENT_TIMEOUT_MS || '12000', 10
    ),

    // Retry/backoff/cooldown tuning.
    torrentRetries: parseInt(
      env.TORRENT_RETRIES || '2', 10
    ),

    retryBaseMs: parseInt(
      env.RETRY_BASE_MS || '600', 10
    ),

    cooldownTtl: parseInt(
      env.PROVIDER_COOLDOWN_TTL || '300', 10
    ),

    // Stop trying further providers once this many merged
    // results have been collected (limits upstream calls).
    torrentMinResults: parseInt(
      env.TORRENT_MIN_RESULTS || '10', 10
    ),

    // Last-known-good backup lifetime.
    torrentBackupTtl: parseInt(
      env.TORRENT_BACKUP_TTL || '604800', 10
    ),

    jackettBase:
      env.JACKETT_BASE_URL || '',

    jackettKey:
      env.JACKETT_API_KEY || '',

    jackettIndexer:
      env.JACKETT_INDEXER || 'all',

    prowlarrBase:
      env.PROWLARR_BASE_URL || '',

    prowlarrKey:
      env.PROWLARR_API_KEY || '',
  };
}

// ================= Rate limiting =================

async function withLimits(env, cfg, cors, fn) {
  if (env.CACHE) {
    const bucket = Math.floor(
      Date.now() / 1000 / cfg.rlWindow
    );

    const key = 'rl:global:' + bucket;

    const count =
      parseInt(
        (await env.CACHE.get(key)) || '0',
        10
      ) + 1;

    await env.CACHE.put(
      key,
      String(count),
      { expirationTtl: cfg.rlWindow }
    );

    if (count > cfg.rlMax) {
      return json({
        error:
          'Rate limit exceeded. Please wait a minute.',
      }, 429, cors, {
        'Retry-After': String(cfg.rlWindow),
      });
    }
  }

  return fn();
}

// ================= Health check =================

async function handleHealth(env, cfg, cors) {
  const adapters = [];
  const cooldowns = {};

  for (const name of cfg.torrentFallbacks.concat(
    ['jackett', 'prowlarr']
  )) {
    if (adapters.some(a => a.name === name)) {
      continue;
    }

    let available = false;
    let configured = true;

    try {
      getTorrentAdapter(name);
      available = true;
    } catch {
      available = false;
    }

    if (
      name === 'jackett' &&
      !(cfg.jackettBase && cfg.jackettKey)
    ) {
      configured = false;
    }

    if (
      name === 'prowlarr' &&
      !(cfg.prowlarrBase && cfg.prowlarrKey)
    ) {
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
    homepageMode: cfg.tmdbApiKey
      ? 'tmdb'
      : 'itunes-keyless',
    kvBound: !!env.CACHE,
    torrentProvider: cfg.torrentProvider,
    torrentFallbacks: cfg.torrentFallbacks,
    torrentTimeoutMs: cfg.torrentTimeoutMs,
    torrentRetries: cfg.torrentRetries,
    torrentBackupTtl: cfg.torrentBackupTtl,
    adapters,
    jackettConfigured: !!(
      cfg.jackettBase && cfg.jackettKey
    ),
    prowlarrConfigured: !!(
      cfg.prowlarrBase && cfg.prowlarrKey
    ),
  }, 200, cors);
}

// ================= Provider cooldown =================

async function isCoolingDown(env, provider) {
  if (!env.CACHE) {
    return false;
  }

  const raw = await env.CACHE.get(
    'cooldown:' + provider
  );

  if (!raw) {
    return false;
  }

  try {
    return JSON.parse(raw).until > Date.now();
  } catch {
    return false;
  }
}

async function setCooldown(env, provider, ttl, retryAfterSec) {
  if (!env.CACHE) {
    return;
  }

  // Honor Retry-After when the upstream supplied one,
  // capped so a hostile/broken header cannot freeze us.
  let seconds = ttl;

  if (
    retryAfterSec &&
    Number.isFinite(retryAfterSec) &&
    retryAfterSec > 0
  ) {
    seconds = Math.min(
      Math.max(retryAfterSec, ttl),
      900
    );
  }

  await env.CACHE.put(
    'cooldown:' + provider,
    JSON.stringify({
      until: Date.now() + seconds * 1000,
    }),
    { expirationTtl: seconds }
  );
}

async function clearCooldown(env, provider) {
  if (!env.CACHE) {
    return;
  }

  // KV has no delete via the cachePut helper; store a
  // short-lived "clear" marker that isCoolingDown treats
  // as not-cooling.
  await env.CACHE.put(
    'cooldown:' + provider,
    JSON.stringify({ until: 0 }),
    { expirationTtl: 60 }
  );
}

// ================= Retry with backoff =================

function isRetryableError(e) {
  if (!e) {
    return false;
  }

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

      if (!isRetryableError(e) || i === attempts - 1) {
        break;
      }

      // Exponential backoff: base * 2^i, capped at 4s.
      const delay = Math.min(
        cfg.retryBaseMs * Math.pow(2, i),
        4000
      );

      await sleep(delay);
    }
  }

  // 429/530/5xx: put the provider on cooldown so subsequent
  // searches skip it for a while instead of hammering it.
  if (lastError && lastError.cooldown) {
    await setCooldown(
      env,
      providerName,
      cfg.cooldownTtl,
      lastError.retryAfterSec
    );
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ================= Homepage =================

async function handleHome(env, cfg, cors) {
  if (cfg.tmdbApiKey) {
    const [latest, popular] = await Promise.all([
      tmdbSection(
        env, cfg, 'now_playing', cfg.homeTtl
      ),
      tmdbSection(
        env, cfg, 'popular', cfg.homeTtl
      ),
    ]);

    return json({
      mode: 'tmdb',
      latest: latest.movies,
      latestSource: latest.source,
      popular: popular.movies,
      popularSource: popular.source,
    }, 200, cors);
  }

  const key = 'home:itunes';
  let cached = await cacheGet(env, key);

  if (!cached) {
    try {
      const data = await fetchJSON(
        'https://itunes.apple.com/us/rss/topmovies/limit=50/json'
      );

      const entries =
        (((data || {}).feed || {}).entry || []);

      const movies = (
        Array.isArray(entries)
          ? entries
          : [entries]
      ).map(e => ({
        id: e.id && e.id.attributes
          ? e.id.attributes['im:id']
          : (e.id && e.id.label) || '',

        title: e['im:name']
          ? e['im:name'].label
          : '',

        year: e['im:releaseDate']
          ? (
              e['im:releaseDate'].label || ''
            ).slice(0, 4)
          : '',

        releaseDate: e['im:releaseDate']
          ? e['im:releaseDate'].label
          : '',

        overview: e.summary
          ? e.summary.label
          : '',

        poster: e['im:image']
          ? e['im:image'][
              e['im:image'].length - 1
            ].label
          : null,

        rating: null,

        genres: e.category
          ? [
              e.category.attributes?.label || ''
            ]
          : [],

        genreIds: [],
        trailerUrl: null,
        storeUrl: null,
        source: 'iTunes',
      })).filter(m => m.title);

      cached = {
        movies,
        source: 'itunes-keyless',
      };

      await cachePut(
        env, key, cached, cfg.homeTtl
      );

    } catch (e) {
      cached = {
        movies: [],
        source: 'itunes-keyless',
        error: e.message,
      };
    }
  }

  return json({
    mode: 'itunes-keyless',
    latest: cached.movies || [],
    latestSource:
      cached.source || 'itunes-keyless',
    popular: [],
    popularSource: '',
    notice: cached.error
      ? 'Movie data temporarily unavailable: ' +
        cached.error
      : 'The homepage is using the Apple movie feed.',
  }, 200, cors);
}

async function tmdbSection(
  env, cfg, section, ttl
) {
  const key = 'home:tmdb:' + section;
  const cached = await cacheGet(env, key);

  if (cached) {
    return {
      movies: cached,
      source: 'tmdb (cache)',
    };
  }

  try {
    const data = await fetchJSON(
      'https://api.themoviedb.org/3/movie/' +
      section +
      '?api_key=' +
      encodeURIComponent(cfg.tmdbApiKey) +
      '&language=en-US&page=1'
    );

    const movies = (data.results || []).map(m => ({
      id: String(m.id),
      title: m.title,
      year: (m.release_date || '').slice(0, 4),
      releaseDate: m.release_date || '',
      overview: m.overview || '',

      poster: m.poster_path
        ? cfg.imageBase + m.poster_path
        : null,

      rating: m.vote_average,
      genres: [],
      genreIds: m.genre_ids || [],
      trailerUrl: null,
      storeUrl: null,
      source: 'TMDB',
    }));

    if (movies.length) {
      await cachePut(env, key, movies, ttl);
    }

    return {
      movies,
      source: 'tmdb',
    };

  } catch (e) {
    return {
      movies: [],
      source: 'tmdb (' + e.message + ')',
    };
  }
}

// ================= Movie search =================

async function handleMovies(env, cfg, url, cors) {
  const q = (
    url.searchParams.get('q') || ''
  ).trim();

  const page = Math.max(
    1,
    parseInt(
      url.searchParams.get('page') || '1', 10
    )
  );

  if (!q) {
    return json(
      { error: 'Missing search query' },
      400, cors
    );
  }

  if (q.length > 100) {
    return json(
      { error: 'Query too long' },
      400, cors
    );
  }

  const provider = cfg.tmdbApiKey
    ? 'tmdb'
    : 'itunes';

  const adapter = getMetadataAdapter(provider);

  const key =
    'movies:' + provider + ':' +
    q.toLowerCase() +
    (provider === 'tmdb' ? ':' + page : '');

  let payload = await cacheGet(env, key);

  if (!payload) {
    payload = await adapter.search(
      cfg, q, page
    );

    await cachePut(
      env, key, payload, cfg.cacheTtl
    );
  }

  if (provider === 'tmdb') {
    return json(payload, 200, cors);
  }

  const perPage = payload.perPage || 20;
  const start = (page - 1) * perPage;

  return json({
    page,
    perPage,
    totalPages: payload.totalPages || 1,
    totalResults: payload.totalResults,
    results: (payload.results || []).slice(
      start, start + perPage
    ),
    source: payload.source,
  }, 200, cors);
}

// ================= Torrent search =================

async function handleTorrents(env, cfg, url, cors) {
  const q = (
    url.searchParams.get('q') || ''
  ).trim();

  const year = parseInt(
    url.searchParams.get('year') || '0',
    10
  ) || 0;

  if (!q) {
    return json(
      { error: 'Missing query' },
      400, cors
    );
  }

  if (q.length > 200) {
    return json(
      { error: 'Query too long' },
      400, cors
    );
  }

  const normTitle = normalizeTitle(q);

  // Cache key is provider-independent: results are the same
  // regardless of which provider in the chain supplied them.
  const key =
    'torrents:multi:' + normTitle + ':' + year;

  const cached = await cacheGet(env, key);

  if (cached) {
    return json(cached, 200, cors);
  }

  // Fallback chain with per-provider retry/backoff and
  // cooldowns. Successful providers are aggregated until
  // enough results are collected; providers that returned
  // usable results continue to the next only when the
  // merged total is still below torrentMinResults.
  const errors = [];
  const merged = [];
  const usedProviders = [];

  for (const providerName of cfg.torrentFallbacks) {
    if (merged.length >= cfg.torrentMinResults) {
      break;
    }

    let adapter;

    try {
      adapter = getTorrentAdapter(providerName);
    } catch {
      continue;
    }

    // Jackett/Prowlarr need configuration; skip silently so
    // the keyless fallbacks still get a chance.
    if (
      providerName === 'jackett' &&
      !(cfg.jackettBase && cfg.jackettKey)
    ) {
      continue;
    }

    if (
      providerName === 'prowlarr' &&
      !(cfg.prowlarrBase && cfg.prowlarrKey)
    ) {
      continue;
    }

    // Skip providers that recently returned 429/530/5xx.
    if (await isCoolingDown(env, providerName)) {
      errors.push(
        providerName + ': cooling down after a recent failure'
      );
      continue;
    }

    try {
      const data = await withProviderRetry(
        env, cfg, providerName,
        () => withTimeout(
          adapter.search(cfg, q, 1),
          cfg.torrentTimeoutMs
        )
      );

      const torrents = (
        data && Array.isArray(data.torrents)
      ) ? data.torrents : [];

      if (torrents.length) {
        merged.push(...torrents);
        usedProviders.push(providerName);

        // Provider succeeded - clear any stale cooldown.
        await clearCooldown(env, providerName);

        if (merged.length >= cfg.torrentMinResults) {
          break;
        }

        continue;
      }

      // Provider responded but had no results. Do not put it
      // on cooldown - an empty result is a valid response.
      if (!usedProviders.includes(providerName)) {
        usedProviders.push(providerName);
      }

      errors.push(
        providerName + ': no results'
      );

    } catch (e) {
      errors.push(
        providerName + ': ' + (e.message || 'failed')
      );
    }
  }

  // Nothing usable from any provider - fall back to the
  // last known good result for this query before
  // reporting an error.
  if (!merged.length) {
    const backup = await cacheGet(
      env,
      'torrents:backup:' + normTitle + ':' + year
    );

    if (
      backup &&
      Array.isArray(backup.torrents) &&
      backup.torrents.length
    ) {
      return json({
        ...backup,
        stale: true,
        providerError:
          'Torrent index temporarily unavailable (' +
          (errors.join(' | ') || 'no response') +
          ') - showing cached results',
      }, 200, cors);
    }

    const payload = {
      query: q,
      year,
      torrents: [],
      totalResults: 0,
      provider: cfg.torrentProvider,
      providerError:
        'Torrent index temporarily unavailable (' +
        (errors.join(' | ') || 'no response') +
        ')',
    };

    // Keep temporary errors cached only briefly, and only
    // when there is no backup to preserve.
    await cachePut(env, key, payload, 120);

    return json(payload, 200, cors);
  }

  // Remove duplicates and match the movie title/year.
  const seen = new Set();

  const torrents = merged.filter(t => {
    const title = String(t.title || '');

    const hash = String(t.infoHash || '').toLowerCase();

    const uniqueKey = hash ||
      (
        title.toLowerCase().replace(/\W+/g, '') +
        '|' + (t.sizeBytes || t.size || '')
      ).toLowerCase();

    if (seen.has(uniqueKey)) {
      return false;
    }

    seen.add(uniqueKey);

    // Require the normalized movie title to match. When the
    // title cannot be matched, keep the entry only if the
    // provider was explicit about the movie (same source
    // result set); otherwise drop it.
    if (
      normTitle &&
      !normalizedContains(title, normTitle)
    ) {
      return false;
    }

    // Allow a one-year difference for international releases.
    if (year) {
      const releaseYear = extractYear(title);

      if (
        releaseYear &&
        Math.abs(releaseYear - year) > 1
      ) {
        return false;
      }
    }

    // Never expose a magnet that the provider did not supply
    // or that could not be built from a valid info hash.
    if (
      !t.magnet &&
      !t.torrentUrl
    ) {
      return false;
    }

    return true;
  });

  // Sort by quality first, then by seeders.
  torrents.sort((a, b) =>
    qualityRank(b.resolution) -
      qualityRank(a.resolution) ||
    ((b.seeds || 0) - (a.seeds || 0))
  );

  const payload = {
    query: q,
    year,
    torrents,
    totalResults: torrents.length,
    provider: usedProviders.join('+') ||
      cfg.torrentProvider,
  };

  if (
    !torrents.length &&
    errors.length
  ) {
    payload.providerError =
      'Torrent index temporarily unavailable (' +
      errors.join(' | ') +
      ')';
  }

  // Save a long-lived backup so transient upstream failures
  // (530/429/timeouts) can still serve the last good results.
  if (torrents.length) {
    await cachePut(
      env,
      'torrents:backup:' + normTitle + ':' + year,
      {
        query: q,
        year,
        torrents,
        totalResults: torrents.length,
        provider: payload.provider,
      },
      cfg.torrentBackupTtl
    );
  }

  await cachePut(
    env, key, payload,
    payload.providerError ? 120 : cfg.torrentTtl
  );

  return json(payload, 200, cors);
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedContains(haystack, needle) {
  return normalizeTitle(haystack)
    .includes(needle);
}

function extractYear(title) {
  const match = /\b(19\d{2}|20\d{2})\b/
    .exec(String(title || ''));

  return match
    ? parseInt(match[1], 10)
    : 0;
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
      timer = setTimeout(
        () => reject(
          Object.assign(
            new Error(
              'Timed out after ' + (ms / 1000) + 's'
            ),
            { retryable: true }
          )
        ),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// ================= Movie trailer =================

async function handleTrailer(env, cfg, url, cors) {
  if (!cfg.tmdbApiKey) {
    return json(
      { trailerUrl: null },
      200, cors
    );
  }

  const id = (
    url.searchParams.get('id') || ''
  ).trim();

  if (!/^\d+$/.test(id)) {
    return json(
      { trailerUrl: null },
      200, cors
    );
  }

  const key = 'trailer:' + id;
  const cached = await cacheGet(env, key);

  if (cached) {
    return json(cached, 200, cors);
  }

  let payload = { trailerUrl: null };

  try {
    const data = await fetchJSON(
      'https://api.themoviedb.org/3/movie/' +
      id + '/videos?api_key=' +
      encodeURIComponent(cfg.tmdbApiKey) +
      '&language=en-US'
    );

    const vids = data.results || [];

    const yt =
      vids.find(v =>
        v.site === 'YouTube' &&
        v.type === 'Trailer' &&
        v.official
      ) ||
      vids.find(v =>
        v.site === 'YouTube' &&
        v.type === 'Trailer'
      ) ||
      vids.find(v =>
        v.site === 'YouTube'
      );

    if (yt) {
      payload = {
        trailerUrl:
          'https://www.youtube.com/watch?v=' +
          yt.key,
      };
    }

  } catch (e) {
    // Trailer is optional.
  }

  await cachePut(
    env, key, payload, cfg.cacheTtl
  );

  return json(payload, 200, cors);
}

// ================= KV caching =================

const mem = new Map();

async function cacheGet(env, key) {
  const hit = mem.get(key);

  if (hit && hit.exp > Date.now()) {
    return hit.value;
  }

  if (env.CACHE) {
    const raw = await env.CACHE.get(
      'cw:' + key,
      'json'
    );

    if (raw && raw.exp > Date.now()) {
      mem.set(key, {
        value: raw.value,
        exp: raw.exp,
      });

      return raw.value;
    }
  }

  return null;
}

async function cachePut(env, key, value, ttl) {
  const exp = Date.now() + ttl * 1000;

  mem.set(key, {
    value,
    exp,
  });

  if (env.CACHE) {
    await env.CACHE.put(
      'cw:' + key,
      JSON.stringify({
        value,
        exp,
      }),
      { expirationTtl: ttl }
    );
  }
}

// ================= JSON fetch helper =================

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CineXZone/1.0',
    },
  });

  if (!res.ok) {
    throw Object.assign(
      new Error(
        'Upstream returned ' + res.status
      ),
      {
        status: 502,
        // 429 and 5xx are transient; 4xx are not.
        retryable:
          res.status === 429 ||
          res.status >= 500,
        cooldown:
          res.status === 429 ||
          res.status === 530 ||
          res.status >= 500,
        retryAfterSec:
          parseInt(
            res.headers.get('Retry-After') || '',
            10
          ) || null,
      }
    );
  }

  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch (e) {
    throw Object.assign(
      new Error('Upstream returned invalid data'),
      { status: 502, retryable: false }
    );
  }
}

// ================= JSON response helper =================

function json(obj, status, extra, more) {
  return new Response(
    JSON.stringify(obj),
    {
      status: status || 200,
      headers: Object.assign(
        {
          'Content-Type':
            'application/json; charset=utf-8',
        },
        extra || {},
        more || {}
      ),
    }
  );
}
