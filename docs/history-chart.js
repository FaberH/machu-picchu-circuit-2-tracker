import {lowerBound, peruClock, peruDate, peruMidnight, peruShortDate, peruTimestamp, rangeStart, samplingGap} from './dashboard-data.js';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const tickMinutes = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880, 4320, 10080];

export function timeTicks(first, last, plotWidth) {
  if (Math.floor(first / minute) === Math.floor(last / minute)) return [first + (last - first) / 2];
  const span = last - first;
  const count = Math.min(7, Math.max(3, Math.floor(plotWidth / 122) + 1));
  const step = (tickMinutes.findLast(value => value * minute <= span / (count - 1)) ?? tickMinutes[0]) * minute;
  const minGap = span * 62 / plotWidth;
  const midnight = peruMidnight(first);
  const ticks = [first];
  for (let time = midnight + Math.ceil((first - midnight) / step) * step; time < last - minGap; time += step) {
    if (time >= ticks.at(-1) + minGap) ticks.push(time);
  }
  ticks.push(last);
  return ticks;
}

export function overnightBands(samples, first, last) {
  const bands = [];
  for (let start = peruMidnight(first) - 2 * hour; start < last; start += day) {
    const end = start + 8 * hour;
    if (end <= first) continue;
    const observation = samples[lowerBound(samples, start)];
    if (observation && observation.time < end) continue;
    bands.push([Math.max(first, start), Math.min(last, end)]);
  }
  return bands;
}

export function ticketAxis(max) {
  const target = Math.max(1, max / 5);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 2.5, 3, 5, 10].map(value => value * magnitude)
    .find(value => value >= target && Number.isInteger(value));
  return {step, yTop: Math.max(step, Math.ceil(max / step) * step)};
}

const svgNode = (name, attributes = {}, text) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
};

// Keep the first, last, and extremes within each horizontal pixel of a segment.
function pixelExtremes(points, x) {
  if (points.length < 3) return points;
  const kept = [];
  let start = 0;
  while (start < points.length) {
    const pixel = Math.floor(x(points[start].time));
    let min = start;
    let max = start;
    let end = start + 1;
    while (end < points.length && Math.floor(x(points[end].time)) === pixel) {
      if (points[end].available < points[min].available) min = end;
      if (points[end].available > points[max].available) max = end;
      end++;
    }
    for (const index of [...new Set([start, min, max, end - 1])].sort((a, b) => a - b)) {
      kept.push(points[index]);
    }
    start = end;
  }
  return kept;
}

function routePaths(points, x, y, showDots) {
  const lines = [];
  const dots = [];
  let start = 0;
  for (let end = 1; end <= points.length; end++) {
    if (end < points.length && !samplingGap(points[end - 1], points[end])) continue;
    const segment = pixelExtremes(points.slice(start, end), x);
    if (segment.length > 1) {
      lines.push(`M${segment.map(point => `${x(point.time).toFixed(1)} ${y(point.available).toFixed(1)}`).join('L')}`);
    }
    if (showDots || segment.length === 1) {
      for (const point of segment) {
        const xx = x(point.time).toFixed(1);
        const yy = y(point.available).toFixed(1);
        dots.push(`M${xx} ${yy}h.01`);
      }
    }
    start = end;
  }
  return {lines: lines.join(''), dots: dots.join('')};
}

function drawAxes(chart, layout) {
  const {width, height, left, right, top, yTop, step, y, x, first, last} = layout;
  for (let value = 0; value <= yTop; value += step) {
    const yy = y(value);
    chart.append(
      svgNode('line', {x1: left, x2: width - right, y1: yy, y2: yy, class: value === 0 ? 'grid-line baseline' : 'grid-line'}),
      svgNode('text', {x: left - 8, y: yy + 4, 'text-anchor': 'end', class: 'axis-label'}, value.toLocaleString('en')),
    );
  }
  const ticks = timeTicks(first, last, width - left - right);
  let previousDate;
  for (const [index, time] of ticks.entries()) {
    const xx = x(time);
    const anchor = ticks.length === 1 ? 'middle' : index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle';
    if (ticks.length > 1) {
      chart.append(svgNode('line', {x1: xx, x2: xx, y1: top, y2: y(0), class: 'time-grid-line'}));
    }
    const date = peruDate(time);
    if (date !== previousDate) {
      chart.append(svgNode('text', {x: xx, y: height - 22, 'text-anchor': anchor, class: 'axis-label date-label'}, peruShortDate(time)));
    }
    previousDate = date;
    chart.append(svgNode('text', {x: xx, y: height - 6, 'text-anchor': anchor, class: 'axis-label'}, peruClock(time)));
  }
}

