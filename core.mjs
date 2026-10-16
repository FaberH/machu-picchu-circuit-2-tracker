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
  if(hour<5||(hour===5&&new Date(now).getUTCMinutes()<30)||hour>=22) return 'Outside 05:30–22:00 Peru collection window';
  if(history.some(s=>s.status==='ok'&&s.stopForDay&&peru(s.observedAt).date===date)) return 'Both routes sold out today';
  return null;
}
export function classify(snapshot, history, now) {
  const today=peru(now).date;
  if(snapshot.visitDate<=today) return {status:'stale',stopForDay:false,reason:'Visit date is not in the future'};
  const priorZero=history.some(s=>s.status==='ok'&&s.visitDate===snapshot.visitDate&&isZero(s)&&peru(s.observedAt).date<today);
  if(isZero(snapshot)&&priorZero) return {status:'stale',stopForDay:false,reason:'Previous collection day sold out this same visit date'};
  return {status:'ok',phase:peru(now).hour<6?'preopen':'sales',stopForDay:peru(now).hour>=6&&isZero(snapshot)};
}

// Kept separate from filesystem writes so failure paths can be tested offline.
export async function readLoaded(page, diagnostics, {samples=15,pollMs=1000,timeoutMs=45000}={}) {
  diagnostics.stage='navigation';
  const response=await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:timeoutMs});
  diagnostics.httpStatus=response?.status()??null;
  if(response && response.status()>=400) throw new Error(`Ticket page returned HTTP ${response.status()}`);
  diagnostics.stage='waiting-for-route-cards';
  await page.getByText('Ruta 2-B:',{exact:false}).first().waitFor({timeout:timeoutMs});
  diagnostics.stage='parsing-route-cards';
  let previous;
  for(let i=0;i<samples;i++) {
    diagnostics.raw=await page.locator('body').innerText();
    diagnostics.samples=(diagnostics.samples||0)+1;
    try {
      const current=parse(diagnostics.raw);
      diagnostics.lastParsed=current;
      if(JSON.stringify(current)===JSON.stringify(previous)) return current;
      previous=current;
    } catch(error) {
      diagnostics.lastParseError=error.message;
      previous=undefined;
    }
    await page.waitForTimeout(pollMs);
  }
  throw new Error(`No stable valid route reading after ${samples} samples. Last parsing error: ${diagnostics.lastParseError||'none; inventory kept changing'}`);
}

export async function readConfirmed(page, diagnostics, options) {
  let snapshot=await readLoaded(page,diagnostics,options);
  if(isZero(snapshot)) {
    diagnostics.zeroBeforeReload=snapshot;
    const confirmed=await readLoaded(page,diagnostics,options);
    diagnostics.stage='confirming-sold-out';
    if(JSON.stringify(snapshot)!==JSON.stringify(confirmed)) throw new Error('Sold-out reading changed after reload; retry next run');
    snapshot=confirmed;
  }
  return snapshot;
}

export async function captureFailure(page, diagnostics, write) {
  diagnostics.evidenceErrors=[];
  if(!page) return;
  for(const [name,read] of [
    ['page.txt',()=>page.locator('body').innerText()],
    ['page.html',()=>page.content()],
    ['page.png',()=>page.screenshot({fullPage:true,timeout:10000})],
  ]) {
    try {const value=await read();write(name,value);if(name==='page.txt')diagnostics.raw=value;}
    catch(error){diagnostics.evidenceErrors.push({file:name,error:error.message});}
  }
}
