import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dashboardData, handleRequest, runCollection} from './worker.mjs';

const apiRows = [
  {nidRuta: 7, circuito: 'Circuito 1', ruta: 'Ruta 1-A: Montaña', ncupo: 50, ncupoActual: 49},
  {nidRuta: 8, circuito: 'Circuito 1', ruta: 'Ruta 1-B: Terraza', ncupo: 100, ncupoActual: 95},
  {nidRuta: 11, circuito: 'Circuito 2', ruta: 'Ruta 2-A: Clásico', ncupo: 600, ncupoActual: 144},
  {nidRuta: 12, circuito: 'Circuito 2', ruta: 'Ruta 2-B: Terraza', ncupo: 100, ncupoActual: 25},
  {nidRuta: 13, circuito: 'Circuito 3', ruta: 'Ruta 3-A: Waynapicchu', ncupo: 50, ncupoActual: 32},
  {nidRuta: 14, circuito: 'Circuito 3', ruta: 'Ruta 3-B: Realeza', ncupo: 100, ncupoActual: 74},
];

const jsonResponse = payload => ({ok: true, status: 200, json: async () => payload});

class MemoryStatement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (this.sql.includes("stop_for_day = 1")) {
      const match = this.db.runs.filter(row => row.collection_date === this.values[0] && row.status === 'ok' && row.stop_for_day).at(-1);
      return match ? {observed_at: match.observed_at} : null;
    }
    if (this.sql.includes('FROM collection_runs ORDER BY observed_at DESC')) return this.db.runs.at(-1) || null;
    throw new Error(`Unhandled first query: ${this.sql}`);
  }
  async all() {
    if (this.sql.startsWith('SELECT DISTINCT visit_date')) {
      return {results: [...new Set(this.db.observations.map(row => row.visit_date))].sort().reverse().map(visit_date => ({visit_date}))};
    }
    if (this.sql.includes('FROM route_observations WHERE visit_date')) {
      return {results: this.db.observations.filter(row => row.visit_date === this.values[0]).sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.route.localeCompare(b.route))};
    }
    throw new Error(`Unhandled all query: ${this.sql}`);
  }
  async run() {
    if (this.sql.startsWith('INSERT INTO collection_runs') && this.sql.includes("'ok'")) {
      const [id, scheduled_at, observed_at, collection_date, phase, stop_for_day, ticket_capacity, ticket_issued, ticket_available, error] = this.values;
      this.db.runs.push({id, scheduled_at, observed_at, collection_date, status: 'ok', phase, stop_for_day, ticket_capacity, ticket_issued, ticket_available, error});
      return {success: true};
    }
    if (this.sql.startsWith('INSERT INTO collection_runs')) {
      const [id, scheduled_at, observed_at, collection_date, error] = this.values;
      this.db.runs.push({id, scheduled_at, observed_at, collection_date, status: 'error', phase: null, stop_for_day: 0, error});
      return {success: true};
    }
    if (this.sql.startsWith('INSERT INTO route_observations')) {
      const [run_id, observed_at, collection_date, visit_date, route_id, route, name, circuit, capacity, sold, available] = this.values;
      this.db.observations.push({run_id, observed_at, collection_date, visit_date, route_id, route, name, circuit, capacity, sold, available});
      return {success: true};
    }
    throw new Error(`Unhandled run query: ${this.sql}`);
  }
}

class MemoryDb {
  constructor() { this.runs = []; this.observations = []; }
  prepare(sql) { return new MemoryStatement(this, sql); }
  async batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
}

function fakeFetch(url) {
  if (url.includes('tickets-por-fecha')) return jsonResponse({totalticket: 1000});
  if (url.endsWith('/tiempo-servidor')) return jsonResponse({tiempoServidor: 1792428932364});
  return jsonResponse(apiRows);
}

test('Cloudflare collection respects the Peru sales window', async () => {
  const db = new MemoryDb();
  const result = await runCollection({DB: db}, {now: '2026-10-19T10:59:00Z', fetchImpl: fakeFetch});
  assert.equal(result.collected, false);
  assert.match(result.reason, /Outside/);
  assert.equal(db.runs.length, 0);
});

test('Cloudflare collection stores one run and all twelve route rows', async () => {
  const db = new MemoryDb();
  const result = await runCollection({DB: db}, {
    now: '2026-10-19T16:00:00Z',
    scheduledAt: '2026-10-19T16:00:00Z',
    fetchImpl: fakeFetch,
  });
  assert.equal(result.collected, true);
  assert.equal(result.routes, 12);
  assert.equal(db.runs.length, 1);
  assert.equal(db.observations.length, 12);
  assert.equal(db.observations.find(row => row.visit_date === '2026-10-21' && row.route === '2-A').available, 144);
});

test('dashboard API returns one selected visit date and public CORS headers', async () => {
  const db = new MemoryDb();
  await runCollection({DB: db}, {now: '2026-10-19T16:00:00Z', fetchImpl: fakeFetch});
  const data = await dashboardData(db, '2026-10-20');
  assert.deepEqual(data.dates, ['2026-10-21', '2026-10-20']);
  assert.equal(data.observations.length, 6);
  assert.equal(data.selectedDate, '2026-10-20');
  const response = await handleRequest(new Request('https://tracker.example/api/data?visitDate=2026-10-20'), {DB: db});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await response.json()).observations.length, 6);
});

test('manual collection endpoint requires its private token', async () => {
  const db = new MemoryDb();
  const env = {DB: db, ADMIN_TOKEN: 'private-test-token'};
  const denied = await handleRequest(new Request('https://tracker.example/api/collect', {method: 'POST'}), env);
  assert.equal(denied.status, 401);
  assert.equal(db.runs.length, 0);
});

