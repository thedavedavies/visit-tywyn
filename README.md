# Visit Tywyn - Astro

Static rebuild of [visit-tywyn.co.uk](https://visit-tywyn.co.uk), migrated
from WordPress to Astro 6.

## Getting started

Requires Node 22.12+.

```bash
npm install
npm run dev
```

## Useful scripts

- `npm run refresh:conditions` - refresh `src/data/{weather,tides}.json` (skips sources fresher than ~2h45m; `FORCE_REFRESH=1` to override). `.github/workflows/refresh-conditions.yml` runs it every 30 min, which nets out to a ~3h refresh cadence plus automatic retries while an upstream is down. GitHub drops most of those cron ticks, so the Cloudflare Worker in `workers/refresh-trigger` dispatches the workflow on the same schedule (deployed by hand: `npx wrangler deploy --config workers/refresh-trigger/wrangler.toml`, plus a `GITHUB_TOKEN` secret, a fine-grained token with Actions write on this repo).
