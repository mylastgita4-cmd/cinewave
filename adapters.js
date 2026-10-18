
/*
 * CineX Zone - Metadata and Torrent Adapters
 *
 * Metadata providers:
 *   - TMDB
 *   - iTunes
 *
 * Torrent providers:
 *   - YTS
 *   - Jackett
 *   - Prowlarr
 *
 * Required Worker bindings/secrets:
 *   TMDB_API_KEY
 *   JACKETT_BASE_URL
 *   JACKETT_API_KEY
 *   JACKETT_INDEXER
 *   PROWLARR_BASE_URL
 *   PROWLARR_API_KEY
 *
 * TORRENT_PROVIDER selects the torrent provider.
 * API keys must remain server-side.
 */

// ============================================================
// METADATA ADAPTERS
// ============================================================

export const metadataAdapters = {
  tmdb: {
    async search(cfg, q, page = 1) {
      if (!cfg.tmdbApiKey) {
        throw Object.assign(
          new Error('TMDB_API_KEY not set'),
          { status: 500 }
        );
      }

      const params = new URLSearchParams({
        api_key: cfg.tmdbApiKey,
        query: q,
        page: String(page),
        language: 'en-US',
      });

      const data = await fetchJSON(
        'https://api.themoviedb.org/3/search/movie?' +
        params.toString()
      );

      return {
        page: data.page || page,
        perPage: 20,
        totalPages: data.total_pages || 1,
        totalResults: data.total_results || 0,

        results: (data.results || []).map(m => ({
          id: String(m.id),
          title: m.title || '',
          year: (m.release_date || '').slice(0, 4),
          releaseDate: m.release_date || '',
          overview: m.overview || '',

          poster: m.poster_path
            ? cfg.imageBase + m.poster_path
            : null,

          rating: m.vote_average ?? null,
          genres: [],
          genreIds: m.genre_ids || [],
          trailerUrl: null,
          storeUrl: null,
          source: 'TMDB',
        })),

        source: 'tmdb',
      };
    },
  },

  itunes: {
    async search(cfg, q, page = 1) {
      const params = new URLSearchParams({
        term: q,
        media: 'movie',
        entity: 'movie',
        limit: '200',
        country: 'US',
      });

      const data = await fetchJSON(
        'https://itunes.apple.com/search?' +
        params.toString()
      );

      const results = (data.results || []).map(m => ({
        id: m.trackId != null
          ? String(m.trackId)
          : (m.trackName || ''),

        title: m.trackName || '',
        year: (m.releaseDate || '').slice(0, 4),
        releaseDate: m.releaseDate || '',

        overview:
          m.longDescription ||
          m.shortDescription ||
          '',

        genres: m.primaryGenreName
          ? [m.primaryGenreName]
          : [],

        genreIds: [],

        poster: m.artworkUrl100
          ? m.artworkUrl100.replace(
              '/100x100bb.jpg',
              '/600x600bb.jpg'
            )
          : null,

        rating: null,
        trailerUrl: m.previewUrl || null,
        storeUrl: m.trackViewUrl || null,
        artist: m.artistName || null,
        source: 'iTunes',
      })).filter(m => m.title);

      return {
        page,
        perPage: 20,
        totalPages: Math.max(
          1,
          Math.ceil(results.length / 20)
        ),
        totalResults: results.length,
        results,
        source: 'itunes-proxy',
      };
    },
  },
};

// ============================================================
// TORRENT ADAPTERS
// ============================================================

