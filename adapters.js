/*
 * CineX Zone - Metadata and Torrent Adapters
 *
 * Metadata providers:
 *   - TMDB
 *   - iTunes
 *
 * Torrent providers:
 *   - YTS (mirror list + YTS_BASE_URL override)
 *   - TPB (apibay.org, keyless, magnet-only; TPB_BASE_URL)
 *   - Knaben (keyless aggregator)
 *   - torrents-csv (keyless, magnet-only)
 *   - Jackett (requires JACKETT_BASE_URL + JACKETT_API_KEY)
 *   - Prowlarr (requires PROWLARR_BASE_URL + PROWLARR_API_KEY)
 *
 * Every torrent adapter returns:
 *   { torrents: [...], totalResults: n, provider: name }
 * where each torrent has:
 *   title, movieTitle, year, quality, resolution,
 *   size, sizeBytes, seeds, peers, magnet, torrentUrl,
 *   infoHash, source
 *
 * Provider failures are thrown as Errors carrying
 * { status, retryable, cooldown, retryAfterSec } so the
 * worker can retry/backoff/cooldown appropriately.
 *
 * API keys must remain server-side.
 */

// ============================================================
// CONSTANTS
// ============================================================

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// YTS mirrors die often. Edit this list to whatever currently works.
// Total worst case = mirrors * YTS_MIRROR_TIMEOUT_MS, keep it under
// TORRENT_TIMEOUT_MS (12000 by default) in worker.js.
const YTS_MIRRORS = [
  'https://yts.mx',
  'https://yts.bz',
  'https://yts.lt',
  'https://yts.am',
];
const YTS_MIRROR_TIMEOUT_MS = 2500;

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1333/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'wss://tracker.openwebtorrent.com',
];

// ============================================================
// METADATA ADAPTERS
// ============================================================

export const metadataAdapters = {
  tmdb: {
    // type: 'all' (movies + TV), 'movie' or 'tv'
    async search(cfg, q, page = 1, type = 'all') {
      if (!cfg.tmdbApiKey) {
        throw Object.assign(new Error('TMDB_API_KEY not set'), { status: 500 });
      }

      const endpoint = type === 'movie' ? 'search/movie'
        : type === 'tv' ? 'search/tv'
        : 'search/multi';

      const params = new URLSearchParams({
        api_key: cfg.tmdbApiKey,
        query: q,
        page: String(page),
        language: 'en-US',
        include_adult: 'false',
      });

      const data = await fetchJSON(
        'https://api.themoviedb.org/3/' + endpoint + '?' + params.toString()
      );

      const results = [];

      for (const m of (data.results || [])) {
        const kind = type === 'all' ? m.media_type : type;
        if (kind !== 'movie' && kind !== 'tv') continue; // skips people

        const isTv = kind === 'tv';
        const title = (isTv ? m.name : m.title) || '';
        if (!title) continue;

        const date = (isTv ? m.first_air_date : m.release_date) || '';

        results.push({
          id: String(m.id),
          type: kind,
          title,
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
        });
      }

      return {
        page: data.page || page,
        perPage: 20,
        totalPages: data.total_pages || 1,
        totalResults: data.total_results || 0,
        results,
        source: 'tmdb',
      };
    },
  },

  itunes: {
    async search(cfg, q, page = 1, type = 'all') {
      const kinds = type === 'all' ? ['movie', 'tv'] : [type];
      const lists = await Promise.all(kinds.map(k => itunesSearchKind(q, k)));

      const results = lists.flat().sort((a, b) =>
        String(b.releaseDate || '').localeCompare(String(a.releaseDate || ''))
      );

      return {
        page,
        perPage: 20,
        totalPages: Math.max(1, Math.ceil(results.length / 20)),
        totalResults: results.length,
        results,
        source: 'itunes-proxy',
      };
    },
  },
};

