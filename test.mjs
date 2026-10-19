import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  classify,
  collectSnapshot,
  fetchRoutes,
  flattenObservation,
  gate,
  isSoldOut,
  normalizeRoutes,
  peru,
  signTimestamp,
  visitDatesFor,
} from './core.mjs';

const apiRows = [
  {nidRuta: 7, circuito: 'Circuito 1 - Panorámico', ruta: 'Ruta 1-A: Montaña Machupicchu', ncupo: 50, ncupoActual: 49},
  {nidRuta: 8, circuito: 'Circuito 1 - Panorámico', ruta: 'Ruta 1-B: Terraza superior', ncupo: 100, ncupoActual: 95},
  {nidRuta: 11, circuito: 'Circuito 2 - Circuito clásico', ruta: 'Ruta 2-A: Clásico Diseñada', ncupo: 600, ncupoActual: 144},
  {nidRuta: 12, circuito: 'Circuito 2 - Circuito clásico', ruta: 'Ruta 2-B: Terraza Inferior', ncupo: 100, ncupoActual: 28},
  {nidRuta: 13, circuito: 'Circuito 3 - Machupicchu realeza', ruta: 'Ruta 3-A: Montaña Waynapicchu', ncupo: 50, ncupoActual: 32},
  {nidRuta: 14, circuito: 'Circuito 3 - Machupicchu realeza', ruta: 'Ruta 3-B: Realeza diseñada', ncupo: 100, ncupoActual: 74},
];

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

test('Peru date and two monitored visit dates are stable around UTC midnight', () => {
  assert.deepEqual(peru('2026-10-17T02:07:00Z'), {date: '2026-10-16', hour: 21, minute: 7});
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(visitDatesFor('2026-10-19'), ['2026-10-20', '2026-10-21']);
});

test('public request signing matches the observed website request', () => {
  assert.equal(signTimestamp('1792428932364'), 'z6z2WkuJUGUFx1+5vje3Mm/CupMGBdSJZg7Hrs65SFU=');
});

test('normalizes all routes and derives sold counts', () => {
  const routes = normalizeRoutes(apiRows);
  assert.equal(routes.length, 6);
  assert.deepEqual(routes.find(route => route.route === '2-A'), {
    id: 11,
    route: '2-A',
    name: 'Ruta 2-A: Clásico Diseñada',
    circuit: 'Circuito 2 - Circuito clásico',
    capacity: 600,
    sold: 456,
    available: 144,
  });
});

test('rejects empty, duplicate, and impossible inventory', () => {
  assert.throws(() => normalizeRoutes([]), /no routes/);
  assert.throws(() => normalizeRoutes([...apiRows, apiRows[0]]), /duplicate/);
  assert.throws(() => normalizeRoutes([{...apiRows[0], ncupoActual: 51}]), /invalid totals/);
});

test('fetches server time then signs a public availability request', async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({url, options});
    if (url.endsWith('/tiempo-servidor')) return jsonResponse({tiempoServidor: 1792428932364});
    return jsonResponse(apiRows);
  };
  const routes = await fetchRoutes('2026-10-21', fakeFetch);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(routes[2].available, 144);
  assert.deepEqual(body, {
    lugar: 'llaqta_machupicchu',
    fecha: '2026-10-21',
    punto: 5,
    code: 'z6z2WkuJUGUFx1+5vje3Mm/CupMGBdSJZg7Hrs65SFU=',
    timestamp: '1792428932364',
  });
});

test('collects ticket-desk and both upcoming visit dates', async () => {
  const fakeFetch = async url => {
    if (url.includes('tickets-por-fecha')) return jsonResponse({code: 200, totalticket: 580, message: 'ok'});
    if (url.endsWith('/tiempo-servidor')) return jsonResponse({tiempoServidor: 1792428932364});
    return jsonResponse(apiRows);
  };
  const snapshot = await collectSnapshot('2026-10-19T16:00:00Z', fakeFetch);
  assert.deepEqual(snapshot.ticketDesk, {capacity: 1000, issued: 580, available: 420});
  assert.deepEqual(snapshot.visitDates.map(day => day.visitDate), ['2026-10-20', '2026-10-21']);
  assert.equal(snapshot.visitDates.every(day => day.routes.length === 6), true);
});

test('collection begins at 06:00 Peru and stops only after every route is zero', () => {
  assert.match(gate([], '2026-10-19T10:59:00Z'), /Outside/);
  assert.equal(gate([], '2026-10-19T11:00:00Z'), null);
  const zeroRows = normalizeRoutes(apiRows.map(row => ({...row, ncupoActual: 0})));
  const zero = {visitDates: [
    {visitDate: '2026-10-20', routes: zeroRows},
    {visitDate: '2026-10-21', routes: zeroRows},
  ]};
  assert.equal(isSoldOut(zero), true);
  assert.equal(classify(zero, '2026-10-19T11:00:00Z').stopForDay, true);
  const partial = structuredClone(zero);
  partial.visitDates[1].routes[0].available = 1;
  assert.equal(isSoldOut(partial), false);
  assert.equal(classify(partial, '2026-10-19T11:00:00Z').stopForDay, false);
  const history = [{...zero, schemaVersion: 2, observedAt: '2026-10-19T12:00:00Z', status: 'ok', stopForDay: true}];
  assert.match(gate(history, '2026-10-19T12:05:00Z'), /sold out/);
  assert.equal(gate(history, '2026-10-20T11:00:00Z'), null);
  assert.equal(gate([{...history[0], schemaVersion: undefined}], '2026-10-19T12:05:00Z'), null);
});

test('API failures and invalid server time are never converted to zero', async () => {
  await assert.rejects(fetchRoutes('2026-10-21', async () => jsonResponse({}, 503)), /HTTP 503/);
  await assert.rejects(fetchRoutes('2026-10-21', async () => jsonResponse({tiempoServidor: 'bad'})), /server time response is invalid/i);
});

test('flattens new and legacy observations for CSV and graphs', () => {
  const modern = {
    observedAt: '2026-10-19T16:00:00Z', collectionDate: '2026-10-19', status: 'ok',
    visitDates: [{visitDate: '2026-10-21', routes: normalizeRoutes(apiRows)}],
  };
  const legacy = {
    observedAt: '2026-10-18T16:00:00Z', collectionDate: '2026-10-18', status: 'ok', visitDate: '2026-10-19',
    routes: [{route: '2-A', capacity: 600, sold: 500, available: 100}],
  };
  assert.equal(flattenObservation(modern).length, 6);
  assert.equal(flattenObservation(legacy)[0].visitDate, '2026-10-19');
});

