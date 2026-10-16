import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse,peru,gate,classify} from './core.mjs';
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
test('stale prior inventory cannot stop a new day',()=>{
 const future={...zero,visitDate:'2026-10-18'};
 const history=[{...future,observedAt:'2026-10-16T18:00:00Z',status:'ok'}];
 assert.equal(classify(future,history,'2026-10-17T11:00:00Z').status,'stale');
 assert.equal(classify(future,[],'2026-10-17T11:00:00Z').stopForDay,true);
 assert.match(gate([],'2027-01-01T11:00:00Z'),/complete/);
});

test('pre-opening zeros cannot pause collection before sales begin',()=>{
 const before=classify(zero,[],'2026-10-16T10:55:00Z');
 assert.equal(before.phase,'preopen');
 assert.equal(before.stopForDay,false);
 assert.equal(gate([{...zero,...before,observedAt:'2026-10-16T10:55:00Z'}],'2026-10-16T11:00:00Z'),null);
 assert.equal(classify(zero,[],'2026-10-16T11:00:00Z').stopForDay,true);
});