async function itunesSearchKind(q, kind) {
  const isTv = kind === 'tv';

  const params = new URLSearchParams({
    term: q,
    media: isTv ? 'tvShow' : 'movie',
    entity: isTv ? 'tvSeason' : 'movie',
    limit: '200',
    country: 'US',
  });

  const data = await fetchJSON('https://itunes.apple.com/search?' + params.toString());
  const seen = new Set();
  const out = [];

  for (const m of (data.results || [])) {
    const title = isTv ? (m.artistName || '') : (m.trackName || '');
    if (!title) continue;

    // One entry per show (iTunes lists every season separately)
    if (isTv) {
      const k = title.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
    }

    const art = m.artworkUrl100 || '';

    out.push({
      id: String(isTv ? (m.collectionId || m.trackId || title) : (m.trackId != null ? m.trackId : title)),
      type: kind,
      title,
      year: (m.releaseDate || '').slice(0, 4),
      releaseDate: m.releaseDate || '',
      overview: m.longDescription || m.shortDescription || '',
      genres: m.primaryGenreName ? [m.primaryGenreName] : [],
      genreIds: [],
      poster: art ? art.replace(/\/100x100bb\.(jpg|png)$/, '/600x600bb.$1') : null,
      rating: null,
      trailerUrl: m.previewUrl || null,
      storeUrl: m.trackViewUrl || m.collectionViewUrl || null,
      artist: m.artistName || null,
      source: 'iTunes',
    });
  }

  return out;
}

// ============================================================
// TORRENT ADAPTERS
// ============================================================

