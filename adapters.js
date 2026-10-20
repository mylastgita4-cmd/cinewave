// =====================================================================
// Adapter.js  ->  paste these 2 methods INSIDE `metadataAdapters.tmdb`,
// right after the existing `async search(...) { ... },` method
// (before the closing `},` of `tmdb: {`).
// Nothing else in Adapter.js needs to change.
// =====================================================================

    // All seasons of a TV series
    async seasons(cfg, id) {
      if (!cfg.tmdbApiKey) {
        throw Object.assign(new Error('TMDB_API_KEY not set'), { status: 500 });
      }
      const tvId = String(id || '').replace(/\D/g, '');
      if (!tvId) throw Object.assign(new Error('Missing id'), { status: 400 });

      const params = new URLSearchParams({ api_key: cfg.tmdbApiKey, language: 'en-US' });
      const data = await fetchJSON(
        'https://api.themoviedb.org/3/tv/' + tvId + '?' + params.toString()
      );

      return {
        id: tvId,
        seasons: (data.seasons || []).map(s => ({
          season_number: s.season_number,
          name: s.name || '',
          episode_count: s.episode_count || 0,
          air_date: s.air_date || '',
        })),
      };
    },

    // All episodes of one season (name, air date, runtime)
    async season(cfg, id, seasonNumber) {
      if (!cfg.tmdbApiKey) {
        throw Object.assign(new Error('TMDB_API_KEY not set'), { status: 500 });
      }
      const tvId = String(id || '').replace(/\D/g, '');
      const sn = String(seasonNumber == null ? '' : seasonNumber).replace(/\D/g, '');
      if (!tvId || sn === '') throw Object.assign(new Error('Missing id/season'), { status: 400 });

      const params = new URLSearchParams({ api_key: cfg.tmdbApiKey, language: 'en-US' });
      const data = await fetchJSON(
        'https://api.themoviedb.org/3/tv/' + tvId + '/season/' + sn + '?' + params.toString()
      );

      return {
        id: tvId,
        season: Number(sn),
        episodes: (data.episodes || []).map(e => ({
          episode_number: e.episode_number,
          name: e.name || '',
          air_date: e.air_date || '',
          runtime: e.runtime || null,
        })),
      };
    },
