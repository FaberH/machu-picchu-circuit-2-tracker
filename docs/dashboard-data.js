const minute = 60_000;
const zone = 'America/Lima';
const calendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
});
const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const exactClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const preciseClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23',
});
const shortDate = new Intl.DateTimeFormat('en-GB', {timeZone: zone, day: 'numeric', month: 'short'});
const fullDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: zone, day: 'numeric', month: 'short', year: 'numeric',
});
const visitDateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
});
const compactVisitDateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
});

export const peruDate = time => calendar.format(time);
export const peruMidnight = time => Date.parse(`${peruDate(time)}T00:00:00-05:00`);
export const peruClock = time => clock.format(time);
export const peruShortDate = time => shortDate.format(time);
export const peruTimestamp = (time, precise = false) => {
  const formatter = precise && time % 1000 ? preciseClock : exactClock;
  return `${fullDate.format(time)} · ${formatter.format(time)}`;
};
export const visitLabel = (date, compact = false) => (compact ? compactVisitDateFormat : visitDateFormat)
  .format(Date.parse(`${date}T00:00:00Z`));

export const routes = [
  {code: '2-A', name: 'Clásico Diseñada', color: '#17644e', dash: ''},
  {code: '2-B', name: 'Terraza Inferior', color: '#95501d', dash: '7 3'},
  {code: '1-A', name: 'Montaña Machupicchu', color: '#2d60a0', dash: '2 3'},
  {code: '1-B', name: 'Terraza Superior', color: '#934360', dash: '9 3 2 3'},
  {code: '3-A', name: 'Montaña Waynapicchu', color: '#596829', dash: '4 4'},
  {code: '3-B', name: 'Realeza Diseñada', color: '#684e9c', dash: '12 4'},
];

export const windows = [5, 15, 30];

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value));

export function availableDates(data) {
  const dates = data.dates ?? data.observations.map(row => row?.visitDate);
  return [...new Set(dates.filter(validDate))].sort();
}

export function defaultVisitDate(dates, now = Date.now()) {
  const today = peruDate(now);
  return dates.find(date => date >= today) ?? dates.at(-1) ?? null;
}

export function upcomingVisitDates(now = Date.now()) {
  const midnight = peruMidnight(now);
  return [1, 2].map(days => peruDate(midnight + days * 24 * 60 * minute));
}

export function preferredVisitDate(dates, comparison, now = Date.now()) {
  const upcoming = upcomingVisitDates(now);
  return upcoming.find(visitDate => {
    const record = comparison.get(visitDate);
    return record?.snapshot && freshness({...record, visitDate, now}).kind === 'fresh';
  }) ?? upcoming.find(visitDate => {
    const record = comparison.get(visitDate);
    return record?.snapshot && !record.failed;
  }) ?? defaultVisitDate(dates, now);
}

function cadence(time) {
  // Lima is UTC−05:00 year-round. Allow the opening cadence through the 08:00 tick.
  const hour = (new Date(time).getUTCHours() + 19) % 24;
  return hour >= 6 && hour < 8 ? minute : 5 * minute;
}

export function samplingGap(previous, next) {
  return next.index !== previous.index + 1 || next.time - previous.time > cadence(previous.time) * 1.5;
}

export function lowerBound(items, time, field = 'time') {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle][field] < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function summarize(points) {
  const first = points[0];
  const last = points.at(-1);
  const previous = points.at(-2);
  let firstZero = null;
  let largestDrop = null;
  let segmentStart = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    if (current.available === 0) firstZero ??= current;
    if (i === 0) continue;
    const before = points[i - 1];
    if (samplingGap(before, current)) {
      segmentStart = i;
      continue;
    }
    const change = current.available - before.available;
    if (change < (largestDrop?.change ?? 0)) largestDrop = {change, before, current};
  }
  const changes = windows.map(minutes => {
    const target = last.time - minutes * minute;
    let index = lowerBound(points, target);
    if (index > segmentStart && (index === points.length || target - points[index - 1].time <= points[index].time - target)) index--;
    const baseline = points[index];
    if (index < segmentStart || index >= points.length - 1
      || Math.abs(target - baseline.time) > cadence(baseline.time) / 2) return null;
    return {change: last.available - baseline.available, baseline, last};
  });
  return {first, last, previous, firstZero, largestDrop, changes};
}

function observationTime(row, visitDate) {
  if (!row || row.visitDate !== visitDate || !/^\d+-[A-Z]$/.test(row.route)
    || !Number.isSafeInteger(row.capacity) || row.capacity <= 0
    || !Number.isSafeInteger(row.available) || row.available < 0 || row.available > row.capacity) return NaN;
  return Date.parse(row.observedAt);
}