export const torrentAdapters = {
  // ---------------- YTS (with mirror fallback) ----------------
  yts: {
    async search(cfg, q, page = 1) {
      const bases = [...new Set(
        [cfg.ytsBase, ...(cfg.ytsMirrors || []), ...YTS_MIRRORS]
          .map(normalizeBase)
          .filter(Boolean)
      )];

      const params = new URLSearchParams({
        query_term: q,
        page: String(page),
        limit: '50',
        sort_by: 'seeds',
      });

      const data = await fetchFromBases(
        bases,
        '/api/v2/list_movies.json?' + params.toString(),
        YTS_MIRROR_TIMEOUT_MS
      );

      if (data && data.status && data.status !== 'ok') {
        throw new Error(
          'yts: ' + (data.status_message || 'YTS API returned an unsuccessful response')
        );
      }

      const movies = data && data.data && Array.isArray(data.data.movies)
        ? data.data.movies
        : [];

      const torrents = [];

      for (const m of movies) {
        if (!m || !m.title) continue;

        for (const t of (m.torrents || [])) {
          if (!t || !t.hash) continue;

          const hash = String(t.hash).toLowerCase();
          const magnet = buildMagnet(
            hash,
            (m.title || 'Movie') + ' ' + (t.quality || '')
          );
          if (!magnet) continue;

          const title = [
            m.title || '',
            m.year ? '(' + m.year + ')' : '',
            t.quality || '',
          ].filter(Boolean).join(' ');

          torrents.push({
            title,
            movieTitle: m.title || '',
            year: m.year || null,
            quality: t.quality || '',
            resolution: t.quality || '',
            size: t.size || '',
            sizeBytes: parseSize(t.size),
            seeds: Number(t.seeds) || 0,
            peers: Number(t.peers) || 0,
            magnet,
            torrentUrl: isHttpUrl(t.url) ? t.url : null,
            infoHash: hash,
            source: 'YTS',
          });
        }
      }

      return { torrents, totalResults: torrents.length, provider: 'yts' };
    },
  },

  // ---------------- The Pirate Bay (apibay) ----------------
  tpb: {
    async search(cfg, q, page = 1) {
      const base = normalizeBase(cfg.tpbBase || 'https://apibay.org');
      // cat 200 = all video (207 was HD movies only)
      const url = base + '/q.php?' +
        new URLSearchParams({ q, cat: '200' }).toString();

      const data = await fetchJSON(url);

      const list = Array.isArray(data)
        ? data.filter(r => r && r.info_hash && r.name && !/^no results/i.test(r.name))
        : [];

      const torrents = [];

      for (const r of list) {
        const name = String(r.name || '');
        const hash = String(r.info_hash || '').toLowerCase();
        const magnet = buildMagnet(hash, name);
        if (!magnet) continue;

        const resolution = (/(2160p|1080p|720p|480p)/i.exec(name) || [])[0] || '';
        const sizeBytes = Number(r.size) || 0;

        torrents.push({
          title: name,
          movieTitle: cleanReleaseName(name),
          year: extractYear(name) || null,
          quality: resolution,
          resolution,
          size: sizeBytes ? humanSize(sizeBytes) : '',
          sizeBytes,
          seeds: Number(r.seeders) || 0,
          peers: Number(r.leechers) || 0,
          magnet,
          torrentUrl: null,
          infoHash: hash,
          source: 'ThePirateBay',
        });
      }

      return { torrents, totalResults: torrents.length, provider: 'tpb' };
    },
  },

  // ---------------- Knaben ----------------
  knaben: {
    // Keyless aggregator. POST https://api.knaben.org/v1, results in "hits".
    async search(cfg, q, page = 1) {
      let res;
      try {
        res = await fetch('https://api.knaben.org/v1', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': BROWSER_UA,
          },
          body: JSON.stringify({
            search_type: '100%',
            search_field: 'title',
            query: q,
            order_by: 'seeders',
            order_direction: 'desc',
            from: 0,
            size: 50,
            hide_unsafe: true,
          }),
          signal: AbortSignal.timeout(8000),
        });
      } catch (e) {
        throw Object.assign(new Error('Fetch failed: ' + (e.message || e.name)), {
          status: 502,
          retryable: true,
          cooldown: false,
        });
      }

      if (!res.ok) {
        throw Object.assign(new Error('Upstream returned ' + res.status), {
          status: 502,
          retryable: res.status === 429 || res.status >= 500,
          cooldown: res.status === 429 || res.status === 530 || res.status >= 500,
          retryAfterSec: parseInt(res.headers.get('Retry-After') || '', 10) || null,
        });
      }

      let data;
      try {
        data = await res.json();
      } catch {
        throw Object.assign(new Error('Upstream returned invalid JSON'), {
          status: 502,
          retryable: false,
        });
      }

      const list = data && Array.isArray(data.hits) ? data.hits : [];

      if (!list.length) {
        console.log('knaben empty response:', JSON.stringify(data).slice(0, 300));
      }

      const torrents = [];

      for (const r of list) {
        const name = String(r.title || '').trim();
        if (!name) continue;

        const hash = String(r.hash || r.infoHash || '').toLowerCase();

        let magnet = (r.magnetUrl && !isHttpUrl(r.magnetUrl)) ? r.magnetUrl : null;
        if (!magnet) magnet = buildMagnet(hash, name);
        if (!magnet) continue;

        const resolution = (/(2160p|1080p|720p|480p)/i.exec(name) || [])[0] || '';
        const sizeBytes = Number(r.bytes) || 0;

        torrents.push({
          title: name,
          movieTitle: cleanReleaseName(name),
          year: extractYear(name) || null,
          quality: resolution,
          resolution,
          size: sizeBytes ? humanSize(sizeBytes) : '',
          sizeBytes,
          seeds: Number(r.seeders) || 0,
          peers: Number(r.peers ?? r.leechers) || 0,
          magnet,
          // r.link is usually a details page, not a .torrent file
          torrentUrl: null,
          infoHash: hash ||
            (magnet.match(/btih:([a-z0-9]{40}|[a-z0-9]{32})/i) || [])[1] || '',
          source: r.tracker || 'Knaben',
        });
      }

      return { torrents, totalResults: torrents.length, provider: 'knaben' };
    },
  },

  // ---------------- torrents-csv ----------------
  torrentscsv: {
    async search(cfg, q, page = 1) {
      const url = 'https://torrents-csv.com/service/search?' +
        new URLSearchParams({ q, size: '100' }).toString();

      const data = await fetchJSON(url, 8000);

      // Newer API: { torrents: [...] }, older: plain array or { results: [...] }
      const list = Array.isArray(data) ? data
        : Array.isArray(data && data.torrents) ? data.torrents
        : Array.isArray(data && data.results) ? data.results
        : [];

      if (!list.length) {
        console.log('torrentscsv empty response:', JSON.stringify(data).slice(0, 300));
      }

      const torrents = [];

      for (const r of list) {
        if (!r || !r.name) continue;

        const name = String(r.name || '');
        const hash = String(r.infohash || r.info_hash || '').toLowerCase();
        const magnet = buildMagnet(hash, name);
        if (!magnet) continue;

        const resolution = (/(2160p|1080p|720p|480p)/i.exec(name) || [])[0] || '';
        const sizeBytes = Number(r.size_bytes) || 0;

        torrents.push({
          title: name,
          movieTitle: cleanReleaseName(name),
          year: extractYear(name) || null,
          quality: resolution,
          resolution,
          size: sizeBytes ? humanSize(sizeBytes) : '',
          sizeBytes,
          seeds: Number(r.seeders) || 0,
          peers: Number(r.leechers) || 0,
          magnet,
          torrentUrl: null,
          infoHash: hash,
          source: 'torrents-csv',
        });
      }

      return { torrents, totalResults: torrents.length, provider: 'torrentscsv' };
    },
  },

  // ---------------- Jackett ----------------
  jackett: {
    async search(cfg, q, page = 1, opts = {}) {
      if (!cfg.jackettBase) throw configError('jackett: JACKETT_BASE_URL not configured');
      if (!cfg.jackettKey) throw configError('jackett: JACKETT_API_KEY not configured');

      const base = normalizeBase(cfg.jackettBase);
      const indexer = cfg.jackettIndexer || 'all';

      const params = new URLSearchParams({
        apikey: cfg.jackettKey,
        t: opts.type === 'tv' ? 'tvsearch' : 'movie',
        q,
        limit: '50',
        offset: String((page - 1) * 50),
      });

      const url = base + '/api/v2.0/indexers/' + encodeURIComponent(indexer) +
        '/results/torznab/api?' + params.toString();

      let xml;
      try {
        xml = await fetchText(url, 5000);
      } catch (e) {
        e.retryable = false;
        e.cooldown = true;
        throw e;
      }
      const torrents = [];
      const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
      let match;

      while ((match = itemRe.exec(xml))) {
        const block = match[1];

        const tag = name => {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(
            '<' + escaped + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + escaped + '\\s*>',
            'i'
          );
          const found = re.exec(block);
          return found ? decodeXml(found[1].trim()) : null;
        };

        const attr = name => {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(
            '<torznab:attr\\b[^>]*\\bname="' + escaped +
            '"[^>]*\\bvalue="([^"]*)"[^>]*\\/?>',
            'i'
          );
          const found = re.exec(block);
          return found ? decodeXml(found[1]) : null;
        };

        const title = tag('title') || '';
        const link = tag('link') || '';
        const guid = tag('guid') || '';

        let magnet = tag('magnetLink') ||
          (link.startsWith('magnet:?') ? link : null);

        const sizeBytes = Number(attr('size')) || 0;
        const resolution = attr('resolution') ||
          ((/(2160p|1080p|720p|480p)/i.exec(title) || [])[0]);

        const hashMatch = magnet
          ? /btih:([a-z0-9]{40}|[a-z0-9]{32})/i.exec(magnet)
          : null;

        const infoHash = hashMatch
          ? hashMatch[1].toLowerCase()
          : (attr('infohash') ? String(attr('infohash')).toLowerCase() : null);

        if (!magnet && infoHash) magnet = buildMagnet(infoHash, title);
        if (!magnet && !isHttpUrl(link) && !isHttpUrl(guid)) continue;

        torrents.push({
          title,
          movieTitle: cleanReleaseName(title),
          year: extractYear(title) || null,
          quality: resolution || '',
          resolution: resolution || '',
          size: sizeBytes ? humanSize(sizeBytes) : '',
          sizeBytes,
          seeds: Number(attr('seeders')) || 0,
          peers: Number(attr('peers')) || 0,
          magnet,
          torrentUrl: isHttpUrl(link) ? link : (isHttpUrl(guid) ? guid : null),
          infoHash,
          source: attr('jackettindexer') || 'Jackett',
        });
      }

      return { torrents, totalResults: torrents.length, provider: 'jackett' };
    },
  },

  // ---------------- Prowlarr ----------------
  prowlarr: {
    async search(cfg, q, page = 1, opts = {}) {
      if (!cfg.prowlarrBase) throw configError('prowlarr: PROWLARR_BASE_URL not configured');
      if (!cfg.prowlarrKey) throw configError('prowlarr: PROWLARR_API_KEY not configured');

      const base = normalizeBase(cfg.prowlarrBase);
      const params = new URLSearchParams({
        query: q,
        type: 'search',
        apikey: cfg.prowlarrKey,
      });
      if (opts.type === 'tv') params.set('categories', '5000');

      // Self-hosted (e.g. home PC): if it is offline, fail fast, do not
      // retry, and let the worker put it on cooldown so searches stay quick.
      let data;
      try {
        data = await fetchJSON(base + '/api/v1/search?' + params.toString(), 5000);
      } catch (e) {
        e.retryable = false;
        e.cooldown = true;
        throw e;
      }
      const list = Array.isArray(data) ? data : [];
      const torrents = [];

      for (const r of list) {
        if (!r || !r.title) continue;

        const title = r.title || '';
        const magnet = r.magnetUrl || r.magnetURL || null;

        const hashMatch = magnet
          ? /btih:([a-z0-9]{40}|[a-z0-9]{32})/i.exec(magnet)
          : null;

        const infoHash =
          (r.infoHash || (hashMatch ? hashMatch[1].toLowerCase() : null)) || null;

        let resolvedMagnet = magnet;
        if (!resolvedMagnet && infoHash) resolvedMagnet = buildMagnet(infoHash, title);

        const downloadUrl = isHttpUrl(r.downloadUrl)
          ? r.downloadUrl
          : (isHttpUrl(r.downloadURL) ? r.downloadURL : null);

        if (!resolvedMagnet && !downloadUrl) continue;

        const sizeBytes = Number(r.size) || 0;
        const resolution = (/(2160p|1080p|720p|480p)/i.exec(title) || [])[0] || '';

        torrents.push({
          title,
          movieTitle: cleanReleaseName(title),
          year: extractYear(title) || null,
          quality: resolution,
          resolution,
          size: sizeBytes ? humanSize(sizeBytes) : '',
          sizeBytes,
          seeds: Number(r.seeders) || 0,
          peers: Number(r.leechers) || 0,
          magnet: resolvedMagnet,
          torrentUrl: downloadUrl,
          infoHash,
          source: r.indexer || r.indexerName || 'Prowlarr',
        });
      }

      return { torrents, totalResults: torrents.length, provider: 'prowlarr' };
    },
  },
};

