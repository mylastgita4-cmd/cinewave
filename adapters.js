// ============================================================
// CineWave provider adapters.
// Documented endpoints only (none invented):
//   TMDB:   https://developer.themoviedb.org/reference/search-movie
//   iTunes: https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/
//   YTS:    https://yts.mx/api — currently offline (530/1016); torrents only,
//           homepage no longer depends on it.
// ============================================================

export const metadataAdapters = {
  tmdb: {
    async search(cfg, q, page) {
      if (!cfg.tmdbApiKey) {
        throw Object.assign(new Error('TMDB_API_KEY not set'), { status: 500 });
      }
      const data = await fetchJSON(
        'https://api.themoviedb.org/3/search/movie?api_key=' + cfg.tmdbApiKey +
        '&query=' + encodeURIComponent(q) + '&page=' + page + '&language=en-US'
      );
      return {
        page: data.page, perPage: 20,
        totalPages: data.total_pages, totalResults: data.total_results,
        results: (data.results || []).map(m => ({
          id: String(m.id), title: m.title,
          year: (m.release_date || '').slice(0, 4),
          releaseDate: m.release_date || '',
          overview: m.overview || '',
          poster: m.poster_path ? cfg.imageBase + m.poster_path : null,
          rating: m.vote_average,
          genres: [], genreIds: m.genre_ids || [],
          trailerUrl: null, storeUrl: null, source: 'TMDB',
        })),
        source: 'tmdb',
      };
    },
  },
  itunes: {
    async search(cfg, q, page) {
      const data = await fetchJSON(
        'https://itunes.apple.com/search?term=' + encodeURIComponent(q) +
        '&media=movie&entity=movie&limit=200&country=US'
      );
      const results = (data.results || []).map(m => ({
        id: m.trackId != null ? String(m.trackId) : m.trackName,
        title: m.trackName,
        year: (m.releaseDate || '').slice(0, 4),
        releaseDate: m.releaseDate || '',
        overview: m.longDescription || m.shortDescription || '',
        genres: m.primaryGenreName ? [m.primaryGenreName] : [],
        genreIds: [],
        poster: m.artworkUrl100
          ? m.artworkUrl100.replace('/100x100bb.jpg', '/600x600bb.jpg') : null,
        rating: null,
        trailerUrl: m.previewUrl || null,
        storeUrl: m.trackViewUrl || null,
        artist: m.artistName || null,
        source: 'iTunes',
      }));
      return {
        page: page, perPage: 20,
        totalPages: Math.max(1, Math.ceil(results.length / 20)),
        totalResults: results.length,
        results: results, source: 'itunes-proxy',
      };
    },
  },
};

export const torrentAdapters = {
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
            quality: t.quality, resolution: t.quality,
            size: t.size, sizeBytes: 0,
            seeds: t.seeds, peers: t.peers,
            magnet: 'magnet:?xt=urn:btih:' + t.hash +
              '&dn=' + encodeURIComponent(m.title + ' ' + t.quality) +
              '&tr=' + encodeURIComponent('udp://tracker.opentrackr.org:1337/announce'),
            torrentUrl: t.url || null,
            infoHash: (t.hash || '').toLowerCase(),
            source: 'YTS',
          });
        }
      }
      return { torrents: torrents, totalResults: torrents.length, provider: 'yts' };
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

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'CineWave/1.0' } });
  if (res.status === 403) {
    throw Object.assign(new Error(
      'Provider refused this server-side request (HTTP 403) — likely blocking datacenter IPs.'
    ), { status: 502 });
  }
  if (!res.ok) throw Object.assign(new Error('Upstream returned ' + res.status), { status: 502 });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { throw Object.assign(new Error('Upstream returned invalid data'), { status: 502 }); }
}
