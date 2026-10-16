import {mkdirSync,readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {SOURCE,peru,parse,isZero,gate,classify} from './core.mjs';

mkdirSync('data/raw',{recursive:true});
const history=existsSync('data/observations.jsonl')?readFileSync('data/observations.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const skip=gate(history,new Date());
if(process.argv.includes('--gate')) {
  if(process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,`collect=${!skip}\n`);
  console.log(skip||'Collection required');
  process.exit(0);
}
if(skip){console.log(skip);process.exit(0);}
let browser;
let raw='';
let observation;
try {
  const {chromium}=await import('playwright');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({locale:'es-PE',timezoneId:'America/Lima'});
  async function readLoaded() {
    await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:45000});
    await page.getByText('Ruta 2-B:',{exact:false}).first().waitFor({timeout:45000});
    let previous;
    for(let i=0;i<15;i++) {
      raw=await page.locator('body').innerText();
      try {
        const current=parse(raw);
        if(JSON.stringify(current)===JSON.stringify(previous)) return current;
        previous=current;
      } catch { previous=undefined; }
      await page.waitForTimeout(1000);
    }
    throw new Error('Route cards never produced two matching valid readings');
  }
  let snapshot=await readLoaded();
  if(isZero(snapshot)) {
    const confirmed=await readLoaded();
    if(JSON.stringify(snapshot)!==JSON.stringify(confirmed)) throw new Error('Sold-out reading changed after reload; retry next run');
    snapshot=confirmed;
  }
  const observedAt=new Date().toISOString();
  observation={observedAt,collectionDate:peru(observedAt).date,source:SOURCE,...snapshot,...classify(snapshot,history,observedAt)};
} catch(error) {
  observation={observedAt:new Date().toISOString(),status:'error',stopForDay:false,error:String(error.message),source:SOURCE};
} finally {await browser?.close();}
const name=observation.observedAt.replace(/[:.]/g,'-');
observation.rawFile=`data/raw/${name}.txt`;
writeFileSync(observation.rawFile,raw||'(No page text captured)');
appendFileSync('data/observations.jsonl',JSON.stringify(observation)+'\n');
history.push(observation);
const good=history.filter(s=>s.status==='ok');
const latest=good.at(-1);
const lines=['# Circuit 2 availability','',`Latest check: ${observation.observedAt} — ${observation.status}`,'','Times in the history are UTC; collection days use Peru time.',''];
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
