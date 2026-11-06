import {lowerBound, peruClock, peruDate, peruShortDate, peruTimestamp, rangeStart, samplingGap} from './dashboard-data.js';

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
  const {width, height, left, right, top, yTop, y, x, first, last} = layout;
  for (let index = 0; index <= 4; index++) {
    const value = yTop * index / 4;
    const yy = y(value);
    chart.append(
      svgNode('line', {x1: left, x2: width - right, y1: yy, y2: yy, class: 'grid-line'}),
      svgNode('text', {x: left - 8, y: yy + 4, 'text-anchor': 'end', class: 'axis-label'}, value.toLocaleString('en')),
    );
  }
  const multiDay = peruDate(first) !== peruDate(last);
  const tickCount = first === last ? 1 : width < 520 ? 3 : 5;
  for (let index = 0; index < tickCount; index++) {
    const time = tickCount === 1 ? first : first + (last - first) * index / (tickCount - 1);
    const xx = x(time);
    const anchor = tickCount === 1 ? 'middle' : index === 0 ? 'start' : index === tickCount - 1 ? 'end' : 'middle';
    if (tickCount > 1) {
      chart.append(svgNode('line', {x1: xx, x2: xx, y1: top, y2: y(0), class: 'time-grid-line'}));
    }
    if (multiDay || tickCount === 1) {
      chart.append(svgNode('text', {x: xx, y: height - 22, 'text-anchor': anchor, class: 'axis-label date-label'}, peruShortDate(time)));
    }
    chart.append(svgNode('text', {x: xx, y: height - 6, 'text-anchor': anchor, class: 'axis-label'}, peruClock(time)));
  }
}

export function createHistoryChart({shell, interaction, chart, tooltip, empty, count, description, announcement}) {
  let view;
  let samples = [];
  let shown = [];
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
    const height = width < 520 ? 240 : 300;
    const left = 47;
    const right = 12;
    const top = 12;
    const bottom = 45;
    const first = samples[0].time;
    const last = samples.at(-1).time;
    let max = 0;
    for (const route of shown) {
      for (const point of route.points) max = Math.max(max, point.available);
    }
    const target = Math.max(1, max / 4);
    const magnitude = 10 ** Math.floor(Math.log10(target));
    const step = ([1, 2, 2.5, 5, 10].find(value => value * magnitude >= target && Number.isInteger(value * magnitude))) * magnitude;
    const yTop = step * 4;
    const plotWidth = width - left - right;
    const x = time => first === last ? left + plotWidth / 2 : left + (time - first) / (last - first) * plotWidth;
    const y = value => top + (1 - value / yTop) * (height - top - bottom);
    layout = {width, height, left, right, top, yTop, y, x, first, last};
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    chart.replaceChildren();
    drawAxes(chart, layout);
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
    interaction.hidden = !hasSamples;
    empty.hidden = hasSamples;
    count.textContent = hasSamples ? `${samples.length.toLocaleString('en')} ${samples.length === 1 ? 'sample' : 'samples'} · Peru time` : '';
    description.textContent = hasSamples ? `${count.textContent}. ${codes.map(route => `Route ${route.code}`).join(', ')}.` : '';
    if (hasSamples) draw();
    else {
      clearSelection();
      empty.textContent = message || (codes.length ? 'No observations in this range for the selected routes.' : 'Select a route to see its history.');
    }
  }

  function inspectPointer(clientX) {
    const {first, last, left, right, width} = layout;
    const offset = clientX - chart.getBoundingClientRect().left - left;
    const time = first + (last - first) * offset / (width - left - right);
    const index = lowerBound(samples, time);
    const before = samples[index - 1];
    const after = samples[index];
    const closest = !after || (before && time - before.time <= after.time - time) ? before : after;
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
