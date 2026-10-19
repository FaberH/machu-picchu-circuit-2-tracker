import {readFileSync, writeFileSync} from 'node:fs';
import {flattenObservation, peru} from '../core.mjs';

const quote = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const integer = value => Number.isSafeInteger(Number(value)) ? String(Number(value)) : '0';
const history = readFileSync('data/observations.jsonl', 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(JSON.parse);

const sql = [];
for (const [index, observation] of history.entries()) {
  const observedAt = observation.observedAt;
  if (!observedAt) continue;
  const collectionDate = observation.collectionDate || peru(observedAt).date;
  const runId = `import-${index}-${observedAt}`;
  const desk = observation.ticketDesk || {};
  sql.push(
    `INSERT OR IGNORE INTO collection_runs
     (id, observed_at, collection_date, status, phase, stop_for_day,
      ticket_capacity, ticket_issued, ticket_available, error)
     VALUES (${quote(runId)}, ${quote(observedAt)}, ${quote(collectionDate)},
      ${quote(observation.status || 'ok')}, ${quote(observation.phase)}, ${observation.schemaVersion >= 2 && observation.stopForDay ? 1 : 0},
      ${desk.capacity == null ? 'NULL' : integer(desk.capacity)},
      ${desk.issued == null ? 'NULL' : integer(desk.issued)},
      ${desk.available == null ? 'NULL' : integer(desk.available)}, ${quote(observation.error)});`,
  );
  if (observation.status !== 'ok') continue;
  for (const row of flattenObservation(observation)) {
    sql.push(
      `INSERT OR IGNORE INTO route_observations
       (run_id, observed_at, collection_date, visit_date, route_id, route, name, circuit,
        capacity, sold, available)
       VALUES (${quote(runId)}, ${quote(row.observedAt)}, ${quote(row.collectionDate)},
        ${quote(row.visitDate)}, ${integer(row.id)}, ${quote(row.route)},
        ${quote(row.name || `Ruta ${row.route}`)}, ${quote(row.circuit || '')},
        ${integer(row.capacity)}, ${integer(row.sold)}, ${integer(row.available)});`,
    );
  }
}
writeFileSync('cloudflare/seed.sql', `${sql.join('\n')}\n`);
console.log(`Prepared ${history.length} historical collection runs for import.`);

