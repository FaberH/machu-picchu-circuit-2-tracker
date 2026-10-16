export const SOURCE = 'https://tuboleto.cultura.pe/cusco/1000boletos';
export function peru(instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).map(p=>[p.type,p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,hour:Number(parts.hour)};
}
export function parse(text) {
  const normalized = text.normalize('NFC').replace(/\r/g,'');
  const date = normalized.match(/Disponibilidad para el d[ií]a\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  if (!date) throw new Error('Visit date missing');
  const visitDate = `${date[3]}-${date[2]}-${date[1]}`;
  if (new Date(visitDate).toISOString().slice(0,10)!==visitDate) throw new Error('Invalid visit date');
  const routes = ['2-A','2-B'].map(route=>{
    const matches=[...normalized.matchAll(new RegExp(`Ruta ${route}:[^\\n]*\\s+(\\d+)\\s+AFORO\\s+(\\d+)\\s+VENDIDOS\\s+(\\d+)\\s+DISPONIBLES`,'gi'))];
    if(matches.length!==1) throw new Error(`Missing or ambiguous ${route}`);
    const [capacity,sold,available]=matches[0].slice(1).map(Number);
    if(![capacity,sold,available].every(Number.isSafeInteger)||capacity<=0||sold+available!==capacity) throw new Error(`Invalid totals ${route}`);
    return {route,capacity,sold,available};
  });
  return {visitDate,routes};
}
export const isZero = s => s.routes.every(r=>r.available===0);
export function gate(history, now) {
  const {date,hour}=peru(now);
  if(date>'2026-12-31') return 'Collection period complete';
  if(hour<6||hour>=22) return 'Outside 06:00–22:00 Peru collection window';
  if(history.some(s=>s.status==='ok'&&s.stopForDay&&peru(s.observedAt).date===date)) return 'Both routes sold out today';
  return null;
}
export function classify(snapshot, history, now) {
  const today=peru(now).date;
  if(snapshot.visitDate<=today) return {status:'stale',stopForDay:false,reason:'Visit date is not in the future'};
  const priorZero=history.some(s=>s.status==='ok'&&s.visitDate===snapshot.visitDate&&isZero(s)&&peru(s.observedAt).date<today);
  if(isZero(snapshot)&&priorZero) return {status:'stale',stopForDay:false,reason:'Previous collection day sold out this same visit date'};
  return {status:'ok',stopForDay:isZero(snapshot)};
}
