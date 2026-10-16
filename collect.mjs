import {mkdirSync,readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {SOURCE,peru,gate,classify,readConfirmed,captureFailure} from './core.mjs';

mkdirSync('data/raw',{recursive:true});
const history=existsSync('data/observations.jsonl')?readFileSync('data/observations.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const skip=gate(history,new Date());
if(process.argv.includes('--gate')) {
  if(process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,`collect=${!skip}\n`);
  console.log(skip||'Collection required');
  process.exit(0);
}
const drill=process.argv.includes('--diagnostic-drill');
if(skip&&!drill){console.log(skip);process.exit(0);}
let browser;
let page;
let observation;
const diagnostics={startedAt:new Date().toISOString(),stage:'browser-import',events:[],raw:''};
mkdirSync('diagnostics',{recursive:true});
const safeUrl=url=>{try{const u=new URL(url);return u.origin+u.pathname;}catch{return '(invalid URL)';}};
const logEvent=event=>{if(diagnostics.events.length<30)diagnostics.events.push({...event,at:new Date().toISOString()});};
try {
  const {chromium}=await import('playwright');
  diagnostics.stage='browser-launch';
  browser=await chromium.launch({headless:true});
  diagnostics.stage='browser-context';
  page=await browser.newPage({locale:'es-PE',timezoneId:'America/Lima'});
  page.on('requestfailed',request=>logEvent({type:'requestfailed',url:safeUrl(request.url()),error:request.failure()?.errorText}));
  page.on('response',response=>{if(response.status()>=400)logEvent({type:'http-error',status:response.status(),url:safeUrl(response.url())});});
  page.on('pageerror',error=>logEvent({type:'javascript-error',error:error.message}));
  page.on('console',message=>{if(message.type()==='error')logEvent({type:'console-error',error:message.text()});});
  if(drill) await page.route(SOURCE,route=>route.fulfill({status:200,contentType:'text/html',body:'<html><body><h1>Offline diagnostic drill</h1><p>Ruta 2-B: Broken layout fixture</p><p>No ticket counters supplied</p></body></html>'}));
  const snapshot=await readConfirmed(page,diagnostics,drill?{samples:2,pollMs:50,timeoutMs:2000}:undefined);
  diagnostics.stage='classifying-inventory';
  const observedAt=new Date().toISOString();
  observation={observedAt,collectionDate:peru(observedAt).date,source:SOURCE,...snapshot,...classify(snapshot,history,observedAt)};
  if(observation.status!=='ok') await captureFailure(page,diagnostics,(name,value)=>writeFileSync(`diagnostics/${name}`,value));
} catch(error) {
  diagnostics.error={name:error.name,message:error.message,stack:error.stack};
  observation={observedAt:new Date().toISOString(),status:'error',stopForDay:false,failedStage:diagnostics.stage,error:String(error.message),lastParseError:diagnostics.lastParseError,source:SOURCE};
  console.error(`::error title=Ticket collection failed::${diagnostics.stage}: ${error.message.replace(/[\r\n]/g,' ')}`);
  await captureFailure(page,diagnostics,(name,value)=>writeFileSync(`diagnostics/${name}`,value));
} finally {
  diagnostics.pageUrl=page?safeUrl(page.url()):null;
  try {await browser?.close();}catch(error){logEvent({type:'browser-close-error',error:error.message});}
  diagnostics.finishedAt=new Date().toISOString();
  writeFileSync('diagnostics/collection.json',JSON.stringify({...diagnostics,raw:undefined},null,2)+'\n');
}
const name=observation.observedAt.replace(/[:.]/g,'-');
observation.rawFile=`data/raw/${name}.txt`;
writeFileSync(observation.rawFile,diagnostics.raw||'(No page text captured)');
appendFileSync('data/observations.jsonl',JSON.stringify(observation)+'\n');
history.push(observation);
const good=history.filter(s=>s.status==='ok');
const latest=good.at(-1);
const lines=['# Circuit 2 availability','',`Latest check: ${observation.observedAt} — ${observation.status}`,'','Times in the history are UTC; collection days use Peru time.',''];
if(observation.status!=='ok') lines.push(`Failure stage: ${observation.failedStage||'inventory-date-validation'}`,`Detail: ${observation.error||observation.reason}`,'','For evidence, open the failed Actions run and download the collection-diagnostics artifact.','');
if(latest){lines.push(`Latest valid visit date: **${latest.visitDate}**`,`Observed: ${latest.observedAt}`,'','| Route | Capacity | Sold | Remaining |','|---|---:|---:|---:|',...latest.routes.map(r=>`| ${r.route} | ${r.capacity} | ${r.sold} | ${r.available} |`),'');}
lines.push(`Valid observations: ${good.length}. Errors/stale observations: ${history.length-good.length}.`,'','First zero is an observation, not an exact sell-out time. No purchase probability is implied.','After both routes sell out, collection pauses until the next Peru day; later restocks are unobserved.','',[ 'Download history: [JSONL](data/observations.jsonl) · [CSV](data/observations.csv)' ].join(''));
writeFileSync('REPORT.md',lines.join('\n')+'\n');
const csv=['observed_utc,collection_date,visit_date,status,route,capacity,sold,available'];
for(const s of history) for(const r of s.routes||[{}]) csv.push([s.observedAt,s.collectionDate||peru(s.observedAt).date,s.visitDate||'',s.status,r.route||'',r.capacity??'',r.sold??'',r.available??''].join(','));
writeFileSync('data/observations.csv',csv.join('\n')+'\n');
writeFileSync('data/latest.json',JSON.stringify(observation,null,2)+'\n');
if(process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,lines.join('\n'));
console.log(JSON.stringify(observation,null,2));
if(observation.status!=='ok') process.exitCode=1;
