// usage: node tools/trace.js src/sim.js ticks [seed] — prints population, perks and deaths every 1000 ticks
const fs=require('fs');const src=fs.readFileSync(process.argv[2],'utf8');const N=+process.argv[3]||10000;
let s=+process.argv[4]||12345;Math.random=()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296};
const MC=function(){this.port1={};this.port2={postMessage(){}}};const self={postMessage(){}};
const api=new Function('self','postMessage','setTimeout','MessageChannel',src+';return {tick,agents:()=>agents,deathsBy:()=>deathsBy,items:()=>items}')(self,()=>{},()=>{},MC);
self.onmessage({data:{type:'init',shape:'wide'}});
for(let i=1;i<=N;i++){api.tick();if(i%1000===0){const A=api.agents();const c={};for(const a of A)for(const p of a.perks||[])c[p]=(c[p]||0)+1;
 const e=A.reduce((x,a)=>x+a.energy,0)/Math.max(1,A.length);console.log(i,'pop',A.length,'avgE',e.toFixed(0),'food',api.items().filter(x=>x.t===0).length,'deaths',JSON.stringify(api.deathsBy()),'perks',JSON.stringify(c))}}
