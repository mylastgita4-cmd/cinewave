const TMDB_GENRES = {
  28: "Action",
  12: "Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  14: "Fantasy",
  36: "History",
  27: "Horror",
  10402: "Music",
  9648: "Mystery",
  10749: "Romance",
  878: "Science Fiction",
  10770: "TV Movie",
  53: "Thriller",
  10752: "War",
  37: "Western"
};

const TIMEOUT_MS = 12000;

function required(value, message) {
  if (!value || !String(value).trim()) {
    throw new Error(message);
  }

  return String(value).trim();
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    options.timeout || TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const error = new Error(
        `Provider returned HTTP ${response.status}.`
      );

      error.status = response.status === 429 ? 429 : 502;
      throw error;
    }

    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Provider request timed out.");
      timeoutError.status = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    options.timeout || TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/xml,text/xml,*/*",
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const error = new Error(
        `Provider returned HTTP ${response.status}.`
      );

      error.status = response.status === 429 ? 429 : 502;
      throw error;
    }

    return await response.text();
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Provider request timed out.");
      timeoutError.status = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------------- TMDB MOVIE SEARCH ---------------- */

async function fetchTMDB(path, params, env) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { accept: "application/json" };

  if (env.TMDB_API_READ_TOKEN) {
    headers.Authorization = `Bearer ${env.TMDB_API_READ_TOKEN}`;
  } else {
    url.searchParams.set(
      "api_key",
      required(
        env.TMDB_API_KEY,
        "TMDB_API_KEY secret is not configured."
      )
    );
  }

  return fetchJson(url.toString(), { headers });
}

const metadataAdapters = {
  tmdb: {
    async search({ query, page, env }) {
      const data = await fetchTMDB(
        "/search/movie",
        {
          query,
          page,
          include_adult: false
        },
        env
      );

      const results = (data.results || []).map(movie => ({
        id: String(movie.id),
        title: movie.title || movie.original_title || "Untitled",
        originalTitle: movie.original_title || "",
        year: movie.release_date
          ? movie.release_date.slice(0, 4)
          : "",
        releaseDate: movie.release_date || "",
        overview: movie.overview || "",
        poster: movie.poster_path || null,
        backdrop: movie.backdrop_path || null,
        rating: Number.isFinite(Number(movie.vote_average))
          ? Number(movie.vote_average)
          : null,
        genres: (movie.genre_ids || [])
          .map(id => TMDB_GENRES[id])
          .filter(Boolean),
        language: movie.original_language || ""
      }));

      return {
        page: data.page || page,
        totalPages: data.total_pages || 1,
        totalResults: data.total_results || results.length,
        results
      };
    }
  }
};

/* ---------------- TORRENT / PROVIDER HELPERS ---------------- */

function normalizeMagnet(hash, title, trackers = []) {
  if (!hash) return "";

  const cleanHash = String(hash).replace(/[^a-fA-F0-9]/g, "");

  if (cleanHash.length < 32) return "";

  const params = new URLSearchParams();

  params.set("dn", title || "Movie");

  for (const tracker of trackers) {
    params.append("tr", tracker);
  }

  return `magnet:?xt=urn:btih:${cleanHash}&${params.toString()}`;
}

