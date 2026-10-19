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

GitHub asks for a run every five minutes. A Peru-time gate permits live reads from 06:00 through 21:55, then resumes at 06:00 the following Peru day. Collection pauses for the rest of a day only after every route on both monitored visit dates has reached zero. A new Peru day always resumes collection.

GitHub Actions schedules are best-effort and may be delayed or skipped; the tracker never invents missing five-minute samples. If exact five-minute cadence is essential, run `node collect.mjs` from an always-on scheduler instead of relying on GitHub's shared scheduler.

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

## GitHub Pages

The `Publish ticket dashboard` workflow deploys `docs/` using GitHub's official Pages actions. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions** once if Pages has not previously been enabled.

## Interpretation limits

A first zero only proves that the route was sold out at that sample; it cannot reveal the exact sell-out second. Counts do not guarantee that a ticket remains available through checkout. Lines between samples are visual guides. Missing timestamps indicate missing runs, not unchanged inventory. This project is not affiliated with Peru's Ministry of Culture.

