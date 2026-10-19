import {classify, collectSnapshot, flattenObservation, gate, peru, SOURCE} from '../core.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {'Content-Type': 'application/json; charset=utf-8', ...CORS},
});

function text(body, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, {headers: {'Content-Type': contentType, ...CORS}});
}

function runRow(run) {
  if (!run) return null;
  return {
    observedAt: run.observed_at,
    collectionDate: run.collection_date,
    status: run.status,
    phase: run.phase,
    stopForDay: Boolean(run.stop_for_day),
    error: run.error || undefined,
  };
}

function observationRow(row) {
  return {
    observedAt: row.observed_at,
    collectionDate: row.collection_date,
    visitDate: row.visit_date,
    route: row.route,
    name: row.name,
    circuit: row.circuit,
    capacity: row.capacity,
    sold: row.sold,
    available: row.available,
  };
}

function deskRow(run) {
  if (!run || run.ticket_capacity == null) return null;
  return {
    observedAt: run.observed_at,
    collectionDate: run.collection_date,
    capacity: run.ticket_capacity,
    issued: run.ticket_issued,
    available: run.ticket_available,
  };
}

export async function collectionGate(db, now) {
  const current = peru(now);
  const stopped = await db.prepare(
    `SELECT observed_at FROM collection_runs
     WHERE collection_date = ?1 AND status = 'ok' AND stop_for_day = 1
     ORDER BY observed_at DESC LIMIT 1`,
  ).bind(current.date).first();
  const history = stopped ? [{schemaVersion: 2, status: 'ok', stopForDay: true, observedAt: stopped.observed_at}] : [];
  return gate(history, now);
}

export async function runCollection(env, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const reason = await collectionGate(env.DB, now);
  if (reason) return {collected: false, reason};

  const observedAt = now.toISOString();
  const collectionDate = peru(now).date;
  const runId = crypto.randomUUID();
  try {
    const snapshot = await collectSnapshot(now, options.fetchImpl || fetch, {ticketDeskRequired: false});
    const status = classify(snapshot, now);
    const rows = flattenObservation({...snapshot, observedAt, ...status});
    const statements = [
      env.DB.prepare(
        `INSERT INTO collection_runs
         (id, scheduled_at, observed_at, collection_date, status, phase, stop_for_day,
          ticket_capacity, ticket_issued, ticket_available, error)
         VALUES (?1, ?2, ?3, ?4, 'ok', ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(
        runId,
        options.scheduledAt || null,
        observedAt,
        collectionDate,
        status.phase,
        status.stopForDay ? 1 : 0,
        snapshot.ticketDesk?.capacity ?? null,
        snapshot.ticketDesk?.issued ?? null,
        snapshot.ticketDesk?.available ?? null,
        snapshot.warning,
      ),
      ...rows.map(row => env.DB.prepare(
        `INSERT INTO route_observations
         (run_id, observed_at, collection_date, visit_date, route_id, route, name, circuit,
          capacity, sold, available)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(
        runId,
        row.observedAt,
        row.collectionDate,
        row.visitDate,
        row.id,
        row.route,
        row.name,
        row.circuit,
        row.capacity,
        row.sold,
        row.available,
      )),
    ];
    await env.DB.batch(statements);
    return {collected: true, observedAt, collectionDate, routes: rows.length, stopForDay: status.stopForDay};
  } catch (error) {
    await env.DB.prepare(
      `INSERT INTO collection_runs
       (id, scheduled_at, observed_at, collection_date, status, error)
       VALUES (?1, ?2, ?3, ?4, 'error', ?5)`,
    ).bind(runId, options.scheduledAt || null, observedAt, collectionDate, String(error?.message || error)).run();
    throw error;
  }
}

export async function dashboardData(db, requestedDate) {
  const datesResult = await db.prepare(
    'SELECT DISTINCT visit_date FROM route_observations ORDER BY visit_date DESC',
  ).all();
  const dates = datesResult.results.map(row => row.visit_date);
  const visitDate = requestedDate && dates.includes(requestedDate) ? requestedDate : dates[0];
  const observationsResult = visitDate
    ? await db.prepare(
      `SELECT observed_at, collection_date, visit_date, route, name, circuit, capacity, sold, available
       FROM route_observations WHERE visit_date = ?1 ORDER BY observed_at, route`,
    ).bind(visitDate).all()
    : {results: []};
  const latestRun = await db.prepare(
    `SELECT observed_at, collection_date, status, phase, stop_for_day, error,
            ticket_capacity, ticket_issued, ticket_available
     FROM collection_runs ORDER BY observed_at DESC LIMIT 1`,
  ).first();
  return {
    generatedAt: new Date().toISOString(),
    latest: runRow(latestRun),
    dates,
    selectedDate: visitDate || null,
    observations: observationsResult.results.map(observationRow),
    desk: [deskRow(latestRun)].filter(Boolean),
  };
}

function csvCell(value) {
  const raw = String(value ?? '');
  return /[",\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

export async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: CORS});
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/api/collect') {
    const expected = env.ADMIN_TOKEN ? `Bearer ${env.ADMIN_TOKEN}` : '';
    if (!expected || request.headers.get('Authorization') !== expected) return json({error: 'Unauthorized'}, 401);
    try {
      return json(await runCollection(env));
    } catch (error) {
      return json({error: String(error?.message || error)}, 502);
    }
  }
  if (request.method !== 'GET') return json({error: 'Method not allowed'}, 405);
  if (url.pathname === '/api/data') {
    return json(await dashboardData(env.DB, url.searchParams.get('visitDate')));
  }
  if (url.pathname === '/api/health') {
    const latest = await env.DB.prepare(
      'SELECT observed_at, collection_date, status, error FROM collection_runs ORDER BY observed_at DESC LIMIT 1',
    ).first();
    return json({ok: latest?.status === 'ok', now: new Date().toISOString(), latest: runRow(latest), source: SOURCE});
  }
  if (url.pathname === '/api/observations.csv') {
    const data = await dashboardData(env.DB, url.searchParams.get('visitDate'));
    const columns = ['observedAt', 'collectionDate', 'visitDate', 'route', 'name', 'circuit', 'capacity', 'sold', 'available'];
    const lines = [columns.join(','), ...data.observations.map(row => columns.map(column => csvCell(row[column])).join(','))];
    return text(`${lines.join('\n')}\n`, 'text/csv; charset=utf-8');
  }
  if (url.pathname === '/') {
    return json({name: 'Machu Picchu ticket pulse API', dashboard: 'https://faberh.github.io/machu-picchu-circuit-2-tracker/', health: '/api/health'});
  }
  return json({error: 'Not found'}, 404);
}

export default {
  fetch: handleRequest,
  async scheduled(controller, env) {
    return runCollection(env, {
      scheduledAt: new Date(controller.scheduledTime).toISOString(),
    });
  },
};

