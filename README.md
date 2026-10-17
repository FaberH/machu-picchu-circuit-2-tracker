# Machu Picchu Circuit 2 tracker

[Latest results](REPORT.md) · [Download CSV](data/observations.csv) · [Full history](data/observations.jsonl) · [Collection runs](../../actions)

Tracks public in-person ticket availability for routes 2-A and 2-B at https://tuboleto.cultura.pe/cusco/1000boletos . Runs on GitHub independently of any laptop, without an AI subscription or ticket account.

## Schedule

GitHub starts a job every five minutes. A Peru-time gate performs live reads from 05:30 through 21:55, including exactly 06:00 when sales open, and skips the website outside that window. GitHub can delay or drop scheduled runs, so actual observation timestamps are saved. Pre-opening readings are tagged separately; zeros before 06:00 never pause collection. Once both routes are confirmed at zero during sales, subsequent jobs skip the website for the rest of the Peru day. Collection resumes the following morning. A second page load confirms all-zero counts. Stale dates and errors never trigger the pause. Restocks after the daily pause are unobserved.

Collection stops contacting the source after December 31, 2026. Disable the workflow in Actions afterward to stop lightweight scheduled jobs. GitHub may disable schedules after 60 days without repository activity; inspect Actions periodically.

## Results

REPORT.md shows the latest valid counts and collection status. CSV and JSONL contain UTC observation time, Peru collection date, displayed visit date, route capacity, sold and remaining counts. Raw page text is retained under data/raw. Filter status to ok for analysis; failed reads are never treated as zero.

A first observation at zero does not identify the sell-out time. Route totals do not guarantee queue access, a shared entry time or purchase success. Forecasts need validated history and sufficient coverage.

## Run and test

Requires Node 22. Install with npm ci, run tests with npm test, install Chromium with npx playwright install chromium, then collect with npm run collect. The same daily stop and time-window rules apply locally.

To trigger a cloud check: Actions > Collect Circuit 2 tickets > Run workflow. The workflow uses the repository-scoped GitHub token to commit public observations. No secrets are required.

## If collection fails

Open the failed run in Actions. Named steps separate setup, tests, reading tickets and saving data. Collection errors identify their stage and original cause. Download the collection-diagnostics artifact from the run summary within seven days: it includes diagnostics/collection.json, network/browser errors, the last parsing error, page text, HTML and a screenshot where available. A browser-launch failure cannot provide a page screenshot. If saving to GitHub fails, the artifact retains collected data.

The 13 tests include simulated network errors, HTTP failures, missing route cards, malformed layouts, loading placeholders, unstable counts, conflicting zero confirmations and evidence-capture failures, alongside date and stop rules.

For a controlled test, select the diagnostic_drill checkbox under Run workflow. This loads an offline broken-page fixture, saves evidence under diagnostic-drill/ and intentionally fails. It never contacts the ticket website or commits fake ticket readings. Scheduled runs keep this option off.

A job GitHub never starts has no logs or screenshot: inspect missing scheduled runs separately. Tests and diagnostics help locate failures, but cannot guarantee the root cause of every upstream outage.