export function createHistoryChart({shell, interaction, chart, tooltip, empty, count, description, announcement, gapKey}) {
  let view;
  let samples = [];
  let shown = [];
  let domain;
  let layout;
  let cursor;
  let activeTime = null;
  let pointerFrame = 0;
  let pointerX;
  let drawnWidth = 0;

  function clearSelection() {
    activeTime = null;
    cancelAnimationFrame(pointerFrame);
    pointerFrame = 0;
    tooltip.hidden = true;
    cursor?.replaceChildren();
    announcement.textContent = '';
  }

  function inspect(sample, announce = false) {
    const {x, y, top, width} = layout;
    const xx = x(sample.time);
    activeTime = sample.time;
    cursor.replaceChildren(svgNode('line', {x1: xx, x2: xx, y1: top, y2: y(0), class: 'cursor-line'}));
    const timestamp = document.createElement('time');
    timestamp.dateTime = new Date(sample.time).toISOString();
    timestamp.textContent = `${peruTimestamp(sample.time, true)} Peru`;
    const list = document.createElement('ul');
    const summary = [];
    for (const route of shown) {
      const point = sample.routes.get(route.code);
      const item = document.createElement('li');
      const marker = document.createElement('span');
      marker.className = 'tooltip-marker';
      marker.style.backgroundColor = route.color;
      const label = document.createElement('span');
      label.textContent = `Route ${route.code}`;
      const value = document.createElement('strong');
      value.textContent = point ? point.available.toLocaleString('en') : 'No sample';
      item.append(marker, label, value);
      list.append(item);
      summary.push(`${label.textContent}, ${point ? `${value.textContent} remaining` : 'no sample'}`);
      if (point) cursor.append(svgNode('circle', {cx: xx, cy: y(point.available), r: 4, fill: route.color, class: 'cursor-dot'}));
    }
    tooltip.replaceChildren(timestamp, list);
    tooltip.hidden = false;
    const tooltipWidth = tooltip.offsetWidth;
    tooltip.style.left = `${Math.max(0, xx + tooltipWidth + 12 > width ? xx - tooltipWidth - 12 : xx + 12)}px`;
    if (announce) announcement.textContent = `${timestamp.textContent}. ${summary.join('. ')}.`;
  }

  function draw() {
    const width = Math.round(shell.clientWidth);
    if (!width || !view || !samples.length) return;
    drawnWidth = width;
    const height = width < 520 ? 240 : 310;
    const left = width < 520 ? 40 : 48;
    const right = 12;
    const top = 18;
    const bottom = 45;
    const {first, last, bands} = domain;
    let max = 0;
    for (const route of shown) {
      for (const point of route.points) max = Math.max(max, point.available);
    }
    const {step, yTop} = ticketAxis(max);
    const plotWidth = width - left - right;
    const x = time => first === last ? left + plotWidth / 2 : left + (time - first) / (last - first) * plotWidth;
    const y = value => top + (1 - value / yTop) * (height - top - bottom);
    layout = {width, height, left, right, top, yTop, step, y, x, first, last};
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    chart.replaceChildren();
    for (const [start, end] of bands) {
      chart.append(svgNode('rect', {x: x(start), y: top, width: x(end) - x(start), height: y(0) - top, class: 'overnight-band'}));
    }
    drawAxes(chart, layout);
    for (const [start, end] of bands) {
      if (x(end) - x(start) < 112) continue;
      chart.append(svgNode('text', {x: x(start + (end - start) / 2), y: top + 19, 'text-anchor': 'middle', class: 'axis-label'}, 'Overnight pause'));
    }
    for (const route of shown) {
      const {lines, dots} = routePaths(route.points, x, y, samples.length <= 28);
      if (lines) chart.append(svgNode('path', {d: lines, stroke: route.color, 'stroke-dasharray': route.dash, class: 'series-line'}));
      if (dots) chart.append(svgNode('path', {d: dots, stroke: route.color, class: 'series-dot'}));
    }
    cursor = svgNode('g');
    chart.append(cursor);
    const selected = samples[lowerBound(samples, activeTime)];
    if (activeTime !== null && selected?.time === activeTime) inspect(selected);
    else clearSelection();
  }

  function update(next) {
    view = next;
    const {model, routes, selected, range, message} = next;
    const start = rangeStart(range, model?.snapshot?.time);
    const available = model?.samples.slice(lowerBound(model.samples, start)) ?? [];
    const codes = routes.filter(route => selected.has(route.code));
    shown = codes.map(route => {
      const points = model?.byRoute.get(route.code) ?? [];
      return {...route, points: points.slice(lowerBound(points, start))};
    });
    samples = available.filter(sample => codes.some(route => sample.routes.has(route.code)));
    const hasSamples = samples.length > 0;
    if (hasSamples) {
      const first = range === '30' || range === '120' ? start : available[0].time;
      const last = available.at(-1).time;
      domain = {first, last, bands: overnightBands(model.samples, first, last)};
    }
    interaction.hidden = !hasSamples;
    empty.hidden = hasSamples;
    gapKey.hidden = !hasSamples || !domain.bands.length;
    count.textContent = hasSamples ? `${samples.length.toLocaleString('en')} ${samples.length === 1 ? 'sample' : 'samples'} · Peru time` : '';
    description.textContent = hasSamples
      ? `${count.textContent}. ${codes.map(route => `Route ${route.code}`).join(', ')}.${domain.bands.length ? ' Shading marks scheduled overnight pauses.' : ''}`
      : '';
    if (hasSamples) draw();
    else {
      clearSelection();
      empty.textContent = message || (codes.length ? 'No observations in this range for the selected routes.' : 'Select a route to see its history.');
    }
  }

  function inspectPointer(clientX) {
    const {first, last, left, right, width, x} = layout;
    const pointer = clientX - chart.getBoundingClientRect().left;
    const time = first + (last - first) * (pointer - left) / (width - left - right);
    const index = lowerBound(samples, time);
    const before = samples[index - 1];
    const after = samples[index];
    const closest = !after || (before && time - before.time <= after.time - time) ? before : after;
    if (Math.abs(x(closest.time) - pointer) > 24 && (!before || !after || samplingGap(before, after))) {
      clearSelection();
      return;
    }
    if (closest.time !== activeTime) inspect(closest);
  }

  interaction.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || !layout || !samples.length) return;
    pointerX = event.clientX;
    if (!pointerFrame) pointerFrame = requestAnimationFrame(() => {
      pointerFrame = 0;
      inspectPointer(pointerX);
    });
  });
  interaction.addEventListener('pointerdown', event => {
    if (layout && samples.length) inspectPointer(event.clientX);
  });
  interaction.addEventListener('pointerleave', event => {
    if (event.pointerType !== 'touch') clearSelection();
  });
  interaction.addEventListener('pointercancel', clearSelection);
  interaction.addEventListener('blur', clearSelection);
  interaction.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      clearSelection();
      return;
    }
    if (!samples.length || !layout) return;
    const index = activeTime === null ? -1 : lowerBound(samples, activeTime);
    let next;
    switch (event.key) {
      case 'Home': next = 0; break;
      case 'End': next = samples.length - 1; break;
      case 'ArrowLeft': next = index < 0 ? samples.length - 1 : Math.max(0, index - 1); break;
      case 'ArrowRight': next = Math.min(samples.length - 1, index + 1); break;
      default: return;
    }
    event.preventDefault();
    inspect(samples[next], true);
  });
  new ResizeObserver(() => {
    if (Math.round(shell.clientWidth) !== drawnWidth) draw();
  }).observe(shell);

  return {update, clearSelection};
}