function formatSize(bytes) {
  const number = Number(bytes);

  if (!Number.isFinite(number) || number <= 0) return "";

  const units = ["B", "KB", "MB", "GB", "TB"];

  const index = Math.min(
    Math.floor(Math.log(number) / Math.log(1024)),
    units.length - 1
  );

  return `${(number / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

/* ---------------- YTS ADAPTER ---------------- */

const ytsAdapter = {
  async search({ query, year }) {
    const url = new URL("https://yts.mx/api/v2/list_movies.json");

    url.searchParams.set("query_term", query);
    url.searchParams.set("limit", "20");

    if (year && /^\d{4}$/.test(year)) {
      url.searchParams.set("year", year);
    }

    const data = await fetchJson(url.toString());
    const movies = data?.data?.movies || [];
    const results = [];

    for (const movie of movies) {
      for (const torrent of movie.torrents || []) {
        results.push({
          title: `${movie.title} (${movie.year})`,
          year: movie.year,
          quality: torrent.quality || "",
          type: torrent.type || "",
          size: torrent.size || "",
          seeds: Number(torrent.seeds) || 0,
          peers: Number(torrent.peers) || 0,
          provider: "YTS",
          torrentUrl: torrent.url || "",
          magnet: normalizeMagnet(
            torrent.hash,
            movie.title,
            [
              "udp://open.demonii.com:1337/announce",
              "udp://tracker.openbittorrent.com:80/announce"
            ]
          )
        });
      }
    }

    return { provider: "yts", results };
  }
};

/* ---------------- JACKETT ADAPTER ---------------- */

function decodeXML(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseTorznab(xml, providerName) {
  const items = String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || [];

  return items.map(item => {
    function tag(name) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const match = item.match(
        new RegExp(
          `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`,
          "i"
        )
      );

      if (!match) return "";

      const value = match[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .trim();

      return decodeXML(value);
    }

    function attribute(name, attr) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const match = item.match(
        new RegExp(
          `<${escaped}\\b[^>]*\\b${attr}=["']([^"']*)["'][^>]*\\/?>`,
          "i"
        )
      );

      return match ? decodeXML(match[1]) : "";
    }

    const title = tag("title") || "Untitled result";
    const link = tag("link") || attribute("enclosure", "url");
    const magnet = /^magnet:\?/i.test(link) ? link : "";

    const seeders = Number(attribute("torznab:attr", "value")) || 0;

    return {
      title,
      provider: providerName,
      size: formatSize(Number(attribute("size", "value")) || 0),
      seeds: seeders,
      peers: Number(attribute("peers", "value")) || 0,
      torrentUrl: magnet ? "" : link,
      magnet
    };
  });
}

const jackettAdapter = {
  async search({ query, env }) {
    const base = required(
      env.JACKETT_URL,
      "Set JACKETT_URL in your Worker configuration."
    );

    const apiKey = required(
      env.JACKETT_API_KEY,
      "Set JACKETT_API_KEY as a Worker secret."
    );

    const url = new URL(
      "/api/v2.0/indexers/all/results/torznab/api",
      base
    );

    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("t", "movie");
    url.searchParams.set("q", query);

    const xml = await fetchText(url.toString());

    return {
      provider: "jackett",
      results: parseTorznab(xml, "Jackett")
    };
  }
};

/* ---------------- PROWLARR ADAPTER ---------------- */

const prowlarrAdapter = {
  async search({ query, env }) {
    const base = required(
      env.PROWLARR_URL,
      "Set PROWLARR_URL in your Worker configuration."
    );

    const apiKey = required(
      env.PROWLARR_API_KEY,
      "Set PROWLARR_API_KEY as a Worker secret."
    );

    const url = new URL("/api/v1/search", base);

    url.searchParams.set("query", query);
    url.searchParams.set("type", "movie");

    const data = await fetchJson(url.toString(), {
      headers: { "X-Api-Key": apiKey }
    });

    const results = (Array.isArray(data) ? data : []).map(item => ({
      title: item.title || "Untitled result",
      provider: item.indexer || "Prowlarr",
      size: formatSize(item.size),
      seeds: item.seeders ?? null,
      peers: item.leechers ?? null,
      torrentUrl: item.downloadUrl || item.link || "",
      magnet: item.magnetUrl ||
        (String(item.downloadUrl || "").startsWith("magnet:")
          ? item.downloadUrl
          : "")
    }));

    return { provider: "prowlarr", results };
  }
};

/* ---------------- PROVIDER SELECTION ---------------- */

const torrentAdapters = {
  yts: ytsAdapter,
  jackett: jackettAdapter,
  prowlarr: prowlarrAdapter,

  none: {
    async search() {
      return { provider: "none", results: [] };
    }
  }
};

export function getMetadataAdapter(env) {
  const name = String(env.METADATA_PROVIDER || "tmdb").toLowerCase();
  const adapter = metadataAdapters[name];

  if (!adapter) {
    throw new Error(`Unsupported metadata provider: ${name}`);
  }

  return adapter;
}

export function getTorrentAdapter(env) {
  const name = String(env.TORRENT_PROVIDER || "yts").toLowerCase();
  const adapter = torrentAdapters[name];

  if (!adapter) {
    throw new Error(
      `Unsupported provider: ${name}. Choose yts, jackett, prowlarr or none.`
    );
  }

  return adapter;
}
