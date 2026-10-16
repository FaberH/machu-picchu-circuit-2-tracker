import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse,peru,gate,classify,readLoaded,readConfirmed,captureFailure} from './core.mjs';
const raw='Disponibilidad para el día\n17/10/2026\nRuta 2-A: Clásico Diseñada\n600\nAFORO\n467\nVENDIDOS\n133\nDISPONIBLES\nRuta 2-B: Terraza Inferior\n100\nAFORO\n57\nVENDIDOS\n43\nDISPONIBLES';
const zero={visitDate:'2026-10-17',routes:[{route:'2-A',capacity:600,sold:600,available:0},{route:'2-B',capacity:100,sold:100,available:0}]};
test('parses distinct route counts and rejects broken data',()=>{
 assert.deepEqual(parse(raw).routes.map(r=>r.available),[133,43]);
 for(const invalid of ['Cargando...',raw.replace('133','134'),raw.replace('17/10','31/02'),raw.split('Ruta 2-B')[0],raw+'\n'+raw]) assert.throws(()=>parse(invalid));
});
test('Peru day differs from UTC around midnight',()=>assert.deepEqual(peru('2026-10-17T02:00:00Z'),{date:'2026-10-16',hour:21}));
test('stops only confirmed both-zero today and resumes next day',()=>{
 const history=[{...zero,observedAt:'2026-10-16T18:00:00Z',status:'ok',stopForDay:true}];
 assert.match(gate(history,'2026-10-16T19:00:00Z'),/sold out/);
 assert.equal(gate(history,'2026-10-17T11:00:00Z'),null);
 assert.match(gate([],'2026-10-17T10:29:00Z'),/Outside/);
 assert.equal(gate([],'2026-10-17T10:30:00Z'),null);
 assert.equal(gate([{...history[0],status:'error'}],'2026-10-16T19:00:00Z'),null);
 assert.equal(classify(parse(raw),[],'2026-10-16T19:00:00Z').stopForDay,false);
});
test('pre-opening zeros cannot pause collection before sales begin',()=>{
 const before=classify(zero,[],'2026-10-16T10:55:00Z');
 assert.equal(before.phase,'preopen');
 assert.equal(before.stopForDay,false);
 assert.equal(gate([{...zero,...before,observedAt:'2026-10-16T10:55:00Z'}],'2026-10-16T11:00:00Z'),null);
 assert.equal(classify(zero,[],'2026-10-16T11:00:00Z').stopForDay,true);
});
test('stale prior inventory cannot stop a new day',()=>{
 const future={...zero,visitDate:'2026-10-18'};
 const history=[{...future,observedAt:'2026-10-16T18:00:00Z',status:'ok'}];
 assert.equal(classify(future,history,'2026-10-17T11:00:00Z').status,'stale');
 assert.equal(classify(future,[],'2026-10-17T11:00:00Z').stopForDay,true);
 assert.match(gate([],'2027-01-01T11:00:00Z'),/complete/);
});

function fakePage(texts,{http=200,navigationError,routeError}={}) {
 let index=0;
 return {
  goto:async()=>{if(navigationError)throw navigationError;return {status:()=>http};},
  getByText:()=>({first:()=>({waitFor:async()=>{if(routeError)throw routeError;}})}),
  locator:()=>({innerText:async()=>texts[Math.min(index++,texts.length-1)]}),
  waitForTimeout:async()=>{},
 };
}
const quick={samples:3,pollMs:0,timeoutMs:10};
test('network and HTTP failures identify navigation stage',async()=>{
 for(const options of [{http:503},{navigationError:new Error('net::ERR_NAME_NOT_RESOLVED')}]) {
  const d={};await assert.rejects(readLoaded(fakePage([raw],options),d,quick),/503|ERR_NAME/);
  assert.equal(d.stage,'navigation');
 }
});
test('missing route identifies route-card wait stage',async()=>{
 const d={};await assert.rejects(readLoaded(fakePage([raw],{routeError:new Error('Timeout waiting for Ruta 2-B')}),d,quick),/Ruta 2-B/);
 assert.equal(d.stage,'waiting-for-route-cards');
});
test('layout errors preserve the original parser diagnosis and page text',async()=>{
 const broken=raw.replace('43','44');const d={};
 await assert.rejects(readLoaded(fakePage([broken]),d,quick),/Invalid totals 2-B/);
 assert.equal(d.stage,'parsing-route-cards');assert.equal(d.lastParseError,'Invalid totals 2-B');assert.equal(d.raw,broken);
});
test('loading placeholders cannot become valid observations',async()=>{
 const d={};await assert.rejects(readLoaded(fakePage(['Cargando...']),d,quick),/Visit date missing/);
 assert.equal(d.lastParsed,undefined);
});
test('changing counts must stabilize before recording',async()=>{
 const changed=raw.replace('467','468').replace('133','132');const d={};
 assert.equal((await readLoaded(fakePage([raw,changed,changed]),d,quick)).routes[0].available,132);
 assert.equal(d.samples,3);
});
test('zero changed after reload never confirms sell-out',async()=>{
 const zeroText=raw.replace('467','600').replace('133','0').replace('57','100').replace('43','0');const d={};
 await assert.rejects(readConfirmed(fakePage([zeroText,zeroText,raw,raw]),d,quick),/changed after reload/);
 assert.equal(d.stage,'confirming-sold-out');
});
test('failure evidence survives a screenshot error',async()=>{
 const writes={};const d={stage:'parsing-route-cards',error:{message:'original error'}};
 const page={locator:()=>({innerText:async()=>raw}),content:async()=>'<html>failed layout</html>',screenshot:async()=>{throw new Error('Screenshot unavailable');}};
 await captureFailure(page,d,(name,value)=>{writes[name]=value;});
 assert.equal(writes['page.txt'],raw);assert.equal(writes['page.html'],'<html>failed layout</html>');
 assert.equal(d.evidenceErrors[0].error,'Screenshot unavailable');assert.equal(d.error.message,'original error');
});
test('browser launch failures safely omit page evidence',async()=>{
 const d={};await captureFailure(undefined,d,()=>assert.fail('No page to save'));
 assert.deepEqual(d.evidenceErrors,[]);
});
