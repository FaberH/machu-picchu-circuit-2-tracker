const colors = ['#0c694f', '#d69336', '#3b6aa0', '#a34e73', '#6e7f3e', '#7557a8'];
const state = {data: null, visitDate: null, selected: new Set()};
const apiBase = String(window.TICKET_API_BASE || '').replace(/\/$/, '');
const $ = selector => document.querySelector(selector);
const svg = (name, attributes = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
};

const peruTime = value => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Lima', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(value));

function latestRows() {
  const rows = state.data.observations.filter(row => row.visitDate === state.visitDate);
  const lastTime = rows.at(-1)?.observedAt;
  return rows.filter(row => row.observedAt === lastTime);
}

function renderCards() {
  const rows = latestRows();
  $('#route-cards').replaceChildren(...rows.map(row => {
    const card = document.createElement('article');
    card.className = 'route-card';
    const remaining = Math.round((row.available / row.capacity) * 100);
    card.innerHTML = `<div class="route-top"><span class="route-code">Route ${row.route}</span><span class="quiet">${remaining}% left</span></div>
      <p class="route-name">${row.name.replace(/^Ruta\s+[0-9]+-[A-Z]:?\s*/i, '')}</p>
      <div><span class="route-number">${row.available}</span><span class="route-unit">remaining</span></div>
      <div class="meter"><span style="width:${remaining}%"></span></div>
      <div class="route-meta"><span>${row.sold} sold</span><span>${row.capacity} capacity</span></div>`;
    return card;
  }));
  const latestTime = rows.at(-1)?.observedAt;
  $('#status').textContent = latestTime ? `Latest sample · ${peruTime(latestTime)} Peru time` : 'No valid samples for this date';
}

function renderDesk() {
  const desk = state.data.desk.filter(row => row.collectionDate === state.data.latest?.collectionDate).at(-1);
  const el = $('#desk');
  if (!desk) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<strong>${desk.available} same-day ticket-desk turns remain</strong> · ${desk.issued} issued of ${desk.capacity}`;
}

function routeSeries() {
  const rows = state.data.observations.filter(row => row.visitDate === state.visitDate);
  const routeNames = [...new Set(rows.map(row => row.route))].sort();
  return routeNames.map((route, index) => ({
    route,
    color: colors[index % colors.length],
    points: rows.filter(row => row.route === route).map(row => ({time: new Date(row.observedAt), value: row.available})),
  }));
}

function renderFilters(series) {
  if (!state.selected.size) series.forEach(item => state.selected.add(item.route));
  const nodes = series.map(item => {
    const label = document.createElement('label');
    label.className = 'filter';
    label.style.setProperty('--swatch', item.color);
    label.innerHTML = `<input type="checkbox" ${state.selected.has(item.route) ? 'checked' : ''} value="${item.route}"><span class="swatch"></span>Route ${item.route}`;
    label.querySelector('input').addEventListener('change', event => {
      event.target.checked ? state.selected.add(item.route) : state.selected.delete(item.route);
      renderChart(false);
    });
    return label;
  });
  $('#route-filters').replaceChildren(...nodes);
}

function renderChart(refreshFilters = true) {
  const series = routeSeries();
  if (refreshFilters) renderFilters(series);
  const shown = series.filter(item => state.selected.has(item.route));
  const chart = $('#chart');
  chart.replaceChildren();
  const all = shown.flatMap(item => item.points);
  const uniqueTimes = [...new Set(all.map(point => point.time.toISOString()))];
  $('#sample-count').textContent = `${uniqueTimes.length} samples`;
  $('#empty-chart').hidden = uniqueTimes.length > 1;
  if (!all.length || uniqueTimes.length < 2) return;

  const width = 960, height = 440, left = 64, right = 20, top = 22, bottom = 54;
  const minTime = Math.min(...all.map(point => point.time));
  const maxTime = Math.max(...all.map(point => point.time));
  const maxValue = Math.max(100, ...all.map(point => point.value));
  const yTop = Math.ceil(maxValue / 100) * 100;
  const x = time => left + ((time - minTime) / (maxTime - minTime)) * (width - left - right);
  const y = value => top + (1 - value / yTop) * (height - top - bottom);

  for (let i = 0; i <= 5; i++) {
    const value = (yTop / 5) * i;
    const yy = y(value);
    chart.append(svg('line', {x1: left, x2: width - right, y1: yy, y2: yy, class: 'grid-line'}));
    const label = svg('text', {x: left - 12, y: yy + 4, 'text-anchor': 'end', class: 'axis-label'});
    label.textContent = Math.round(value);
    chart.append(label);
  }
  for (let i = 0; i <= 4; i++) {
    const time = new Date(minTime + ((maxTime - minTime) / 4) * i);
    const xx = x(time);
    const label = svg('text', {x: xx, y: height - 20, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'axis-label'});
    label.textContent = new Intl.DateTimeFormat('en-GB', {timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(time);
    chart.append(label);
  }
  for (const item of shown) {
    const points = item.points.map(point => `${x(point.time)},${y(point.value)}`).join(' ');
    chart.append(svg('polyline', {points, stroke: item.color, class: 'chart-line'}));
    for (const point of item.points) {
      const dot = svg('circle', {cx: x(point.time), cy: y(point.value), r: 4, fill: item.color, class: 'chart-dot'});
      const title = svg('title');
      title.textContent = `Route ${item.route}: ${point.value} remaining at ${peruTime(point.time)}`;
      dot.append(title);
      chart.append(dot);
    }
  }
  $('#chart-description').textContent = `Line chart with ${uniqueTimes.length} observations for ${shown.map(item => `route ${item.route}`).join(', ')}.`;
}

function renderTable() {
  const rows = state.data.observations.filter(row => row.visitDate === state.visitDate).slice(-60).reverse();
  $('#history-body').replaceChildren(...rows.map(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${peruTime(row.observedAt)}</td><td>${row.route}</td><td>${row.capacity}</td><td>${row.sold}</td><td>${row.available}</td>`;
    return tr;
  }));
}

function render() {
  renderCards();
  renderDesk();
  renderChart();
  renderTable();
}

async function start() {
  try {
    const load = async visitDate => {
      const endpoint = apiBase
        ? `${apiBase}/api/data${visitDate ? `?visitDate=${encodeURIComponent(visitDate)}` : ''}`
        : 'data.json';
      const response = await fetch(endpoint, {cache: 'no-store'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };
    state.data = await load();
    const dates = state.data.dates || [...new Set(state.data.observations.map(row => row.visitDate))].sort().reverse();
    if (!dates.length) throw new Error('No observations have been collected yet');
    state.visitDate = state.data.selectedDate || dates[0];
    const select = $('#visit-date');
    select.replaceChildren(...dates.map(date => new Option(date, date)));
    select.value = state.visitDate;
    if (apiBase) $('#download-link').href = `${apiBase}/api/observations.csv?visitDate=${encodeURIComponent(state.visitDate)}`;
    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        state.visitDate = select.value;
        state.selected.clear();
        if (apiBase) {
          state.data = await load(state.visitDate);
          $('#download-link').href = `${apiBase}/api/observations.csv?visitDate=${encodeURIComponent(state.visitDate)}`;
        }
        render();
      } catch (error) {
        $('#status').textContent = `Dashboard data unavailable: ${error.message}`;
      } finally {
        select.disabled = false;
      }
    });
    render();
  } catch (error) {
    $('#status').textContent = `Dashboard data unavailable: ${error.message}`;
    $('#empty-chart').hidden = false;
    $('#empty-chart').textContent = 'No collected data is available yet.';
  }
}

start();

