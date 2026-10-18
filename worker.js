
import { getMetadataAdapter, getTorrentAdapter } from './adapters.js';

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
      // Homepage movie data
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
        return json({
          ok: true,
          tmdbKeyPresent: !!env.TMDB_API_KEY,
          homepageMode: cfg.tmdbApiKey
            ? 'tmdb'
            : 'itunes-keyless',
          kvBound: !!env.CACHE,
          torrentProvider: cfg.torrentProvider,
        }, 200, cors);
      }

      // Serve the website's static assets and homepage
      return env.ASSETS.fetch(request);

    } catch (e) {
      console.error('Worker error:', e && e.message);
      return json({
        error: e.message || 'Internal error',
      }, e.status || 500, cors);
    }
  },
};

function readConfig(env) {
  return {
    tmdbApiKey: env.TMDB_API_KEY || '',
    imageBase:
      env.IMAGE_BASE ||
      'https://image.tmdb.org/t/p/w500',
    cacheTtl: parseInt(env.CACHE_TTL || '3600', 10),
    torrentTtl: parseInt(
      env.TORRENT_CACHE_TTL || '900', 10
    ),
    homeTtl: parseInt(
      env.HOME_CACHE_TTL || '1800', 10
    ),
    rlMax: parseInt(env.RATE_LIMIT_MAX || '60', 10),
    rlWindow: parseInt(
      env.RATE_LIMIT_WINDOW || '60', 10
    ),
    torrentProvider: env.TORRENT_PROVIDER || 'yts',
  };
}

async function withLimits(env, cfg, cors, fn) {
  if (env.CACHE) {
    const bucket = Math.floor(
      Date.now() / 1000 / cfg.rlWindow
    );
    const key = 'rl:global:' + bucket;
    const count = parseInt(
      (await env.CACHE.get(key)) || '0', 10
    ) + 1;

    await env.CACHE.put(key, String(count), {
      expirationTtl: cfg.rlWindow,
    });

    if (count > cfg.rlMax) {
      return json({
        error: 'Rate limit exceeded. Please wait a minute.',
      }, 429, cors, {
        'Retry-After': String(cfg.rlWindow),
      });
    }
  }

  return fn();
}

// Homepage: TMDB now-playing + popular.
// Without a TMDB key, use Apple's public movie RSS feed.
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

      const entries = (
        (data || {}).feed || {}
      ).entry || [];

      const movies = (
        Array.isArray(entries) ? entries : [entries]
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
    latestSource: cached.source || 'itunes-keyless',
    popular: [],
    popularSource: '',
    notice: cached.error
      ? 'Movie data temporarily unavailable: ' +
        cached.error
      : 'The homepage is using the Apple movie feed.',
  }, 200, cors);
}

async function tmdbSection(env, cfg, section, ttl) {
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

// Movie search
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
      400,
      cors
    );
  }

  if (q.length > 100) {
    return json(
      { error: 'Query too long' },
      400,
      cors
    );
  }

  const provider = cfg.tmdbApiKey
    ? 'tmdb'
    : 'itunes';

  const adapter = getMetadataAdapter(provider);

  const key = 'movies:' + provider + ':' +
    q.toLowerCase() +
    (provider === 'tmdb' ? ':' + page : '');

  let payload = await cacheGet(env, key);

  if (!payload) {
    payload = await adapter.search(cfg, q, page);
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

// Torrent search
async function handleTorrents(env, cfg, url, cors) {
  const q = (
    url.searchParams.get('q') || ''
  ).trim();

  const year = url.searchParams.get('year') || '';

  if (!q) {
    return json(
      { error: 'Missing query' },
      400,
      cors
    );
  }

  const query = year ? q + ' ' + year : q;

  const key = 'torrents:' +
    cfg.torrentProvider + ':' +
    query.toLowerCase();

  const cached = await cacheGet(env, key);

  if (cached) {
    return json(cached, 200, cors);
  }

  try {
    const adapter = getTorrentAdapter(
      cfg.torrentProvider
    );

    const data = await adapter.search(
      cfg, query, 1
    );

    const seen = new Set();

    const torrents = (data.torrents || [])
      .filter(t => {
        const k = (
          t.infoHash ||
          (
            (t.title || '')
              .toLowerCase()
              .replace(/\W+/g, '') +
            '|' + (t.sizeBytes || t.size)
          )
        ).toLowerCase();

        if (seen.has(k)) {
          return false;
        }

        seen.add(k);
        return true;
      })
      .sort(
        (a, b) => (b.seeds || 0) - (a.seeds || 0)
      );

    const payload = {
      query,
      torrents,
      totalResults: torrents.length,
      provider: cfg.torrentProvider,
    };

    await cachePut(
      env, key, payload, cfg.torrentTtl
    );

    return json(payload, 200, cors);
  } catch (e) {
    return json({
      query,
      torrents: [],
      totalResults: 0,
      providerError:
        'Torrent index temporarily unavailable (' +
        e.message + ')',
    }, 200, cors);
  }
}

// Movie trailer from TMDB
async function handleTrailer(env, cfg, url, cors) {
  if (!cfg.tmdbApiKey) {
    return json({ trailerUrl: null }, 200, cors);
  }

  const id = (
    url.searchParams.get('id') || ''
  ).trim();

  if (!/^\d+$/.test(id)) {
    return json({ trailerUrl: null }, 200, cors);
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
      vids.find(v => v.site === 'YouTube');

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

// KV caching with in-memory fallback
const mem = new Map();

async function cacheGet(env, key) {
  const hit = mem.get(key);

  if (hit && hit.exp > Date.now()) {
    return hit.value;
  }

  if (env.CACHE) {
    const raw = await env.CACHE.get(
      'cw:' + key, 'json'
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

  mem.set(key, { value, exp });

  if (env.CACHE) {
    await env.CACHE.put(
      'cw:' + key,
      JSON.stringify({ value, exp }),
      { expirationTtl: ttl }
    );
  }
}

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'CinexZone/1.0',
    },
  });

  if (!res.ok) {
    throw Object.assign(
      new Error('Upstream returned ' + res.status),
      { status: 502 }
    );
  }

  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch (e) {
    throw Object.assign(
      new Error('Upstream returned invalid data'),
      { status: 502 }
    );
  }
}

function json(obj, status, extra, more) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign(
      {
        'Content-Type':
          'application/json; charset=utf-8',
      },
      extra || {},
      more || {}
    ),
  });
}
