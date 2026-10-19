import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {flattenObservation} from './core.mjs';

export function buildSiteData(history) {
  const observations = history
    .filter(item => item.status === 'ok')
    .flatMap(flattenObservation)
    .map(({observedAt, collectionDate, visitDate, route, name, circuit, capacity, sold, available}) => ({
      observedAt,
      collectionDate,
      visitDate,
      route,
      name: name || `Ruta ${route}`,
      circuit: circuit || `Circuito ${route?.split('-')[0] ?? ''}`.trim(),
      capacity,
      sold,
      available,
    }))
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));

  const desk = history
    .filter(item => item.status === 'ok' && item.ticketDesk)
    .map(item => ({observedAt: item.observedAt, collectionDate: item.collectionDate, ...item.ticketDesk}));
  const latest = history.filter(item => item.status === 'ok').at(-1) ?? null;

  mkdirSync('docs', {recursive: true});
  writeFileSync('docs/data.json', `${JSON.stringify({generatedAt: new Date().toISOString(), latest, observations, desk})}\n`);
  if (existsSync('data/observations.csv')) copyFileSync('data/observations.csv', 'docs/observations.csv');
  return {latest, observations, desk};
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  const history = existsSync('data/observations.jsonl')
    ? readFileSync('data/observations.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  const built = buildSiteData(history);
  console.log(`Built dashboard data with ${built.observations.length} route observations.`);
}

