# Machu Picchu ticket pulse

An independent public-data tracker and historical dashboard for the Ministry of Culture's [Machu Picchu availability page](https://tuboleto.cultura.pe/disponibilidad/llaqta_machupicchu).

[Open dashboard](https://faberh.github.io/machu-picchu-circuit-2-tracker/) · [Latest text report](REPORT.md) · [CSV history](data/observations.csv) · [JSONL history](data/observations.jsonl)

## What it records

Every scheduled run after 06:00 Peru time reads the same public JSON service used by the official page. It records:

- remaining, sold, and capacity for all six routes;
- both upcoming visit dates displayed by the official page;
- same-day ticket-desk turns issued and remaining;
- the actual UTC observation time and Peru collection date;
- explicit error observations instead of silently treating failures as zero.

The dashboard draws route-level history without third-party chart libraries. Old Circuit 2 observations remain readable and appear alongside the new six-route data.

## Collection behavior

Cloudflare asks the Worker to run every minute from 06:00 through 07:59 Peru time, then every five minutes from 08:00 through 21:55. Collection pauses for the rest of a day only after every route on both monitored visit dates has reached zero. A new Peru day always resumes collection.

Route observations are stored in a Cloudflare D1 database. The public dashboard requests only one visit date at a time, keeping the download small as the history grows. The old GitHub collector is disabled; GitHub now stores the code and hosts the dashboard, while Cloudflare performs the scheduled collection.

The separate same-day ticket-desk counter currently rejects Cloudflare requests with HTTP 530. This does not affect the six route counts or their graphs. Cloudflare records the warning and continues saving valid route availability.

Collection stops after December 31, 2026. Disable the workflow after that date to stop the remaining lightweight gate runs.

## Why the collector no longer uses a browser

The official page loads availability from a public API. The request uses the API's server timestamp and an HMAC-SHA256 signature whose key and algorithm are shipped in the public front-end bundle. The collector reproduces that public read only; it does not log in, solve a captcha, reserve tickets, or call purchase endpoints. Direct collection is faster and less sensitive to visual redesigns than parsing rendered text.

## Local verification

Use Node 22:

```sh
npm test
npm run build:site
npm run collect
```

`node collect.mjs --gate` checks the time window and daily stop state without accessing the source. A live collection uses only Node's built-in `fetch` and `crypto`; no dependencies or browser installation are required.

## Cloudflare

The Worker source is in `cloudflare/worker.mjs`, its database migration is in `cloudflare/migrations/`, and `wrangler.jsonc` contains the one-minute/five-minute schedule and D1 binding. The read-only endpoints are:

- `/api/health`
- `/api/data?visitDate=YYYY-MM-DD`
- `/api/observations.csv?visitDate=YYYY-MM-DD`

`/api/collect` is a protected maintenance endpoint and requires the `ADMIN_TOKEN` Worker secret.

## GitHub Pages

GitHub Pages still hosts the dashboard, while Cloudflare now supplies its live data. The `Publish ticket dashboard` workflow deploys `docs/` using GitHub's official Pages actions.

## Interpretation limits

A first zero only proves that the route was sold out at that sample; it cannot reveal the exact sell-out second. Counts do not guarantee that a ticket remains available through checkout. Lines between samples are visual guides. Missing timestamps indicate missing runs, not unchanged inventory. This project is not affiliated with Peru's Ministry of Culture.

