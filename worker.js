import {
  getMetadataAdapter,
  getTorrentAdapter
} from "./adapters.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            ...JSON_HEADERS,
            "access-control-allow-methods": "GET, OPTIONS",
            "access-control-allow-headers": "Content-Type"
          }
        });
      }

      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }

      try {
        await enforceRateLimit(request, env);

        if (url.pathname === "/api/movies") {
          return json(await handleMovies(url, env, ctx));
        }

        if (url.pathname === "/api/torrents") {
          return json(await handleTorrents(url, env, ctx));
        }

        return json({ error: "API route not found" }, 404);
      } catch (error) {
        const status = error.status || 500;

        return json({
          error: status === 500
            ? "Something went wrong. Check Worker secrets and provider settings."
            : error.message
        }, status);
      }
    }

    // Serve index.html and other frontend assets through Cloudflare Assets.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("CineWave frontend assets are not configured.", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: JSON_HEADERS
  });
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);

  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, number))
    : fallback;
}

function cacheKey(prefix, value) {
  return `${prefix}:${encodeURIComponent(value.toLowerCase()).slice(0, 350)}`;
}

async function cacheGet(env, key) {
  if (!env.CACHE) return null;

  try {
    const entry = await env.CACHE.get(key, "json");

    if (!entry || typeof entry !== "object") return null;

    if (entry.exp && entry.exp < Date.now()) {
      await env.CACHE.delete(key);
      return null;
    }

    // Correctly unwrap the cached response.
    return Object.prototype.hasOwnProperty.call(entry, "value")
      ? entry.value
      : entry;
  } catch {
    return null;
  }
}

async function cachePut(env, key, value, ttl) {
  if (!env.CACHE || ttl <= 0) return;

  try {
    await env.CACHE.put(
      key,
      JSON.stringify({
        value,
        exp: Date.now() + ttl * 1000
      }),
      { expirationTtl: Math.max(60, ttl) }
    );
  } catch {
    // The API should still work if caching fails.
  }
}

async function enforceRateLimit(request, env) {
  if (!env.CACHE) return;

  const max = clampInt(env.RATE_LIMIT_MAX, 30, 1, 1000);
  const windowSec = clampInt(env.RATE_LIMIT_WINDOW, 60, 10, 3600);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const slot = Math.floor(Date.now() / (windowSec * 1000));
  const key = `rl:${ip}:${slot}`;

  const count = Number(await env.CACHE.get(key)) || 0;

  if (count >= max) {
    const error = new Error(
      "Rate limit reached. Wait a little and try again."
    );
    error.status = 429;
    throw error;
  }

  await env.CACHE.put(key, String(count + 1), {
    expirationTtl: windowSec + 5
  });
}

async function handleMovies(url, env, ctx) {
  const query = (url.searchParams.get("q") || "").trim();
  const page = clampInt(url.searchParams.get("page"), 1, 1, 500);

  if (!query) {
    const error = new Error("Please enter a movie title.");
    error.status = 400;
    throw error;
  }

  if (query.length > 120) {
    const error = new Error("Search query is too long.");
    error.status = 400;
    throw error;
  }

  const provider = env.METADATA_PROVIDER || "tmdb";
  const key = cacheKey("movies", `${provider}:${page}:${query}`);
  const cached = await cacheGet(env, key);

  if (cached) return cached;

  const adapter = getMetadataAdapter(env);
  const result = await adapter.search({ query, page, env });

  const ttl = clampInt(env.CACHE_TTL, 3600, 0, 86400);
  const write = cachePut(env, key, result, ttl);

  if (ctx?.waitUntil) ctx.waitUntil(write);
  else await write;

  return result;
}

async function handleTorrents(url, env, ctx) {
  const query = (url.searchParams.get("q") || "").trim();
  const year = (url.searchParams.get("year") || "").trim();

  if (!query) {
    const error = new Error("A movie title is required.");
    error.status = 400;
    throw error;
  }

  if (query.length > 120) {
    const error = new Error("Search query is too long.");
    error.status = 400;
    throw error;
  }

  const provider = env.TORRENT_PROVIDER || "yts";
  const key = cacheKey("providers", `${provider}:${year}:${query}`);
  const cached = await cacheGet(env, key);

  if (cached) return cached;

  const adapter = getTorrentAdapter(env);
  const result = await adapter.search({ query, year, env });

  const ttl = clampInt(env.TORRENT_CACHE_TTL, 900, 0, 86400);
  const write = cachePut(env, key, result, ttl);

  if (ctx?.waitUntil) ctx.waitUntil(write);
  else await write;

  return result;
}