// ============================================================
// ADAPTER LOOKUP
// ============================================================

export function getMetadataAdapter(name) {
  const adapter = metadataAdapters[name];
  if (!adapter) {
    throw Object.assign(new Error('Unknown metadata provider: ' + name), { status: 500 });
  }
  return adapter;
}

export function getTorrentAdapter(name) {
  const adapter = torrentAdapters[name];
  if (!adapter) {
    throw Object.assign(new Error('Unknown torrent provider: ' + name), { status: 500 });
  }
  return adapter;
}

// ============================================================
// HELPERS
// ============================================================

export function buildMagnet(infoHash, displayName) {
  const hash = String(infoHash || '').toLowerCase().trim();
  if (!/^[a-f0-9]{40}$/.test(hash) && !/^[a-f0-9]{32}$/.test(hash)) return null;

  const magnetParams = new URLSearchParams({
    xt: 'urn:btih:' + hash,
    dn: String(displayName || 'Movie').slice(0, 200),
  });
  for (const tr of TRACKERS) magnetParams.append('tr', tr);

  return 'magnet:?' + magnetParams.toString();
}

function extractYear(value) {
  const match = /\b(19\d{2}|20\d{2})\b/.exec(String(value || ''));
  return match ? parseInt(match[1], 10) : 0;
}

