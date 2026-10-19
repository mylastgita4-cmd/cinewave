/*
 * CineX Zone - Metadata and Torrent Adapters
 *
 * Metadata providers:
 *   - TMDB
 *   - iTunes
 *
 * Torrent providers:
 *   - YTS (mirror configurable via YTS_BASE_URL)
 *   - TPB (apibay.org, keyless, magnet-only; TPB_BASE_URL)
 *   - Knaben (keyless aggregator: 1337x, TGx, TPB, YTS and more; rarely down)
 *   - torrents-csv (keyless, magnet-only)
 *   - Jackett (requires JACKETT_BASE_URL + JACKETT_API_KEY)
 *   - Prowlarr (requires PROWLARR_BASE_URL + PROWLARR_API_KEY)
 *
 * Every torrent adapter returns a consistent structure:
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
// METADATA ADAPTERS
// ============================================================

export const metadataAdapters = {
  tmdb: {
    async search(cfg, q, page = 1) {
      if (!cfg.tmdbApiKey) throw Object.assign(new Error('TMDB_API_KEY not set'), { status: 500 });
      const params = new URLSearchParams({ api_key: cfg.tmdbApiKey, query: q, page: String(page), language: 'en-US' });
      const data = await fetchJSON('https://api.themoviedb.org/3/search/movie?' + params.toString());
      return {
        page: data.page || page, perPage: 20, totalPages: data.total_pages || 1,
        totalResults: data.total_results || 0,
        results: (data.results || []).map(m => ({
          id: String(m.id), title: m.title || '', year: (m.release_date || '').slice(0, 4),
          releaseDate: m.release_date || '', overview: m.overview || '',
          poster: m.poster_path ? cfg.imageBase + m.poster_path : null,
          rating: m.vote_average ?? null, genres: [], genreIds: m.genre_ids || [],
          trailerUrl: null, storeUrl: null, source: 'TMDB',
        })),
        source: 'tmdb',
      };
    },
  },
  itunes: {
    async search(cfg, q, page = 1) {
      const params = new URLSearchParams({ term: q, media: 'movie', entity: 'movie', limit: '200', country: 'US' });
      const data = await fetchJSON('https://itunes.apple.com/search?' + params.toString());
      const results = (data.results || []).map(m => ({
        id: m.trackId != null ? String(m.trackId) : (m.trackName || ''),
        title: m.trackName || '', year: (m.releaseDate || '').slice(0, 4),
        releaseDate: m.releaseDate || '', overview: m.longDescription || m.shortDescription || '',
        genres: m.primaryGenreName ? [m.primaryGenreName] : [], genreIds: [],
        poster: m.artworkUrl100 ? m.artworkUrl100.replace('/100x100bb.jpg', '/600x600bb.jpg') : null,
        rating: null, trailerUrl: m.previewUrl || null, storeUrl: m.trackViewUrl || null,
        artist: m.artistName || null, source: 'iTunes',
      })).filter(m => m.title);
      return {
        page, perPage: 20, totalPages: Math.max(1, Math.ceil(results.length / 20)),
        totalResults: results.length, results, source: 'itunes-proxy',
      };
    },
  },
};

export const torrentAdapters = {
  yts: {
    async search(cfg, q, page = 1) {
      const base = normalizeBase(cfg.ytsBase || 'https://yts.mx');
      const params = new URLSearchParams({ query_term: q, page: String(page), limit: '50', sort_by: 'seeds' });
      const data = await fetchJSON(base + '/api/v2/list_movies.json?' + params.toString());
      if (data && data.status && data.status !== 'ok') {
        throw new Error('yts: ' + (data.status_message || 'YTS API returned an unsuccessful response'));
      }
      const movies = data && data.data && Array.isArray(data.data.movies) ? data.data.movies : [];
      const torrents = [];
      for (const m of movies) {
        if (!m || !m.title) continue;
        for (const t of (m.torrents || [])) {
          if (!t || !t.hash) continue;
          const hash = String(t.hash).toLowerCase();
          const magnet = buildMagnet(hash, (m.title || 'Movie') + ' ' + (t.quality || ''));
          if (!magnet) continue;
          const title = [m.title || '', m.year ? '(' + m.year + ')' : '', t.quality || ''].filter(Boolean).join(' ');
          torrents.push({
            title, movieTitle: m.title || '', year: m.year || null,
            quality: t.quality || '', resolution: t.quality || '',
            size: t.size || '', sizeBytes: parseSize(t.size),
            seeds: Number(t.seeds) || 0, peers: Number(t.peers) || 0,
            magnet, torrentUrl: isHttpUrl(t.url) ? t.url : null,
            infoHash: hash, source: 'YTS',
          });
        }
      }
      return { torrents, totalResults: torrents.length, provider: 'yts' };
    },
  },
  tpb: {
    async search(cfg, q, page = 1) {
      const base = normalizeBase(cfg.tpbBase || 'https://apibay.org');
      const url = base + '/q.php?' + new URLSearchParams({ q, cat: '207' }).toString();
      const data = await fetchJSON(url);
      const list = Array.isArray(data) ? data.filter(r => r && r.info_hash && r.name && !/^no results/i.test(r.name)) : [];
      const torrents = [];
      for (const r of list) {
        const name = String(r.name || '');
        const hash = String(r.info_hash || '').toLowerCase();
        const magnet = buildMagnet(hash, name);
        if (!magnet) continue;
        const resolution = (/(2160p|1080p|720p|480p)/i.exec(name) || [])[0] || '';
        const sizeBytes = Number(r.size) || 0;
        torrents.push({
          title: name, movieTitle: cleanReleaseName(name), year: extractYear(name) || null,
          quality: resolution, resolution, size: sizeBytes ? humanSize(sizeBytes) : '',
          sizeBytes, seeds: Number(r.seeders) || 0, peers: Number(r.leechers) || 0,
          magnet, torrentUrl: null, infoHash: hash, source: 'ThePirateBay',
        });
      }
      return { torrents, totalResults: torrents.length, provider: 'tpb' };
    },
  },
  knaben: {
    // NEW: keyless aggregator (1337x, TGx, TPB, YTS and more in one API).
    // Endpoint: POST https://api.knaben.org/v1 — response array is "hits".
    async search(cfg, q, page = 1) {
      const res = await fetch('https://api.knaben.org/v1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CineXZone/1.0',
        },
        body: JSON.stringify({
          query: q,
          search_field: 'title',
          size: 50,
          categories: [2000], // Movies
        }),
      });
      if (!res.ok) {
        throw Object.assign(new Error('Upstream returned ' + res.status), {
          status: 502,
          retryable: res.status === 429 || res.status >= 500,
          cooldown: res.status === 429 || res.status === 530 || res.status >= 500,
          retryAfterSec: parseInt(res.headers.get('Retry-After') || '', 10) || null,
        });
      }
      const data = await res.json();
      const list = data && Array.isArray(data.hits) ? data.hits : [];
      const torrents = [];
      for (const r of list) {
        const name = String(r.title || '').trim();
        if (!name) continue;
        const hash = String(r.infoHash || '').toLowerCase();
        let magnet = (r.magnetUrl && !isHttpUrl(r.magnetUrl)) ? r.magnetUrl : null;
        if (!magnet) magnet = buildMagnet(hash, name);
        if (!magnet) continue;
        const resolution = (/(2160p|1080p|720p|480p)/i.exec(name) || [])[0] || '';
        const sizeBytes = Number(r.bytes) || 0;
        torrents.push({
          title: name, movieTitle: cleanReleaseName(name), year: extractYear(name) || null,
          quality: resolution, resolution, size: sizeBytes ? humanSize(sizeBytes) : '',
          sizeBytes, seeds: Number(r.seeders) || 0, peers: Number(r.leechers) || 0,
          magnet, torrentUrl: isHttpUrl(r.downloadUrl) ? r.downloadUrl : null,
          infoHash: hash || (magnet.match(/btih:([a-z0-9]{40}|[a-z0-9]{32})/i) || [])[1] || '',
          source: r.tracker || 'Knaben',
        });
      }
      return { torrents, totalResults: torrents.length, provider: 'knaben' };
    },
  },
  torrentscsv: {
    async search(cfg, q, page = 1) {
      const url = 'https://torrents-csv.com/service/search?' + new URLSearchParams({ q, size: '100' }).toString();
      const data = await fetchJSON(url);
      const list = data && Array.isArray(data.results) ? data.results : [];
      const torrents = [];
      for (const r of list) {
        if (!r || !r.name) continue;
        const name = String(r.name || '');
        const hash = String(r.infohash || '').toLowerCase();
        const magnet = buildMagnet(hash, name);
        if (!magnet) continue;
        const resolution = (/(2160p|1080p|720p|480p)/i.exec(name) || [])[0] || '';
        const sizeBytes = Number(r.size_bytes) || 0;
        torrents.push({
          title: name, movieTitle: cleanReleaseName(name), year: extractYear(name) || null,
          quality: resolution, resolution, size: sizeBytes ? humanSize(sizeBytes) : '',
          sizeBytes, seeds: Number(r.seeders) || 0, peers: Number(r.leechers) || 0,
          magnet, torrentUrl: null, infoHash: hash, source: 'torrents-csv',
        });
      }
      return { torrents, totalResults: torrents.length, provider: 'torrentscsv' };
    },
  },
  jackett: {
    async search(cfg, q, page = 1) {
      if (!cfg.jackettBase) throw configError('jackett: JACKETT_BASE_URL not configured');
      if (!cfg.jackettKey) throw configError('jackett: JACKETT_API_KEY not configured');
      const base = normalizeBase(cfg.jackettBase);
      const indexer = cfg.jackettIndexer || 'all';
      const params = new URLSearchParams({ apikey: cfg.jackettKey, t: 'movie', q, limit: '50', offset: String((page - 1) * 50) });
      const url = base + '/api/v2.0/indexers/' + encodeURIComponent(indexer) + '/results/torznab/api?' + params.toString();
      const xml = await fetchText(url);
      const torrents = [];
      const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
      let match;
      while ((match = itemRe.exec(xml))) {
        const block = match[1];
        const tag = name => {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp('<' + escaped + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + escaped + '\\s*>', 'i');
          const found = re.exec(block);
          return found ? decodeXml(found[1].trim()) : null;
        };
        const attr = name => {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp('<torznab:attr\\b[^>]*\\bname="' + escaped + '"[^>]*\\bvalue="([^"]*)"[^>]*\\/?>', 'i');
          const found = re.exec(block);
          return found ? decodeXml(found[1]) : null;
        };
        const title = tag('title') || '';
        const link = tag('link') || '';
        const guid = tag('guid') || '';
        let magnet = tag('magnetLink') || (link.startsWith('magnet:?') ? link : null);
        const sizeBytes = Number(attr('size')) || 0;
        const resolution = attr('resolution') || ((/(2160p|1080p|720p|480p)/i.exec(title) || [])[0]);
        const hashMatch = magnet ? /btih:([a-z0-9]{40}|[a-z0-9]{32})/i.exec(magnet) : null;
        const infoHash = hashMatch ? hashMatch[1].toLowerCase() : (attr('infohash') ? String(attr('infohash')).toLowerCase() : null);
        if (!magnet && infoHash) magnet = buildMagnet(infoHash, title);
        if (!magnet && !isHttpUrl(link) && !isHttpUrl(guid)) continue;
        torrents.push({
          title, movieTitle: cleanReleaseName(title), year: extractYear(title) || null,
          quality: resolution || '', resolution: resolution || '',
          size: sizeBytes ? humanSize(sizeBytes) : '', sizeBytes,
          seeds: Number(attr('seeders')) || 0, peers: Number(attr('peers')) || 0,
          magnet, torrentUrl: isHttpUrl(link) ? link : (isHttpUrl(guid) ? guid : null),
          infoHash, source: attr('jackettindexer') || 'Jackett',
        });
      }
      return { torrents, totalResults: torrents.length, provider: 'jackett' };
    },
  },
  prowlarr: {
    async search(cfg, q, page = 1) {
      if (!cfg.prowlarrBase) throw configError('prowlarr: PROWLARR_BASE_URL not configured');
      if (!cfg.prowlarrKey) throw configError('prowlarr: PROWLARR_API_KEY not configured');
      const base = normalizeBase(cfg.prowlarrBase);
      const params = new URLSearchParams({ query: q, type: 'search', apikey: cfg.prowlarrKey });
      const data = await fetchJSON(base + '/api/v1/search?' + params.toString());
      const list = Array.isArray(data) ? data : [];
      const torrents = [];
      for (const r of list) {
        if (!r || !r.title) continue;
        const title = r.title || '';
        const magnet = r.magnetUrl || r.magnetURL || null;
        const hashMatch = magnet ? /btih:([a-z0-9]{40}|[a-z0-9]{32})/i.exec(magnet) : null;
        const infoHash = (r.infoHash || (hashMatch ? hashMatch[1].toLowerCase() : null)) || null;
        let resolvedMagnet = magnet;
        if (!resolvedMagnet && infoHash) resolvedMagnet = buildMagnet(infoHash, title);
        const downloadUrl = isHttpUrl(r.downloadUrl) ? r.downloadUrl : (isHttpUrl(r.downloadURL) ? r.downloadURL : null);
        if (!resolvedMagnet && !downloadUrl) continue;
        const sizeBytes = Number(r.size) || 0;
        const resolution = (/(2160p|1080p|720p|480p)/i.exec(title) || [])[0] || '';
        torrents.push({
          title, movieTitle: cleanReleaseName(title), year: extractYear(title) || null,
          quality: resolution, resolution, size: sizeBytes ? humanSize(sizeBytes) : '',
          sizeBytes, seeds: Number(r.seeders) || 0, peers: Number(r.leechers) || 0,
          magnet: resolvedMagnet, torrentUrl: downloadUrl, infoHash,
          source: r.indexer || r.indexerName || 'Prowlarr',
        });
      }
      return { torrents, totalResults: torrents.length, provider: 'prowlarr' };
    },
  },
};

export function getMetadataAdapter(name) {
  const adapter = metadataAdapters[name];
  if (!adapter) throw Object.assign(new Error('Unknown metadata provider: ' + name), { status: 500 });
  return adapter;
}
export function getTorrentAdapter(name) {
  const adapter = torrentAdapters[name];
  if (!adapter) throw Object.assign(new Error('Unknown torrent provider: ' + name), { status: 500 });
  return adapter;
}

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1333/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'wss://tracker.openwebtorrent.com',
];
export function buildMagnet(infoHash, displayName) {
  const hash = String(infoHash || '').toLowerCase().trim();
  if (!/^[a-f0-9]{40}$/.test(hash) && !/^[a-f0-9]{32}$/.test(hash)) return null;
  const magnetParams = new URLSearchParams({ xt: 'urn:btih:' + hash, dn: String(displayName || 'Movie').slice(0, 200) });
  for (const tr of TRACKERS) magnetParams.append('tr', tr);
  return 'magnet:?' + magnetParams.toString();
}
function extractYear(value) {
  const match = /\b(19\d{2}|20\d{2})\b/.exec(String(value || ''));
  return match ? parseInt(match[1], 10) : 0;
}
function cleanReleaseName(name) {
  return String(name || '').replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ')
    .replace(/\.(mkv|mp4|avi|webm|x264|x265|h264|h265|hevc|bluray|webrip|web[- ]?dl|bdrip|dvdrip|hdrip|brrip|dvdrip|720p|1080p|2160p|480p|4k|yify|rarbg|ettv|eztv|aac|aac2|dts|ddp?5\.?1|5\.1|aac2\.0|hdtv|xvid|it|hindi|dual[\s-]*audio|esubs?|sub[\s-]*\w+|[\s.-]+)+/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}
function parseSize(value) {
  const s = String(value || '').trim();
  if (!s) return 0;
  const m = /^([\d.]+)\s*(b|kb|mb|gb|tb)$/i.exec(s);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[m[2].toLowerCase()];
  return Math.round(n * mult);
}
function isHttpUrl(value) {
  return typeof value === 'string' && (value.startsWith('https://') || value.startsWith('http://'));
}
function normalizeBase(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function configError(message) {
  return Object.assign(new Error(message), { status: 500, retryable: false, cooldown: false });
}
async function fetchJSON(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CineXZone/1.0' } });
  if (!response.ok) {
    throw Object.assign(new Error('Upstream returned ' + response.status), {
      status: 502, retryable: response.status === 429 || response.status >= 500,
      cooldown: response.status === 429 || response.status === 530 || response.status >= 500,
      retryAfterSec: parseInt(response.headers.get('Retry-After') || '', 10) || null,
    });
  }
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('Upstream returned invalid JSON'), { status: 502, retryable: false }); }
}
async function fetchText(url) {
  const response = await fetch(url, { headers: { Accept: 'application/xml, text/xml', 'User-Agent': 'CineXZone/1.0' } });
  if (!response.ok) {
    throw Object.assign(new Error('Upstream returned ' + response.status), {
      status: 502, retryable: response.status === 429 || response.status >= 500,
      cooldown: response.status === 429 || response.status >= 500,
      retryAfterSec: parseInt(response.headers.get('Retry-After') || '', 10) || null,
    });
  }
  return response.text();
}
function decodeXml(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = Number(bytes) || 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return size.toFixed(1) + ' ' + units[index];
}
