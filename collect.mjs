import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {SOURCE, classify, collectSnapshot, flattenObservation, gate, peru} from './core.mjs';

mkdirSync('data/raw', {recursive: true});
mkdirSync('diagnostics', {recursive: true});

const history = existsSync('data/observations.jsonl')
  ? readFileSync('data/observations.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  : [];
const now = new Date();
const skip = gate(history, now);

if (process.argv.includes('--gate')) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `collect=${!skip}\n`);
  console.log(skip || 'Collection required');
  process.exit(0);
}

if (skip) {
  console.log(skip);
  process.exit(0);
}

const diagnostics = {startedAt: now.toISOString(), stage: 'requesting-public-api'};
let observation;
try {
  const snapshot = await collectSnapshot(now);
  diagnostics.stage = 'validating-inventory';
  const observedAt = new Date().toISOString();
  observation = {
    schemaVersion: 2,
    observedAt,
    source: SOURCE,
    ...snapshot,
    ...classify(snapshot, observedAt),
  };
  diagnostics.snapshot = snapshot;
} catch (error) {
  diagnostics.error = {name: error.name, message: error.message, stack: error.stack};
  observation = {
    schemaVersion: 2,
    observedAt: new Date().toISOString(),
    collectionDate: peru(new Date()).date,
    source: SOURCE,
    status: 'error',
    stopForDay: false,
    failedStage: diagnostics.stage,
    error: String(error.message),
  };
  console.error(`::error title=Ticket collection failed::${diagnostics.stage}: ${error.message.replace(/[\r\n]/g, ' ')}`);
} finally {
  diagnostics.finishedAt = new Date().toISOString();
  writeFileSync('diagnostics/collection.json', `${JSON.stringify(diagnostics, null, 2)}\n`);
}

const stamp = observation.observedAt.replace(/[:.]/g, '-');
observation.rawFile = `data/raw/${stamp}.json`;
writeFileSync(observation.rawFile, `${JSON.stringify(diagnostics.snapshot ?? diagnostics.error ?? {}, null, 2)}\n`);
appendFileSync('data/observations.jsonl', `${JSON.stringify(observation)}\n`);
history.push(observation);

const good = history.filter(item => item.status === 'ok');
const latest = good.at(-1);
const lines = [
  '# Machu Picchu ticket availability',
  '',
  `[Open dashboard](docs/index.html) · [Official availability page](${SOURCE})`,
  '',
  `Latest check: ${observation.observedAt} — ${observation.status}`,
  '',
  'Times in the history are UTC; collection days use Peru time.',
  '',
];

if (observation.status !== 'ok') {
  lines.push(
    `Failure stage: ${observation.failedStage || 'validation'}`,
    `Detail: ${observation.error}`,
    '',
    'For evidence, open the failed Actions run and download the collection-diagnostics artifact.',
    '',
  );
}

if (latest) {
  lines.push(
    `Ticket desk: **${latest.ticketDesk?.available ?? 'n/a'} remaining** of ${latest.ticketDesk?.capacity ?? 1000}`,
    '',
  );
  for (const day of latest.visitDates ?? [{visitDate: latest.visitDate, routes: latest.routes ?? []}]) {
    lines.push(
      `## Visit date ${day.visitDate}`,
      '',
      '| Route | Capacity | Sold | Remaining |',
      '|---|---:|---:|---:|',
      ...day.routes.map(route => `| ${route.route} | ${route.capacity} | ${route.sold} | ${route.available} |`),
      '',
    );
  }
}

lines.push(
  `Valid observations: ${good.length}. Errors: ${history.length - good.length}.`,
  '',
  'The first zero is an observation, not an exact sell-out time. No purchase probability is implied.',
  'Collection pauses for the Peru day only when every monitored route on both upcoming visit dates is sold out.',
  '',
  'Download history: [JSONL](data/observations.jsonl) · [CSV](data/observations.csv)',
);
writeFileSync('REPORT.md', `${lines.join('\n')}\n`);

const csv = ['observed_utc,collection_date,visit_date,status,route,route_name,capacity,sold,available'];
for (const item of history) {
  for (const row of flattenObservation(item)) {
    const cells = [row.observedAt, row.collectionDate, row.visitDate, row.status, row.route, row.name ?? '', row.capacity, row.sold, row.available];
    csv.push(cells.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(','));
  }
}
writeFileSync('data/observations.csv', `${csv.join('\n')}\n`);
writeFileSync('data/latest.json', `${JSON.stringify(observation, null, 2)}\n`);

const {buildSiteData} = await import('./build-site.mjs');
buildSiteData(history);

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
console.log(JSON.stringify(observation, null, 2));
if (observation.status !== 'ok') process.exitCode = 1;

