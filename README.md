# CineWave

CineWave is a movie discovery website built with HTML, CSS, JavaScript,
Cloudflare Workers and TMDB.

## Features

- Responsive dark-theme UI
- TMDB movie search
- Movie posters, ratings, years and descriptions
- Genre labels
- Pagination
- Provider results modal
- YTS, Jackett, Prowlarr and disabled-provider options
- KV response caching
- Configurable request rate limiting
- Error handling and request timeouts
- Cloudflare Workers deployment

## Project structure

cinewave/
├── public/
│   └── index.html
├── worker.js
├── adapters.js
├── wrangler.toml
└── README.md

## Requirements

- Node.js and npm
- Cloudflare account
- TMDB API key or TMDB API Read Access Token

## 1. Install Wrangler

Run these commands inside the project directory:

    npm install -D wrangler
    npx wrangler login

## 2. Create the KV namespace

    npx wrangler kv namespace create CACHE

Copy the returned namespace ID into wrangler.toml.

## 3. Add TMDB credentials

For a TMDB API key:

    npx wrangler secret put TMDB_API_KEY

For a TMDB API Read Access Token instead:

    npx wrangler secret put TMDB_API_READ_TOKEN

Paste the credential when Wrangler prompts you.

Never commit credentials to GitHub.

## 4. Run locally

    npx wrangler dev

Open the local URL displayed by Wrangler.

## 5. Deploy

    npx wrangler deploy

Check wrangler.toml before deploying to make sure the Worker name is correct.

## Provider configuration

Set TORRENT_PROVIDER in wrangler.toml to one of:

- yts
- jackett
- prowlarr
- none

For Jackett, configure the JACKETT_URL and JACKETT_API_KEY secrets.

For Prowlarr, configure the PROWLARR_URL and PROWLARR_API_KEY secrets.

Provider endpoints must be reachable from the Cloudflare Worker.
Private localhost URLs on your phone or computer will not be reachable
from Cloudflare's servers.

Use third-party providers only for content you are authorized to access
and follow the relevant provider terms and copyright laws.

## Configuration

CACHE_TTL controls movie-search cache duration in seconds.

TORRENT_CACHE_TTL controls provider-results cache duration in seconds.

RATE_LIMIT_MAX controls the allowed requests per IP during each window.

RATE_LIMIT_WINDOW controls the rate-limit window in seconds.

These settings can be changed in wrangler.toml.