function cleanReleaseName(name) {
  return String(name || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(
      /\.(mkv|mp4|avi|webm|x264|x265|h264|h265|hevc|bluray|webrip|web[- ]?dl|bdrip|dvdrip|hdrip|brrip|dvdrip|720p|1080p|2160p|480p|4k|yify|rarbg|ettv|eztv|aac|aac2|dts|ddp?5\.?1|5\.1|aac2\.0|hdtv|xvid|it|hindi|dual[\s-]*audio|esubs?|sub[\s-]*\w+|[\s.-]+)+/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSize(value) {
  const s = String(value || '').trim();
  if (!s) return 0;

  const m = /^([\d.]+)\s*(b|kb|mb|gb|tb)$/i.exec(s);
  if (!m) return 0;

  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;

  const mult = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
  }[m[2].toLowerCase()];

  return Math.round(n * mult);
}

function isHttpUrl(value) {
  return typeof value === 'string' &&
    (value.startsWith('https://') || value.startsWith('http://'));
}

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function configError(message) {
  return Object.assign(new Error(message), {
    status: 500,
    retryable: false,
    cooldown: false,
  });
}

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = Number(bytes) || 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return size.toFixed(1) + ' ' + units[index];
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// ---------------- network helpers ----------------

function httpError(response) {
  return Object.assign(new Error('Upstream returned ' + response.status), {
    status: 502,
    retryable: response.status === 429 || response.status >= 500,
    cooldown:
      response.status === 429 ||
      response.status === 530 ||
      response.status >= 500,
    retryAfterSec: parseInt(response.headers.get('Retry-After') || '', 10) || null,
  });
}

function networkError(e) {
  return Object.assign(new Error('Fetch failed: ' + ((e && (e.message || e.name)) || 'unknown')), {
    status: 502,
    retryable: true,
    cooldown: false,
  });
}

async function fetchJSON(url, timeoutMs = 0) {
  let response;

  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e) {
    throw networkError(e);
  }

  if (!response.ok) throw httpError(response);

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    console.error('Invalid JSON from', url, text.slice(0, 200));
    throw Object.assign(new Error('Upstream returned invalid JSON'), {
      status: 502,
      retryable: false,
    });
  }
}

// Try several base URLs in order until one works.
async function fetchFromBases(bases, path, timeoutMs = 4000) {
  let lastErr;

  for (const b of bases) {
    try {
      return await fetchJSON(b + path, timeoutMs);
    } catch (e) {
      lastErr = e;
      console.log('mirror failed:', b, e && e.message);
    }
  }

  throw lastErr || new Error('All mirrors failed');
}

async function fetchText(url, timeoutMs = 0) {
  let response;

  try {
    response = await fetch(url, {
      headers: { Accept: 'application/xml, text/xml', 'User-Agent': BROWSER_UA },
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e) {
    throw networkError(e);
  }

  if (!response.ok) throw httpError(response);

  return response.text();
}
