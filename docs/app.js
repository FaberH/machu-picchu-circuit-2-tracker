import {
  availableDates, buildHistory, csvForHistory, freshness, latestSnapshot, peruClock, peruDate,
  peruShortDate, peruTimestamp, preferredVisitDate, routes, upcomingVisitDates, visitLabel, windows,
} from './dashboard-data.js';
import {createHistoryChart} from './history-chart.js';

const apiBase = String(window.TICKET_API_BASE || '').replace(/\/$/, '');
const refreshInterval = 60_000;
const pageSize = 24;
const number = new Intl.NumberFormat('en');
const percentage = new Intl.NumberFormat('en', {style: 'percent', maximumFractionDigits: 1});
const isCircuitTwo = code => code.startsWith('2-');
const presetRoutes = (items, preset) => items.map(route => route.code).filter(code => preset === 'all' || isCircuitTwo(code));
const $ = id => document.getElementById(id);
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
};
const put = (id, text) => {
  const element = $(id);
  if (element.textContent !== text) element.textContent = text;
};
const timestamp = (time, value = peruTimestamp(time)) => {
  const element = node('time', '', value);
  element.dateTime = new Date(time).toISOString();
  return element;
};
const signed = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${number.format(Math.abs(value))}`;

const state = {
  visitDate: null, explicitDate: false, dates: [], model: null, rows: [], source: '', latest: null, desk: null,
  failed: false, request: null, lastRequest: -Infinity, range: 'day',
  selected: new Set(presetRoutes(routes, 'circuit')),
  routes: [...routes], tablePage: 0, comparison: new Map(), comparisonFailed: false,
};

const comparisonColumns = [0, 1].map(() => $('comparison-date-template').content.firstElementChild.cloneNode(true));
$('comparison-dates').append(...comparisonColumns);

const chart = createHistoryChart({
  shell: $('chart-shell'), interaction: $('chart-interaction'), chart: $('chart'),
  tooltip: $('chart-tooltip'), empty: $('empty-chart'), count: $('sample-count'),
  description: $('chart-description'), announcement: $('chart-announcement'), gapKey: $('chart-gap-key'),
});

function status() {
  return freshness({
    visitDate: state.visitDate, snapshot: state.model?.snapshot, latest: state.latest,
    source: state.source, failed: state.failed, loading: Boolean(state.request),
  });
}

function renderStatus() {
  const current = status();
  $('status').dataset.kind = current.kind;
  put('status-badge', current.label);
  put('status-detail', current.detail);
  $('refresh').setAttribute('aria-disabled', String(Boolean(state.request)));
  $('refresh').classList.toggle('refreshing', Boolean(state.request));
}

function renderDates() {
  const select = $('visit-date');
  const dates = state.visitDate && !state.dates.includes(state.visitDate)
    ? [...state.dates, state.visitDate].sort()
    : state.dates;
  const today = peruDate(Date.now());
  const key = `${today}/${dates.join(',')}/${state.request && !dates.length ? 'loading' : ''}`;
  if (select.dataset.options !== key) {
    const upcoming = node('optgroup');
    upcoming.label = 'Today and upcoming';
    const past = node('optgroup');
    past.label = 'Past visit dates';
    for (const date of dates) {
      const option = new Option(visitLabel(date), date);
      if (date >= today) upcoming.append(option);
      else past.prepend(option);
    }
    const groups = [upcoming, past].filter(group => group.children.length);
    select.replaceChildren(...(groups.length ? groups : [new Option(state.request ? 'Loading dates…' : 'No visit dates', '')]));
    select.dataset.options = key;
  }
  select.disabled = !dates.length;
  select.value = state.visitDate ?? '';
  const dateLabel = state.visitDate ? visitLabel(state.visitDate) : '';
  put('circuit-selected-date', dateLabel || 'selected date');
  put('history-visit', dateLabel ? `Visit date · ${dateLabel}` : '');
  put('ledger-visit', dateLabel);
  const details = $('circuit-routes').parentElement;
  if (details.dataset.visitDate !== (state.visitDate ?? '')) {
    details.dataset.visitDate = state.visitDate ?? '';
    if (state.visitDate && !upcomingVisitDates().includes(state.visitDate)) details.open = true;
  }
}

function renderComparison() {
  const now = Date.now();
  for (const [index, date] of upcomingVisitDates(now).entries()) {
    const column = comparisonColumns[index];
    const get = selector => column.querySelector(selector);
    const record = state.comparison.get(date);
    const snapshot = record?.snapshot;
    const current = freshness({
      ...record, visitDate: date, now, failed: state.comparisonFailed || record?.failed,
      loading: Boolean(state.request && !record),
    });
    const dateLabel = visitLabel(date);
    column.dataset.visitDate = date;
    const visit = get('.comparison-visit');
    visit.dateTime = date;
    visit.textContent = visitLabel(date, true);
    visit.title = dateLabel;
    get('.comparison-status').dataset.kind = current.kind;
    get('.status-badge').textContent = current.label;
    const observed = get('.comparison-time time');
    observed.hidden = !snapshot;
    observed.nextElementSibling.hidden = !snapshot;
    const noTime = get('.comparison-no-time');
    noTime.hidden = Boolean(snapshot);
    noTime.textContent = current.kind === 'loading' ? 'Checking availability…' : 'No sample time';
    if (snapshot) {
      observed.dateTime = new Date(snapshot.time).toISOString();
      observed.title = `${peruTimestamp(snapshot.time, true)} Peru time`;
      observed.textContent = `${peruShortDate(snapshot.time)} · ${peruClock(snapshot.time)}`;
    }
    for (const row of column.querySelectorAll('[data-route]')) {
      const available = snapshot?.routes.get(row.dataset.route)?.available;
      row.classList.toggle('sold-out', available === 0);
      row.querySelector('strong').textContent = available == null ? '—' : number.format(available);
      row.querySelector('dd span').textContent = available == null ? 'No sample' : available === 0 ? 'Sold out' : 'left';
    }
    const history = get('.comparison-history');
    history.disabled = !snapshot;
    history.setAttribute('aria-label', `View Circuit 2 history for ${dateLabel}`);
  }
}

function renderOverview() {
  const {snapshot, totals, stats} = state.model ?? {};
  put('summary-remaining', snapshot ? number.format(totals.remaining) : '—');
  put('summary-coverage', snapshot ? `Across ${totals.observed} of ${state.routes.length} tracked routes` : 'Across observed routes');
  put('summary-sold-out', snapshot ? `${totals.soldOut} / ${totals.observed}` : '—');
  $('summary-time').replaceChildren(snapshot ? timestamp(snapshot.time) : '—');

  const circuit = document.createDocumentFragment();
  const other = document.createDocumentFragment();
  for (const route of state.routes) {
    const row = snapshot?.routes.get(route.code);
    const featured = isCircuitTwo(route.code);
    const soldOut = row?.available === 0;
    const card = node('article', 'route-card');
    card.classList.toggle('sold-out', soldOut);
    const name = typeof row?.name === 'string' ? row.name.replace(/^Ruta\s+[0-9]+-[A-Z]:?\s*/i, '') : '';
    const identity = node('h3', 'route-identity');
    identity.append(node('span', 'route-code', route.code), node('span', 'route-name', name || route.name));
    const inventory = node('div', 'inventory');
    inventory.append(node('strong', 'route-number', row ? number.format(row.available) : '—'));
    inventory.append(node('span', 'inventory-label', soldOut ? 'Sold out' : row ? 'left' : 'No sample'));

    const capacity = node('div', 'route-capacity');
    const meter = node('div', 'meter');
    meter.setAttribute('aria-hidden', 'true');
    const fill = node('span');
    if (row) fill.style.width = `${100 * row.available / row.capacity}%`;
    meter.append(fill);
    const meta = node('div', 'route-meta');
    if (row) {
      const fraction = row.available / row.capacity;
      const percentLabel = fraction > 0 && fraction < .001 ? '<0.1%'
        : fraction > .999 && fraction < 1 ? '>99.9%' : percentage.format(fraction);
      meta.append(node('span', '', percentLabel), node('span', '', `of ${number.format(row.capacity)}`));
    }
    capacity.append(meter, meta);
    const delta = node('p', 'route-delta');
    const before = stats?.get(route.code)?.previous;
    if (row && before) {
      const change = row.available - before.available;
      const value = node('strong', change < 0 ? 'down' : change > 0 ? 'up' : '', change ? signed(change) : featured ? 'No change' : '0');
      delta.append(value);
      if (featured && change) delta.append(' vs previous');
      delta.title = `Previous sample at ${peruTimestamp(before.time)} Peru time`;
    } else {
      if (!featured) delta.append(node('span', '', '—'), node('span', 'sr-only', 'Change unavailable'));
      else delta.textContent = 'Change unavailable';
    }
    card.append(identity, inventory, capacity, delta);
    (featured ? circuit : other).append(card);
  }
  $('circuit-routes').replaceChildren(circuit);
  $('route-cards').replaceChildren(other);
}

function renderDesk() {
  const desk = state.desk;
  $('desk').hidden = !desk;
  if (desk) {
    put('desk', `Separate same-day ticket desk · ${number.format(desk.available)} of ${number.format(desk.capacity)} turns remaining · observed ${peruTimestamp(Date.parse(desk.observedAt))} Peru time`);
  }
}

function renderRouteControls() {
  const filters = $('route-filters');
  const key = state.routes.map(route => route.code).join(',');
  if (filters.dataset.routes === key) return;
  filters.dataset.routes = key;
  filters.replaceChildren(...state.routes.map(route => {
    const button = node('button', 'route-filter', route.code);
    button.type = 'button';
    button.dataset.route = route.code;
    button.setAttribute('aria-label', `Route ${route.code}`);
    button.title = 'Toggle route. Shift-click to show only this route.';
    const swatch = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    swatch.setAttribute('viewBox', '0 0 18 6');
    swatch.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(swatch.namespaceURI, 'path');
    line.setAttribute('d', 'M1 3H17');
    line.setAttribute('stroke', route.color);
    line.setAttribute('stroke-width', '2');
    if (route.dash) line.setAttribute('stroke-dasharray', route.dash);
    swatch.append(line);
    button.prepend(swatch);
    return button;
  }));
  for (const [id, label] of [['insight-route', null], ['table-route', 'All routes']]) {
    const select = $(id);
    const previous = select.value;
    const options = state.routes.map(route => new Option(`Route ${route.code}`, route.code));
    if (label) options.unshift(new Option(label, ''));
    select.replaceChildren(...options);
    if (options.some(option => option.value === previous)) select.value = previous;
  }
}

function historyMessage() {
  if (state.model?.snapshot) return '';
  if (state.request && !state.failed && !state.model) return 'Loading observations…';
  if (status().kind === 'error') return 'Observations could not be loaded.';
  return 'No observations for this visit date.';
}

function presetIsSelected(preset) {
  const codes = presetRoutes(state.routes, preset);
  return state.selected.size === codes.length && codes.every(code => state.selected.has(code));
}

function renderChart() {
  for (const button of $('route-filters').children) {
    button.setAttribute('aria-pressed', String(state.selected.has(button.dataset.route)));
  }
  for (const button of $('chart-routes').querySelectorAll('[data-preset]')) {
    button.setAttribute('aria-pressed', String(presetIsSelected(button.dataset.preset)));
  }
  for (const button of document.querySelectorAll('[data-range]')) {
    button.setAttribute('aria-pressed', String(button.dataset.range === state.range));
  }
  chart.update({
    model: state.model, routes: state.routes, selected: state.selected, range: state.range, message: historyMessage(),
  });
}

function renderInsights() {
  const code = $('insight-route').value;
  const stats = state.model?.stats.get(code);
  $('empty-insights').hidden = Boolean(stats);
  $('insights').hidden = !stats;
  if (!stats) {
    put('empty-insights', historyMessage() || `No observations for route ${code} on this date.`);
    $('insights').replaceChildren();
    return;
  }
  const metric = (label, value, detail) => {
    const group = node('div', 'insight');
    group.append(node('dt', '', label), node('dd', '', value));
    if (detail) {
      const note = node('dd', 'metric-note');
      note.append(detail);
      group.append(note);
    }
    return group;
  };
  const {first, last, largestDrop, firstZero, changes} = stats;
  const observed = [metric('First observed', number.format(first.available), timestamp(first.time))];
  if (first !== last) observed.push(metric('Most recent', number.format(last.available), timestamp(last.time)));
  if (largestDrop) {
    const detail = document.createDocumentFragment();
    detail.append(timestamp(largestDrop.before.time), ' to ', timestamp(largestDrop.current.time));
    observed.push(metric('Largest sampled decrease', signed(largestDrop.change), detail));
  }
  if (firstZero) observed.push(metric('First observed sold out', '0 remaining', timestamp(firstZero.time)));
  const changesByWindow = changes.flatMap((change, index) => {
    if (!change) return [];
    const detail = document.createDocumentFragment();
    detail.append(timestamp(change.baseline.time), ' to ', timestamp(change.last.time));
    return [metric(`${windows[index]} min net change`, signed(change.change), detail)];
  });
  $('insights').replaceChildren(...observed, ...changesByWindow);
}

function renderTable() {
  const code = $('table-route').value;
  const rows = (code ? state.model?.byRoute.get(code) : state.model?.rows) ?? [];
  const pages = Math.ceil(rows.length / pageSize);
  state.tablePage = Math.min(state.tablePage, Math.max(0, pages - 1));
  const start = state.tablePage * pageSize;
  const end = Math.min(start + pageSize, rows.length);
  const page = rows.slice(rows.length - end, rows.length - start).reverse();
  $('history-body').replaceChildren(...page.map(row => {
    const tr = node('tr');
    const time = node('td');
    time.append(timestamp(row.time));
    tr.append(time, node('td', '', row.route), node('td', '', number.format(row.available)),
      node('td', '', number.format(row.capacity)), node('td', '', Number.isSafeInteger(row.sold) ? number.format(row.sold) : '—'));
    return tr;
  }));
  $('table-wrap').hidden = !rows.length;
  $('table-pagination').hidden = !rows.length;
  $('empty-table').hidden = Boolean(rows.length);
  if (!rows.length) put('empty-table', historyMessage() || 'No observations match the route filter.');
  put('table-count', rows.length ? `${number.format(start + 1)}–${number.format(end)} of ${number.format(rows.length)} observations` : '');
  $('prev-page').disabled = state.tablePage === 0;
  $('next-page').disabled = state.tablePage + 1 >= pages;
  $('download-csv').disabled = !state.model?.rows.length;
}

function renderData() {
  renderRouteControls();
  renderOverview();
  renderChart();
  renderInsights();
  renderTable();
}

const rowFields = ['observedAt', 'route', 'name', 'circuit', 'collectionDate', 'capacity', 'sold', 'available'];

function applyData(data, date, source) {
  const rows = data.observations.filter(row => row?.visitDate === date);
  const changed = !state.model || date !== state.visitDate || rows.length !== state.rows.length
    || rows.some((row, index) => rowFields.some(field => row[field] !== state.rows[index][field]));
  state.visitDate = date;
  state.dates = availableDates(data);
  state.latest = data.latest;
  state.source = source;
  state.desk = data.desk?.findLast(row => Number.isFinite(Date.parse(row?.observedAt))
    && Number.isSafeInteger(row.available) && Number.isSafeInteger(row.capacity));
  if (changed) {
    state.rows = rows;
    state.model = buildHistory(rows, date);
    const showAll = presetIsSelected('all');
    const showCircuit = presetIsSelected('circuit');
    for (const [code, points] of state.model.byRoute) {
      if (state.routes.some(route => route.code === code)) continue;
      state.routes.push({code, name: points.at(-1).name || `Route ${code}`, color: '#3b5554', dash: '3 4'});
      if (showAll || (showCircuit && isCircuitTwo(code))) state.selected.add(code);
    }
  }
  return changed;
}

async function fetchData(url, requestSignal) {
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(12_000)]);
  const response = await fetch(url, {cache: 'no-store', signal});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data?.observations) || (data.dates != null && !Array.isArray(data.dates))
    || (data.desk != null && !Array.isArray(data.desk))) {
    throw new Error('Invalid dashboard response');
  }
  return data;
}

function apiData(date, signal) {
  const query = date ? `?visitDate=${encodeURIComponent(date)}` : '';
  return fetchData(`${apiBase}/api/data${query}`, signal);
}

async function loadComparison(data, source, signal, reuse) {
  const knownDates = availableDates(data);
  const latest = data.latest;
  const entries = await Promise.all(upcomingVisitDates().map(async date => {
    const record = payload => ({
      payload, view: {source, latest: payload.latest, snapshot: latestSnapshot(payload.observations, date)},
    });
    if (source === 'archive' || data.selectedDate === date) return [date, record(data)];
    if (!knownDates.includes(date)) return [date, {view: {source, latest}}];
    const cached = state.comparison.get(date);
    if (reuse && cached?.source === 'api' && !cached.failed && latest?.status === 'ok'
      && cached.snapshot?.time === Date.parse(latest.observedAt)) return [date, {view: {...cached, latest}}];
    try {
      return [date, record(await apiData(date, signal))];
    } catch (error) {
      if (signal.aborted) throw error;
      return [date, {view: {...cached, source: cached?.source ?? source, latest, failed: true}}];
    }
  }));
  return new Map(entries);
}

const comparisonViews = entries => new Map([...entries].map(([date, entry]) => [date, entry.view]));

async function loadApi(date, signal) {
  const data = await apiData(date, signal);
  const source = 'api';
  if (date) return {data, date, source};
  const entries = await loadComparison(data, source, signal, false);
  const comparison = comparisonViews(entries);
  const selected = preferredVisitDate(availableDates(data), comparison);
  const selectedData = entries.get(selected)?.payload
    ?? (!selected || data.selectedDate === selected ? data : await apiData(selected, signal));
  return {data: selectedData, date: selected, source, comparison};
}

async function loadArchive(date, signal) {
  const data = await fetchData('data.json', signal);
  const dates = availableDates(data);
  if (date && !dates.includes(date)) throw new Error('Visit date is missing from the archive');
  const source = 'archive';
  const comparison = comparisonViews(await loadComparison(data, source, signal, false));
  return {data, date: date ?? preferredVisitDate(dates, comparison), source, comparison};
}

async function refresh(date, dateChanged = false) {
  if (state.request && !dateChanged) return;
  const recoverDefault = state.source === 'archive' && state.failed && !state.explicitDate;
  const requestedDate = date ?? (recoverDefault ? null : state.visitDate);
  state.request?.abort();
  const request = new AbortController();
  state.request = request;
  state.lastRequest = Date.now();
  if (dateChanged) {
    state.visitDate = date;
    state.explicitDate = true;
    state.model = null;
    state.latest = null;
    state.failed = false;
    state.tablePage = 0;
    chart.clearSelection();
  }
  if (dateChanged || (!state.model && !state.failed)) renderData();
  renderStatus();
  renderDates();
  renderComparison();
  try {
    let result;
    let failed = false;
    if (!apiBase) result = await loadArchive(requestedDate, request.signal);
    else {
      try {
        result = await loadApi(requestedDate, request.signal);
      } catch (error) {
        if (request.signal.aborted || state.model?.snapshot) throw error;
        failed = true;
        result = await loadArchive(requestedDate, request.signal);
      }
    }
    if (state.request !== request) return;
    const changed = applyData(result.data, result.date, result.source);
    state.failed = failed;
    if (changed && state.model?.snapshot) renderData();
    renderStatus();
    renderDates();
    const comparison = result.comparison
      ?? comparisonViews(await loadComparison(result.data, result.source, request.signal, true));
    if (state.request === request) {
      state.comparison = comparison;
      state.comparisonFailed = failed;
    }
  } catch {
    if (state.request !== request) return;
    state.failed = true;
    state.comparisonFailed = true;
  } finally {
    if (state.request === request) {
      state.request = null;
      renderStatus();
      renderDates();
      renderDesk();
      if (!state.model?.snapshot) renderData();
      renderComparison();
    }
  }
}

function selectPreset(preset) {
  state.selected = new Set(presetRoutes(state.routes, preset));
  renderChart();
}

$('visit-date').addEventListener('change', event => refresh(event.target.value, true));
$('refresh').addEventListener('click', () => refresh());
$('chart-routes').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const {route: code, preset} = button.dataset;
  if (preset) return selectPreset(preset);
  if (event.shiftKey) state.selected = new Set([code]);
  else if (state.selected.has(code)) state.selected.delete(code);
  else state.selected.add(code);
  renderChart();
});
$('circuit-history').addEventListener('click', event => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  selectPreset('circuit');
});
$('comparison-dates').addEventListener('click', event => {
  const button = event.target.closest('.comparison-history');
  if (!button || button.disabled) return;
  const date = button.closest('.comparison-date').dataset.visitDate;
  selectPreset('circuit');
  if (date !== state.visitDate) refresh(date, true);
  $('history').scrollIntoView();
  $('chart-title').focus({preventScroll: true});
});
for (const button of document.querySelectorAll('[data-range]')) {
  button.addEventListener('click', () => {
    state.range = button.dataset.range;
    renderChart();
  });
}
$('insight-route').addEventListener('change', renderInsights);
$('table-route').addEventListener('change', () => {
  state.tablePage = 0;
  renderTable();
});
$('prev-page').addEventListener('click', () => {
  state.tablePage--;
  renderTable();
});
$('next-page').addEventListener('click', () => {
  state.tablePage++;
  renderTable();
});
$('download-csv').addEventListener('click', () => {
  if (!state.model?.rows.length) return;
  const blob = new Blob([csvForHistory(state.model.rows)], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const link = node('a');
  link.href = url;
  link.download = `machu-picchu-observations-${state.visitDate}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
});

function refreshWhenVisible() {
  if (document.hidden) return;
  renderStatus();
  renderDates();
  renderComparison();
  if (Date.now() - state.lastRequest >= refreshInterval) refresh();
}

refresh();
setInterval(refreshWhenVisible, refreshInterval);
document.addEventListener('visibilitychange', refreshWhenVisible);
