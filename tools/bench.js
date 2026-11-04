// usage: node bench.js file.js ticks
const fs=require('fs');const src=fs.readFileSync(process.argv[2],'utf8');const N=+process.argv[3]||3000;
let tickFn=null;const self={postMessage(){},onmessage:null};
global.postMessage=()=>{};global.setTimeout=()=>{};
const MC=function(){this.port1={};this.port2={postMessage(){}}};
const f=new Function('self','postMessage','setTimeout','MessageChannel',src+';return {onmsg:()=>self.onmessage,tick, agents:()=>agents, items:()=>items, extra:()=>typeof tally!=="undefined"?JSON.stringify(tally)+" beasts "+beasts.length+" deaths "+JSON.stringify(deathsBy)+" maxGen "+maxGen:""};');
Math.random=(()=>{let s=12345;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296}})();
const api=f(self,()=>{},()=>{},MC);
self.onmessage({data:{type:'init',shape:'wide'}});
const t0=performance.now();let popSum=0;
for(let i=0;i<N;i++){api.tick();popSum+=api.agents().length}
const dt=performance.now()-t0;
console.log(api.extra());console.log(process.argv[2].split('/').pop(),`${N} ticks in ${dt.toFixed(0)}ms = ${(N/dt*1000).toFixed(0)} tps, avg pop ${(popSum/N).toFixed(0)}, final pop ${api.agents().length}, items ${api.items().length}`);