export function latestSnapshot(observations, visitDate) {
  let snapshot;
  for (const row of observations) {
    const time = observationTime(row, visitDate);
    if (!Number.isFinite(time) || (snapshot && time < snapshot.time)) continue;
    if (!snapshot || time > snapshot.time) snapshot = {time, routes: new Map()};
    snapshot.routes.set(row.route, row);
  }
  return snapshot;
}

export function buildHistory(observations, visitDate) {
  const byTime = new Map();
  for (const row of observations) {
    const time = observationTime(row, visitDate);
    if (!Number.isFinite(time)) continue;
    if (!byTime.has(time)) byTime.set(time, new Map());
    byTime.get(time).set(row.route, row);
  }
  const byRoute = new Map();
  const rows = [];
  const samples = [...byTime].sort(([a], [b]) => a - b).map(([time, records], index) => {
    const sample = {time, index, routes: new Map()};
    for (const [code, row] of records) {
      const point = {...row, time, index};
      sample.routes.set(code, point);
      if (!byRoute.has(code)) byRoute.set(code, []);
      byRoute.get(code).push(point);
      rows.push(point);
    }
    return sample;
  });
  const snapshot = samples.at(-1);
  const totals = {remaining: 0, soldOut: 0, observed: snapshot?.routes.size ?? 0};
  for (const row of snapshot?.routes.values() ?? []) {
    totals.remaining += row.available;
    totals.soldOut += Number(row.available === 0);
  }
  const stats = new Map([...byRoute].map(([code, points]) => [code, summarize(points)]));
  return {rows, samples, byRoute, snapshot, totals, stats};
}

export function rangeStart(range, latestTime) {
  if (range === 'all' || !Number.isFinite(latestTime)) return -Infinity;
  return range === 'day' ? peruMidnight(latestTime) : latestTime - Number(range) * minute;
}

export function freshness({visitDate, snapshot, latest, source, failed, loading, now = Date.now()}) {
  const time = snapshot?.time;
  const today = peruDate(now);
  const age = now - time;
  const runTime = Date.parse(latest?.observedAt);
  const result = (kind, label, detail) => ({kind, label, detail});
  if (failed && time != null && source === 'archive') {
    return result('error', 'Update failed', 'Showing the bundled archive. It may be older than the API data.');
  }
  if (failed) return result('error', 'Update failed', time == null
    ? 'The dashboard could not load observations. Try refreshing.'
    : 'The last loaded observation is shown below.');
  if (loading && time == null) return result('loading', 'Loading', 'Fetching observations for the visit date.');
  if (latest?.status === 'error' && (!visitDate || visitDate >= today) && (time == null || runTime >= time)) {
    return result('error', 'Collection failed', time == null
      ? 'The latest collection attempt failed. No successful observation is available for this date.'
      : 'The latest collection attempt failed. Showing the last successful observation.');
  }
  if (time == null) return result('empty', 'No observations', 'No successful observations are available for this date.');
  if (source === 'archive') return result('stale', 'Archive sample', 'The bundled history is shown. It may be older than the API data.');
  if (visitDate < today) return result('stale', 'Past visit date', 'Showing the final observation recorded for this date.');
  if (today > '2026-12-31') return result('stale', 'Collection ended', 'Showing the last recorded observation.');
  if (latest?.status === 'ok' && latest.stopForDay && latest.collectionDate === today && runTime >= time) {
    return result('stale', 'Collection paused', 'Both monitored dates reached zero in today’s collection.');
  }
  const localTime = peruClock(now);
  if (localTime < '06:00' || localTime >= '22:00') {
    return result('stale', 'Outside collection hours', 'Scheduled collection runs from 06:00 to 22:00 Peru time.');
  }
  if (age < -30_000 || age > cadence(time) * 2) {
    return result('stale', 'Stale sample', 'This observation is outside the expected update interval.');
  }
  return result('fresh', 'Fresh sample', 'Recently observed within the expected collection interval.');
}

export function csvForHistory(rows) {
  const columns = ['observedAt', 'collectionDate', 'visitDate', 'route', 'name', 'circuit', 'capacity', 'sold', 'available'];
  const cell = value => {
    let raw = String(value ?? '');
    if (/^[=+\-@\t\r\n]/.test(raw)) raw = `'${raw}`;
    return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
  };
  return [columns.join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\r\n') + '\r\n';
}
