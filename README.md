# CineX Zone

Movies & TV series discovery site on Cloudflare Workers.
Live address: **https://cinexzone.movie.workers.dev**

The address is built like this:

```
cinexzone  .  movie  .  workers.dev
   |            |
   |            +-- account subdomain (Cloudflare dashboard -> Workers & Pages -> Your subdomain -> Change)
   +-- worker name (name = "cinexzone" in wrangler.toml)
```

If `movie` is already taken by someone else, pick another subdomain
(letters, numbers and `-`, not starting or ending with `-`). The code does not
need to change, only the address does.

## Files

```
worker.js        API (movies, TV seasons, torrents, .torrent files, trailers)
adapters.js      TMDB / iTunes and torrent providers (Knaben, TPB, torrents-csv, YTS, Jackett, Prowlarr)
wrangler.toml    Worker name, settings and the KV binding
public/
  index.html     The whole website
```

`index.html` MUST stay inside the `public/` folder.

## Deploy (GitHub -> Cloudflare)

1. Keep this repo **Private**. Never commit API keys.
2. Cloudflare dashboard -> Workers & Pages -> Create -> Import a repository -> pick this repo.
3. Worker name: `cinexzone` (must be the same as `name` in `wrangler.toml`).
4. Worker -> Settings -> Variables and secrets -> add:
   - `TMDB_API_KEY` as **Secret** (needed for TV seasons and the "latest" lists)
   - optional: `PROWLARR_BASE_URL` (Variable) and `PROWLARR_API_KEY` (Secret)
5. Open the address and check `/api/health`.

Every `git push` to the main branch deploys automatically.

## Settings

Set in `wrangler.toml` (`[vars]`) or in the dashboard.

| Name | Default | What it does |
|---|---|---|
| `TORRENT_PROVIDER` | `knaben` | First torrent provider to ask |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` | `120` / `60` | Requests allowed per window for the whole site |
| `HOME_MAX_PAGES` | `10` | Pages (30 titles each) of the "latest" list |
| `HOME_MIN_VOTES` | `5` | Minimum TMDB votes for a title in the latest list (0 = show everything) |
| `TORRENT_DEADLINE_MS` | `14000` | Longest wait for slow torrent providers |
| `TORRENT_CACHE_URLS` | built-in list | Public `.torrent` caches, comma separated, `{HASH}` = info-hash |
| `YTS_MIRRORS` | built-in list | Extra YTS mirrors, comma separated |
| `ALLOWED_ORIGINS` | empty (any) | Comma separated origins allowed to call the API |
| `PROWLARR_BASE_URL`, `PROWLARR_API_KEY` | none | Self-hosted Prowlarr (extra results) |
| `JACKETT_BASE_URL`, `JACKETT_API_KEY` | none | Self-hosted Jackett |

## Notes

- Only releases that match the exact title (and year for movies) are shown.
- Use only content you have permission to download or share.
