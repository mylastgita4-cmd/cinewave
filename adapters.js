// ============================================================
// CineWave provider adapters
// All endpoints below are publicly documented:
//   iTunes Search: https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/
//                  (keyless; ~20 requests/minute guidance per IP)
//   TMDB:          https://developer.themoviedb.org/reference/search-movie
//                  (optional fallback; requires TMDB_API_KEY secret)
//   YTS:           https://yts.mx/api  (list_movies.json, keyless)
// ============================================================

// ---------------- Metadata adapters ----------------

export const metadataAdapters = {

  // iTunes Search API — free, no API key required.
  // NOTE: no server-side pagination parameter exists in this API.
  // Strategy: fetch up to 200 results once, cache in KV, slice pages.
  itunes: {
    maxPageWindow: 10, // 10 pages x 20 per page = 200 results window
    async search(cfg, q, page) {
      const data = await fetchJSON(
        'https://itunes.apple.com/search?term=' + encodeURIComponent(q) +
        '&media=movie&entity=movie&limit=200&country=US'
      );
      const results = (data.results || []).map(m => ({
        id: m.trackId != null ? String(m.trackId) : m.trackName,
        title: m.trackName,
        year: (m.releaseDate || '').slice(0, 4),
        overview: m.longDescription || m.shortDescription || '',
        genres: m.primaryGenreName ? [m.primaryGenreName] : [],
        poster: m.artworkUrl100
          ? m.artworkUrl100.replace('/100x100bb.jpg', '/600x600bb.jpg')
          : null,
        rating: null, // iTunes Search API does not provide ratings
        trailerUrl: m.previewUrl || null,
        storeUrl: m.trackViewUrl || null,
        artist: m.artistName || null,
      }));
      return {
        page: page,
        perPage: 20,
        totalPages: Math.max(1, Math.ceil(results.length / 20)),
        totalResults: results.length,
        results: results,
        source: 'itunes',
      };
    },
  },

  // Optional fallback — requires the TMDB_API_KEY secret.
  tmdb: {
    async search(cfg, q, page) {
      if (!cfg.tmdbApiKey) {
        throw Object.assign(new Error(
          'TMDB_API_KEY is not configured. Either set the secret with "npx wrangler secret put TMDB_API_KEY", or set METADATA_PROVIDER = "itunes" (no key needed).'
        ), { status: 500 });
      }
      const data = await fetchJSON(
        'https://api.themoviedb.org/3/search/movie?api_key=' + cfg.tmdbApiKey +
        '&query=' + encodeURIComponent(q) + '&page=' + page
      );
      return {
        page: data.page,
        perPage: 20,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        results: (data.results || []).map(m => ({
          id: String(m.id),
          title: m.title,
          year: (m.release_date || '').slice(0, 4),
          overview: m.overview || '',
          genres: [],
          poster: m.poster_path ? cfg.imageBase + m.poster_path : null,
          rating: m.vote_average,
          trailerUrl: null,
          storeUrl: null,
          artist: null,
        })),
        source: 'tmdb',
      };
    },
  },
};

// ---------------- Torrent adapters ----------------

