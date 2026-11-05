// usage: node tools/trace.js src/sim.js ticks [seed] [every] — population, bodies, energy ledger and deaths over a headless run
const fs=require('fs');const src=fs.readFileSync(process.argv[2],'utf8');const N=+process.argv[3]||10000, EVERY=+process.argv[5]||1000;
let s=+process.argv[4]||12345;Math.random=()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296};
const MC=function(){this.port1={};this.port2={postMessage(){}}};const self={postMessage(){}};
const api=new Function('self','postMessage','setTimeout','MessageChannel',src+';return {births:()=>births,tick,agents:()=>agents,beasts:()=>beasts,deathsBy:()=>deathsBy,items:()=>items,tally:()=>tally,ledger:()=>{audit();return ledgerLast},worldE:()=>worldE,gardens:()=>gardens.length}')(self,()=>{},()=>{},MC);
self.onmessage({data:{type:'init',shape:'wide'}});
const f=(x,d=0)=>(+x).toFixed(d), t0=Date.now();
for(let i=1;i<=N;i++){api.tick();if(i%EVERY===0){const A=api.agents(),n=Math.max(1,A.length),av=k=>A.reduce((x,a)=>x+(typeof k==='function'?k(a):a[k]),0)/n;
 const L=api.ledger(), T=api.tally(), cnt=[0,0,0,0]; for(const it of api.items()) if(!it.dead) cnt[it.t]++;
 let both=0,c=0,si=0; for(const a of A){const w=a.ph.womb>.05,se=a.ph.seed>.05; if(w&&se)both++; else if(w)c++; else if(se)si++;}
 console.log(`${i} pop ${A.length} gen ${f(av('gen'),1)} E ${f(av('energy'))} gut ${f(av('gut'))} fat ${f(av('fat'))} burn ${f(av(a=>a.burn||0),3)} mass ${f(av('mass'),2)} sick ${A.filter(a=>a.sick>.05).length} preg ${A.filter(a=>a.preg).length} | food ${cnt[0]} carc ${cnt[3]} beasts ${api.beasts().length} gardens ${api.gardens()} | reserve ${f(L.reserve/L.total*100)}% yips ${f(L.yips)} plants ${f(L.plants)} soil ${f(L.soil)} drift ${f(L.drift,1)} | births ${api.births()} concept ${T.conceptions} misc ${T.miscarriages} inf ${T.infections} meals ${T.meals} plant ${T.plantings} cann ${T.cannibal} | sexes ${both}/${c}/${si} | deaths ${JSON.stringify(api.deathsBy())} ${((Date.now()-t0)/i*1000|0)}us/t`);}}
