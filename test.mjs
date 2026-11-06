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
import {
  availableDates, buildHistory, csvForHistory, defaultVisitDate, freshness, peruTimestamp,
  rangeStart, samplingGap,
} from './docs/dashboard-data.js';
import {overnightBands, ticketAxis, timeTicks} from './docs/history-chart.js';

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

test('Cloudflare mode can keep route data when only the ticket-desk counter fails', async () => {
  const fakeFetch = async url => {
    if (url.includes('tickets-por-fecha')) return jsonResponse({}, 530);
    if (url.endsWith('/tiempo-servidor')) return jsonResponse({tiempoServidor: 1792428932364});
    return jsonResponse(apiRows);
  };
  const snapshot = await collectSnapshot('2026-10-19T16:00:00Z', fakeFetch, {ticketDeskRequired: false});
  assert.equal(snapshot.ticketDesk, null);
  assert.match(snapshot.warning, /HTTP 530/);
  assert.equal(snapshot.visitDates.flatMap(day => day.routes).length, 12);
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

const visitDate = '2026-11-07';
function dashboardRow(time, available, route = '2-A', date = visitDate) {
  return {
    observedAt: `2026-11-06T${time}Z`, collectionDate: '2026-11-06',
    visitDate: date, route, name: `Ruta ${route}`, circuit: 'Circuito 2',
    capacity: 600, sold: 600 - available, available,
  };
}

test('dashboard sorts visit dates and selects the closest date using the Peru calendar', () => {
  const dates = availableDates({dates: ['2026-11-08', '2026-11-05', '2026-11-06', '2026-11-06']});
  assert.deepEqual(dates, ['2026-11-05', '2026-11-06', '2026-11-08']);
  assert.equal(defaultVisitDate(dates, Date.parse('2026-11-07T04:59:00Z')), '2026-11-06');
  assert.equal(defaultVisitDate(dates, Date.parse('2026-11-07T05:00:00Z')), '2026-11-08');
  assert.equal(defaultVisitDate(dates, Date.parse('2026-11-09T05:00:00Z')), '2026-11-08');
  assert.equal(defaultVisitDate([], Date.parse('2026-11-07T05:00:00Z')), null);
});

test('dashboard totals use one snapshot and do not count missing routes as sold out', () => {
  const model = buildHistory([
    dashboardRow('11:01:00', 0),
    dashboardRow('11:00:00', 300),
    dashboardRow('11:00:00', 250, '2-B'),
    dashboardRow('11:01:00', 41, '1-A', '2026-11-08'),
    dashboardRow('11:01:00', -1, '1-B'),
  ], visitDate);
  assert.deepEqual(model.totals, {remaining: 0, soldOut: 1, observed: 1});
  assert.equal(model.snapshot.routes.has('2-B'), false);
  assert.equal(model.stats.get('2-A').previous.available, 300);
  assert.equal(model.stats.get('2-A').firstZero.observedAt, '2026-11-06T11:01:00Z');
  assert.equal(model.stats.get('2-B').last.available, 250);
});

test('history detects missed samples at either cadence and when a route is missing', () => {
  const point = (time, index) => ({time: Date.parse(`2026-11-06T${time}Z`), index});
  assert.equal(samplingGap(point('11:00:05', 0), point('11:01:17', 1)), false);
  assert.equal(samplingGap(point('11:00:05', 0), point('11:02:05', 1)), true);
  assert.equal(samplingGap(point('12:59:00', 0), point('13:00:00', 1)), false);
  assert.equal(samplingGap(point('13:00:00', 0), point('13:05:00', 1)), false);
  assert.equal(samplingGap(point('13:00:00', 0), point('13:10:00', 1)), true);
  assert.equal(samplingGap(point('13:00:00', 0), point('13:05:00', 2)), true);
});

test('short-window changes allow timing jitter and keep the sign of net availability changes', () => {
  const samples = [250, 240, 230, 240, 240, 231, 248].map((available, index) =>
    dashboardRow(`13:${String(index * 5).padStart(2, '0')}:${index === 6 ? '00' : '05'}`, available));
  const stats = buildHistory(samples, visitDate).stats.get('2-A');
  assert.deepEqual(stats.changes.map(change => change.change), [17, 8, -2]);
  assert.equal(stats.largestDrop.change, -10);
  assert.equal(stats.firstZero, null);
});

test('statistics exclude missing intervals and suppress short windows with inadequate history', () => {
  const samples = [
    dashboardRow('11:00:00', 600), dashboardRow('11:01:00', 500, '2-B'),
    dashboardRow('11:02:00', 30), dashboardRow('11:03:00', 5), dashboardRow('11:04:00', 0),
  ];
  const stats = buildHistory(samples, visitDate).stats.get('2-A');
  assert.equal(stats.largestDrop.change, -25);
  assert.deepEqual(stats.changes, [null, null, null]);
  const only = buildHistory([dashboardRow('11:00:00', 0)], visitDate).stats.get('2-A');
  assert.equal(only.largestDrop, null);
  assert.equal(only.first, only.last);
  assert.deepEqual(only.changes, [null, null, null]);
});

test('the latest-day range starts at the latest sample’s Lima midnight', () => {
  const newest = Date.parse('2026-11-06T11:04:00.257Z');
  assert.equal(rangeStart('day', newest), Date.parse('2026-11-06T05:00:00Z'));
  assert.equal(rangeStart('day', Date.parse('2026-11-07T04:59:00Z')), Date.parse('2026-11-06T05:00:00Z'));
  assert.equal(rangeStart('day'), -Infinity);
  assert.equal(rangeStart('30', newest), newest - 30 * 60_000);
  assert.equal(rangeStart('all', newest), -Infinity);
  assert.equal(peruTimestamp(newest, true), '6 Nov 2026 · 06:04:00.257');
});

test('history ticks preserve domain endpoints and use round local times between them', () => {
  const first = Date.parse('2026-11-04T11:01:00Z');
  const last = Date.parse('2026-11-06T02:55:00Z');
  const ticks = timeTicks(first, last, 1080);
  assert.equal(ticks[0], first);
  assert.equal(ticks.at(-1), last);
  assert.ok(ticks.length > 3);
  assert.ok(ticks.slice(1, -1).every(time => time % 3_600_000 === 0));
  assert.ok(timeTicks(first, last, 248).length < ticks.length);
  assert.deepEqual(timeTicks(first, first, 248), [first]);
});

test('overnight shading respects the Peru schedule, the domain, and actual samples', () => {
  const first = Date.parse('2026-11-04T11:00:00Z');
  const last = Date.parse('2026-11-05T11:03:00Z');
  const start = Date.parse('2026-11-05T03:00:00Z');
  const end = Date.parse('2026-11-05T11:00:00Z');
  const samples = [{time: first}, {time: end}, {time: last}];
  assert.deepEqual(overnightBands(samples, first, last), [[start, end]]);
  assert.deepEqual(overnightBands(samples, end - 3_600_000, last), [[end - 3_600_000, end]]);
  assert.deepEqual(overnightBands([{time: first}, {time: start + 60_000}, {time: last}], first, last), []);
});

test('ticket axes start at zero and keep the vertical scale tight to observed counts', () => {
  assert.deepEqual(ticketAxis(0), {step: 1, yTop: 1});
  assert.deepEqual(ticketAxis(600), {step: 200, yTop: 600});
  assert.deepEqual(ticketAxis(13), {step: 3, yTop: 15});
});

test('freshness is based on the selected observation, source, and collection state', () => {
  const snapshot = {time: Date.parse('2026-11-06T11:01:00Z')};
  const view = {visitDate, snapshot, source: 'api', now: Date.parse('2026-11-06T11:02:00Z')};
  assert.equal(freshness(view).kind, 'fresh');
  assert.equal(freshness({...view, now: Date.parse('2026-11-06T11:03:01Z')}).label, 'Stale sample');
  assert.equal(freshness({...view, source: 'archive'}).label, 'Archive sample');
  assert.equal(freshness({...view, failed: true}).label, 'Update failed');
  assert.equal(freshness({...view, visitDate: '2026-11-05'}).label, 'Past visit date');
  assert.equal(freshness({...view, snapshot: null}).kind, 'empty');
  assert.equal(freshness({...view, snapshot: null, loading: true}).kind, 'loading');
  const latest = {observedAt: '2026-11-06T11:02:00Z', collectionDate: '2026-11-06'};
  assert.equal(freshness({...view, latest: {...latest, status: 'error'}}).label, 'Collection failed');
  assert.equal(freshness({...view, snapshot: null, latest: {...latest, status: 'error'}}).label, 'Collection failed');
  assert.equal(freshness({...view, latest: {...latest, status: 'ok', stopForDay: true}}).label, 'Collection paused');
  assert.equal(freshness({...view, now: Date.parse('2026-11-07T03:00:00Z')}).label, 'Outside collection hours');
});

test('CSV exports only the selected history and quotes source text safely', () => {
  const model = buildHistory([
    {...dashboardRow('11:00:00', 14), name: 'Ruta 2-A, "Clásico"', circuit: '=1+1'},
    dashboardRow('11:00:00', 48, '2-A', '2026-11-08'),
  ], visitDate);
  const csv = csvForHistory(model.rows);
  assert.match(csv, /2026-11-07,2-A,"Ruta 2-A, ""Clásico""",'=1\+1,600,586,14\r\n$/);
  assert.doesNotMatch(csv, /2026-11-08/);
});