export const torrentAdapters = {
  // ----------------------------------------------------------
  // YTS
  // Keyless provider. Availability depends on the upstream API.
  // ----------------------------------------------------------

  yts: {
    async search(cfg, q, page = 1) {
      const params = new URLSearchParams({
        query_term: q,
        page: String(page),
        limit: '50',
        sort_by: 'seeds',
      });

      const data = await fetchJSON(
        'https://yts.mx/api/v2/list_movies.json?' +
        params.toString()
      );

      if (
        data.status &&
        data.status !== 'ok'
      ) {
        throw new Error(
          data.status_message ||
          'YTS API returned an unsuccessful response'
        );
      }

      const movies =
        data?.data?.movies || [];

      const torrents = [];

      for (const m of movies) {
        for (const t of (m.torrents || [])) {
          if (!t.hash) continue;

          const title = [
            m.title || '',
            m.year ? '(' + m.year + ')' : '',
            t.quality || '',
          ].filter(Boolean).join(' ');

          const magnetParams = new URLSearchParams({
            xt: 'urn:btih:' + t.hash,
            dn: (m.title || 'Movie') +
              ' ' + (t.quality || ''),
            tr: 'udp://tracker.opentrackr.org:1337/announce',
          });

          torrents.push({
            title,
            movieTitle: m.title || '',
            year: m.year || null,

            quality: t.quality || '',
            resolution: t.quality || '',

            size: t.size || '',
            sizeBytes: 0,

            seeds: Number(t.seeds) || 0,
            peers: Number(t.peers) || 0,

            magnet:
              'magnet:?' + magnetParams.toString(),

            torrentUrl: t.url || null,
            infoHash: String(t.hash).toLowerCase(),
            source: 'YTS',
          });
        }
      }

      return {
        torrents,
        totalResults: torrents.length,
        provider: 'yts',
      };
    },
  },

  // ----------------------------------------------------------
  // JACKETT
  // Requires a reachable, configured Jackett instance.
  // ----------------------------------------------------------

  jackett: {
    async search(cfg, q, page = 1) {
      if (!cfg.jackettBase) {
        throw Object.assign(
          new Error(
            'JACKETT_BASE_URL not configured'
          ),
          { status: 500 }
        );
      }

      if (!cfg.jackettKey) {
        throw Object.assign(
          new Error(
            'JACKETT_API_KEY not configured'
          ),
          { status: 500 }
        );
      }

      const base = cfg.jackettBase.replace(/\/+$/, '');
      const indexer = cfg.jackettIndexer || 'all';

      const params = new URLSearchParams({
        apikey: cfg.jackettKey,
        t: 'movie',
        q,
        limit: '50',
        offset: String((page - 1) * 50),
      });

      const url =
        base +
        '/api/v2.0/indexers/' +
        encodeURIComponent(indexer) +
        '/results/torznab/api?' +
        params.toString();

      const xml = await fetchText(url);
      const torrents = [];

      const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;

      let match;

      while ((match = itemRe.exec(xml))) {
        const block = match[1];

        const tag = name => {
          const escaped = name.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
          );

          const re = new RegExp(
            '<' + escaped + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' +
            escaped + '\\s*>',
            'i'
          );

          const found = re.exec(block);

          return found
            ? decodeXml(found[1].trim())
            : null;
        };

        const attr = name => {
          const escaped = name.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
          );

          const re = new RegExp(
            '<torznab:attr\\b[^>]*\\bname="' +
            escaped +
            '"[^>]*\\bvalue="([^"]*)"[^>]*\\/?>',
            'i'
          );

          const found = re.exec(block);

          return found
            ? decodeXml(found[1])
            : null;
        };

        const title = tag('title') || '';
        const link = tag('link') || '';
        const guid = tag('guid') || '';

        const magnet =
          tag('magnetLink') ||
          (link.startsWith('magnet:?')
            ? link
            : null);

        const sizeBytes =
          Number(attr('size')) || 0;

        const resolution =
          attr('resolution') ||
          ((/(2160p|1080p|720p|480p)/i.exec(title) || [])[0]);

        const hashMatch = magnet
          ? /btih:([a-z0-9]{40}|[a-z0-9]{32})/i.exec(magnet)
          : null;

        torrents.push({
          title,

          quality: resolution || '',
          resolution: resolution || '',

          size: sizeBytes
            ? humanSize(sizeBytes)
            : '',

          sizeBytes,

          seeds: Number(attr('seeders')) || 0,
          peers: Number(attr('peers')) || 0,

          magnet,

          torrentUrl:
            link.startsWith('https://') ||
            link.startsWith('http://')
              ? link
              : (
                  guid.startsWith('https://') ||
                  guid.startsWith('http://')
                    ? guid
                    : null
                ),

          infoHash: hashMatch
            ? hashMatch[1].toLowerCase()
            : null,

          source:
            attr('jackettindexer') ||
            'Jackett',
        });
      }

      return {
        torrents,
        totalResults: torrents.length,
        provider: 'jackett',
      };
    },
  },

  // ----------------------------------------------------------
  // PROWLARR
  // Requires a reachable, configured Prowlarr instance.
  // ----------------------------------------------------------

  prowlarr: {
    async search(cfg, q, page = 1) {
      if (!cfg.prowlarrBase) {
        throw Object.assign(
          new Error(
            'PROWLARR_BASE_URL not configured'
          ),
          { status: 500 }
        );
      }

      if (!cfg.prowlarrKey) {
        throw Object.assign(
          new Error(
            'PROWLARR_API_KEY not configured'
          ),
          { status: 500 }
        );
      }

      const base = cfg.prowlarrBase.replace(/\/+$/, '');

      const params = new URLSearchParams({
        query: q,
        type: 'search',
        apikey: cfg.prowlarrKey,
      });

      // Prowlarr search API commonly returns an array.
      // The API does not guarantee that limit/offset are
      // supported as pagination parameters.
      const data = await fetchJSON(
        base + '/api/v1/search?' +
        params.toString()
      );

      const list = Array.isArray(data)
        ? data
        : [];

      const torrents = list.map(r => {
        const title = r.title || '';

        const magnet =
          r.magnetUrl ||
          r.magnetURL ||
          null;

        const hashMatch = magnet
          ? /btih:([a-z0-9]{40}|[a-z0-9]{32})/i.exec(magnet)
          : null;

        const infoHash =
          r.infoHash ||
          (hashMatch
            ? hashMatch[1].toLowerCase()
            : null);

        const sizeBytes =
          Number(r.size) || 0;

        const resolution =
          (/(2160p|1080p|720p|480p)/i.exec(title) || [])[0] ||
          '';

        return {
          title,

          quality: resolution,
          resolution,

          size: sizeBytes
            ? humanSize(sizeBytes)
            : '',

          sizeBytes,

          seeds: Number(r.seeders) || 0,
          peers: Number(r.leechers) || 0,

          magnet,

          torrentUrl:
            r.downloadUrl ||
            r.downloadURL ||
            null,

          infoHash,

          source:
            r.indexer ||
            r.indexerName ||
            'Prowlarr',
        };
      });

      return {
        torrents,
        totalResults: torrents.length,
        provider: 'prowlarr',
      };
    },
  },
};