export const torrentAdapters = {

  // YTS official public API — no API key required.
  // Endpoint: GET https://yts.mx/api/v2/list_movies.json?query_term=&page=&limit=
  yts: {
    async search(cfg, q, page) {
      const data = await fetchJSON(
        'https://yts.mx/api/v2/list_movies.json?query_term=' + encodeURIComponent(q) +
        '&page=' + page + '&limit=20&sort_by=seeds'
      );
      const movies = (data && data.data && data.data.movies) || [];
      const torrents = [];
      for (const m of movies) {
        for (const t of (m.torrents || [])) {
          torrents.push({
            title: m.title + ' (' + m.year + ') ' + t.quality,
            quality: t.quality,
            resolution: t.quality,
            size: t.size,
            sizeBytes: 0,
            seeds: t.seeds,
            peers: t.peers,
            magnet: 'magnet:?xt=urn:btih:' + t.hash +
              '&dn=' + encodeURIComponent(m.title + ' ' + t.quality) +
              '&tr=' + encodeURIComponent('udp://tracker.opentrackr.org:1337/announce'),
            torrentUrl: t.url || null,
            infoHash: (t.hash || '').toLowerCase(),
            source: 'YTS (' + (m.imdb_code || 'unknown imdb id') + ')',
          });
        }
      }
      return { torrents: torrents, totalResults: torrents.length, provider: 'yts' };
    },
  },

  // Jackett (self-hosted, Torznab XML).
  // Needs: var JACKETT_BASE_URL, var JACKETT_INDEXER, secret JACKETT_API_KEY,
  // and TORRENT_PROVIDER = "jackett".
  jackett: {
    async search(cfg, q, page) {
      if (!cfg.jackettBase) {
        throw Object.assign(new Error('JACKETT_BASE_URL not configured'), { status: 500 });
      }
      const limit = 20, offset = (page - 1) * limit;
      const url = cfg.jackettBase + '/api/v2.0/indexers/' + (cfg.jackettIndexer || 'all') +
        '/results/torznab/api?apikey=' + cfg.jackettKey +
        '&t=movie&q=' + encodeURIComponent(q) + '&limit=' + limit + '&offset=' + offset;
      const xml = await fetchText(url);
      const torrents = [];
      const itemRe = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = itemRe.exec(xml))) {
        const b = m[1];
        const tag = n => { const r = new RegExp('<' + n + '[^>]*>([\\s\\S]*?)<\\/' + n + '>').exec(b); return r ? r[1] : null; };
        const attr = n => { const r = new RegExp('name="' + n + '"\\s+value="([^"]*)"').exec(b); return r ? r[1] : null; };
        const link = tag('link') || '';
        const magnetRaw = tag('magnetLink') || (link.indexOf('magnet:') === 0 ? link : null);
        const bytes = parseInt(attr('size') || '0', 10);
        const title = tag('title') || '';
        torrents.push({
          title: title,
          quality: attr('resolution') || (/(2160|1080|720)p/i.exec(title) || [''])[0],
          resolution: attr('resolution') || '',
          size: bytes ? humanSize(bytes) : '',
          sizeBytes: bytes,
          seeds: parseInt(attr('seeders') || '0', 10),
          peers: parseInt(attr('peers') || '0', 10),
          magnet: magnetRaw,
          torrentUrl: link.indexOf('http') === 0 ? link : null,
          infoHash: magnetRaw ? (((/btih:([a-z0-9]{40})/i.exec(magnetRaw)) || [])[1] || '').toLowerCase() : null,
          source: attr('jackettindexer') || 'Jackett',
        });
      }
      return { torrents: torrents, totalResults: torrents.length, provider: 'jackett' };
    },
  },

  // Prowlarr (self-hosted). Needs: var PROWLARR_BASE_URL, secret PROWLARR_API_KEY,
  // and TORRENT_PROVIDER = "prowlarr".
  prowlarr: {
    async search(cfg, q, page) {
      if (!cfg.prowlarrBase) {
        throw Object.assign(new Error('PROWLARR_BASE_URL not configured'), { status: 500 });
      }
      const limit = 20, offset = (page - 1) * limit;
      const data = await fetchJSON(
        cfg.prowlarrBase + '/api/v1/search?query=' + encodeURIComponent(q) +
        '&type=search&apikey=' + cfg.prowlarrKey + '&limit=' + limit + '&offset=' + offset
      );
      const list = Array.isArray(data) ? data : [];
      const torrents = list.map(r => ({
        title: r.title,
        quality: r.protocol === 'torrent' ? (r.indexer || '') : '',
        resolution: (/(2160|1080|720)p/i.exec(r.title || '') || [''])[0],
        size: r.size ? humanSize(r.size) : '',
        sizeBytes: r.size || 0,
        seeds: r.seeders != null ? r.seeders : 0,
        peers: r.leechers != null ? r.leechers : 0,
        magnet: r.magnetUrl || null,
        torrentUrl: r.downloadUrl || null,
        infoHash: r.infoHash || (r.magnetUrl ? (((/btih:([a-z0-9]{40})/i.exec(r.magnetUrl)) || [])[1] || '').toLowerCase() : null),
        source: r.indexer || 'Prowlarr',
      }));
      return { torrents: torrents, totalResults: torrents.length, provider: 'prowlarr' };
    },
  },
};

export function getMetadataAdapter(name) {
  const a = metadataAdapters[name];
  if (!a) throw Object.assign(new Error('Unknown metadata provider: ' + name), { status: 500 });
  return a;
}
export function getTorrentAdapter(name) {
  const a = torrentAdapters[name];
  if (!a) throw Object.assign(new Error('Unknown torrent provider: ' + name), { status: 500 });
  return a;
}

// ---------------- Shared fetch helpers (timeout, retry, 429 backoff) ----------------

async function fetchJSON(url, retries) {
  const text = await fetchWithRetry(url, retries == null ? 2 : retries);
  try { return JSON.parse(text); }
  catch (e) { throw Object.assign(new Error('Upstream returned invalid data'), { status: 502 }); }
}
async function fetchText(url, retries) { return fetchWithRetry(url, retries == null ? 2 : retries); }

async function fetchWithRetry(url, retries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'CineWave/1.0' } });
      clearTimeout(timer);
      if (res.status === 429) {
        if (attempt < retries) {
          const wait = parseInt(res.headers.get('retry-after') || '2', 10);
          await new Promise(r => setTimeout(r, wait * 1000));
          continue;
        }
        throw Object.assign(new Error('Upstream rate limited — try again shortly'), { status: 429 });
      }
      if (!res.ok) throw Object.assign(new Error('Upstream returned ' + res.status), { status: 502 });
      return await res.text();
    } catch (e) {
      clearTimeout(timer);
      if (attempt === retries || e.status === 429 || e.status === 502) throw e;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + ' ' + units[i];
}
