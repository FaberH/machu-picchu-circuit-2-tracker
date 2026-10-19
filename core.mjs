import {createHmac} from 'node:crypto';

export const SOURCE = 'https://tuboleto.cultura.pe/disponibilidad/llaqta_machupicchu';
export const API_BASE = 'https://api-tuboleto.cultura.pe';
export const PLACE = 'llaqta_machupicchu';
export const SALES_POINT = 5;
export const DAILY_CAPACITY = 1000;

// This value is shipped in the public web application and is used only to sign
// public availability reads. It is not a private repository credential.
export const PUBLIC_REQUEST_KEY = '5t4jPtv4LpmGgWU7ZYk8FhZf5LNTpk';
const PUBLIC_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'es-PE,es;q=0.9',
  Origin: 'https://tuboleto.cultura.pe',
  Referer: 'https://tuboleto.cultura.pe/',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
};

export function peru(instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function visitDatesFor(collectionDate) {
  return [addDays(collectionDate, 1), addDays(collectionDate, 2)];
}

export function signTimestamp(timestamp, key = PUBLIC_REQUEST_KEY) {
  return createHmac('sha256', key).update(`${key}:${timestamp}`).digest('base64');
}

async function expectJson(response, label) {
  if (!response?.ok) throw new Error(`${label} returned HTTP ${response?.status ?? 'unknown'}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

export function normalizeRoutes(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Availability response has no routes');
  const routes = rows.map(row => {
    const capacity = Number(row.ncupo);
    const available = Number(row.ncupoActual);
    const id = Number(row.nidRuta);
    const name = String(row.ruta ?? '').trim();
    const route = name.match(/Ruta\s+([0-9]+-[A-Z])/i)?.[1]?.toUpperCase();
    if (!route || !name || !Number.isSafeInteger(id) || id <= 0) throw new Error('Availability response contains an invalid route identity');
    if (!Number.isSafeInteger(capacity) || !Number.isSafeInteger(available) || capacity <= 0 || available < 0 || available > capacity) {
      throw new Error(`Availability response contains invalid totals for ${route}`);
    }
    return {
      id,
      route,
      name,
      circuit: String(row.circuito ?? '').trim(),
      capacity,
      sold: capacity - available,
      available,
    };
  });
  if (new Set(routes.map(route => route.id)).size !== routes.length || new Set(routes.map(route => route.route)).size !== routes.length) {
    throw new Error('Availability response contains duplicate routes');
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

export async function fetchServerTimestamp(fetchImpl = fetch) {
  const response = await fetchImpl(`${API_BASE}/comunes/tiempo-servidor`, {
    headers: PUBLIC_HEADERS,
  });
  const payload = await expectJson(response, 'Server time');
  const timestamp = String(payload.tiempoServidor ?? '');
  if (!/^\d{13}$/.test(timestamp)) throw new Error('Server time response is invalid');
  return timestamp;
}

export async function fetchRoutes(visitDate, fetchImpl = fetch) {
  const timestamp = await fetchServerTimestamp(fetchImpl);
  const response = await fetchImpl(`${API_BASE}/comunes/disponibilidad-actual`, {
    method: 'POST',
    headers: {
      ...PUBLIC_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      lugar: PLACE,
      fecha: visitDate,
      punto: SALES_POINT,
      code: signTimestamp(timestamp),
      timestamp,
    }),
  });
  return normalizeRoutes(await expectJson(response, `Availability for ${visitDate}`));
}

export async function fetchTicketDesk(collectionDate, fetchImpl = fetch) {
  const response = await fetchImpl(`${API_BASE}/recaudador/ticket/tickets-por-fecha/${collectionDate}`, {
    headers: PUBLIC_HEADERS,
  });
  const payload = await expectJson(response, 'Ticket desk total');
  const issued = Number(payload.totalticket);
  if (!Number.isSafeInteger(issued) || issued < 0 || issued > DAILY_CAPACITY) throw new Error('Ticket desk total is invalid');
  return {capacity: DAILY_CAPACITY, issued, available: DAILY_CAPACITY - issued};
}

export async function collectSnapshot(now = new Date(), fetchImpl = fetch) {
  const collectionDate = peru(now).date;
  const dates = visitDatesFor(collectionDate);
  const [ticketDesk, ...routeSets] = await Promise.all([
    fetchTicketDesk(collectionDate, fetchImpl),
    ...dates.map(date => fetchRoutes(date, fetchImpl)),
  ]);
  return {
    collectionDate,
    ticketDesk,
    visitDates: dates.map((visitDate, index) => ({visitDate, routes: routeSets[index]})),
  };
}

export function isSoldOut(snapshot) {
  const routes = snapshot.visitDates?.flatMap(day => day.routes ?? []) ?? [];
  return routes.length > 0 && routes.every(route => route.available === 0);
}

export function gate(history, now) {
  const current = peru(now);
  if (current.date > '2026-12-31') return 'Collection period complete';
  if (current.hour < 6 || current.hour >= 22) return 'Outside 06:00–22:00 Peru collection window';
  if (history.some(item => item.schemaVersion >= 2 && item.status === 'ok' && item.stopForDay && peru(item.observedAt).date === current.date)) {
    return 'All monitored visit dates are sold out today';
  }
  return null;
}

export function classify(snapshot, now) {
  return {
    status: 'ok',
    phase: peru(now).hour < 6 ? 'preopen' : 'sales',
    stopForDay: peru(now).hour >= 6 && isSoldOut(snapshot),
  };
}

export function flattenObservation(observation) {
  if (Array.isArray(observation.visitDates)) {
    return observation.visitDates.flatMap(day => day.routes.map(route => ({
      observedAt: observation.observedAt,
      collectionDate: observation.collectionDate,
      visitDate: day.visitDate,
      status: observation.status,
      ...route,
    })));
  }
  return (observation.routes ?? []).map(route => ({
    observedAt: observation.observedAt,
    collectionDate: observation.collectionDate ?? peru(observation.observedAt).date,
    visitDate: observation.visitDate,
    status: observation.status,
    ...route,
  }));
}