// ============================================================
// ADAPTER LOOKUPS
// ============================================================

export function getMetadataAdapter(name) {
  const adapter = metadataAdapters[name];

  if (!adapter) {
    throw Object.assign(
      new Error(
        'Unknown metadata provider: ' + name
      ),
      { status: 500 }
    );
  }

  return adapter;
}

export function getTorrentAdapter(name) {
  const adapter = torrentAdapters[name];

  if (!adapter) {
    throw Object.assign(
      new Error(
        'Unknown torrent provider: ' + name
      ),
      { status: 500 }
    );
  }

  return adapter;
}

// ============================================================
// HTTP HELPERS
// ============================================================

async function fetchJSON(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CineXZone/1.0',
    },
  });

  if (response.status === 403) {
    throw Object.assign(
      new Error(
        'Provider refused this server-side request (HTTP 403).'
      ),
      { status: 502 }
    );
  }

  if (!response.ok) {
    throw Object.assign(
      new Error(
        'Upstream returned ' + response.status
      ),
      { status: 502 }
    );
  }

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(
      new Error('Upstream returned invalid JSON'),
      { status: 502 }
    );
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/xml, text/xml',
      'User-Agent': 'CineXZone/1.0',
    },
  });

  if (!response.ok) {
    throw Object.assign(
      new Error(
        'Upstream returned ' + response.status
      ),
      { status: 502 }
    );
  }

  return response.text();
}

// ============================================================
// HELPERS
// ============================================================

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    );
}

function humanSize(bytes) {
  const units = [
    'B',
    'KB',
    'MB',
    'GB',
    'TB',
  ];

  let index = 0;
  let size = Number(bytes) || 0;

  while (
    size >= 1024 &&
    index < units.length - 1
  ) {
    size /= 1024;
    index++;
  }

  return size.toFixed(1) + ' ' + units[index];
}
