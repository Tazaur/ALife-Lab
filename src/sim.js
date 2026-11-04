'use strict';
// ALife Lab simulation core. Runs inside a Web Worker (or a main-thread shim).
// Hot paths use flat Float32Array weights, per-type spatial grids and zero-allocation sensing.
const W = 840, H = 520, CELL = 32, GC = Math.ceil(W / CELL) + 1, GR = Math.ceil(H / CELL) + 1;
const SENSES = {bias:'Constant',energy:'Energy reserve',health:'Health',age:'Age',temp:'Local temperature',comfort:'Thermal comfort',strength:'Strength',speed:'Speed',load:'Carried weight',foodX:'Food direction X',foodY:'Food direction Y',foodNear:'Food proximity',treeX:'Tree direction X',treeY:'Tree direction Y',stoneX:'Stone direction X',stoneY:'Stone direction Y',shelterX:'Shelter direction X',shelterY:'Shelter direction Y',shelterNear:'Shelter proximity',fireNear:'Fire proximity',stormNear:'Storm proximity',stormX:'Storm direction X',stormY:'Storm direction Y',agentX:'Agent direction X',agentY:'Agent direction Y',agentNear:'Agent proximity',agentHue:'Nearest agent color',agentID:'Nearest agent identity',trust:'Trust toward nearest agent',signal:'Nearby signal',ownHue:'Own color',memory:'Internal memory',foodStock:'Carried food',woodStock:'Carried wood',stoneStock:'Carried stone',structureHP:'Nearby structure condition',time:'Day phase',season:'Season phase',random:'Noise'};
const KEYS = Object.keys(SENSES);
const ACTIONS = ['Move north','Move east','Move south','Move west','Harvest','Eat','Deposit','Build house','Build storehouse','Build wall','Build fire','Repair','Signal / share','Rest'];
const O = ACTIONS.length;
const ITYPES = ['food','tree','stone'];
const BTYPES = ['house','store','wall','fire'];
const SPECS = {house:{wood:3,stone:1,hp:450,r:16},store:{wood:5,stone:4,hp:720,r:23},wall:{wood:1,stone:2,hp:380,r:11},fire:{wood:2,stone:0,hp:180,r:12}};
const LIMITS = {layers:5, neurons:15, inputs:18};
const DX = [0,1,0,-1], DY = [-1,0,1,0];
const settings = {food:2.5,trees:.09,stone:.06,drain:1,decay:1,storm:1,temperature:19,day:500,season:2600,autoReseed:true};

const rnd = (a,b) => a + Math.random()*(b-a);
const clamp = (x,a,b) => x < a ? a : x > b ? b : x;
const pick = a => a[Math.floor(Math.random()*a.length)];

let agents=[], items=[], buildings=[], storms=[], events=[], history=[], elite=[];
let ticks=0, nextId=1, nextBid=1, births=0, deaths=0, maxGen=0, peakPop=0, selected=0;
let deathsBy = {age:0,hunger:0,storm:0,fire:0};
let lastMilestone = 0, baseTemp = 19, dayS = 0, seasonS = 0;

// ---------- spatial grids ----------
const mkGrid = () => Array.from({length: GC*GR}, () => []);
const gFood = mkGrid(), gTree = mkGrid(), gStone = mkGrid(), gAgent = mkGrid();
const GRIDS = [gFood, gTree, gStone];
function clearGrid(g){ for (let i=0;i<g.length;i++) g[i].length = 0; }
function cellOf(x,y){ return clamp(x/CELL|0,0,GC-1) + clamp(y/CELL|0,0,GR-1)*GC; }
function nearestIn(g, a, r, q, skip){
  // expanding-ring search: stops as soon as no unvisited ring can hold anything closer
  let best=null, d2=r*r;
  const cx0=clamp(a.x/CELL|0,0,GC-1), cy0=clamp(a.y/CELL|0,0,GR-1), K=Math.ceil(r/CELL)+1;
  for (let k=0;k<=K;k++){
    const y0=cy0-k, y1=cy0+k, x0=cx0-k, x1=cx0+k;
    for (let cy=y0; cy<=y1; cy++){
      if (cy<0||cy>=GR) continue;
      const edge=cy===y0||cy===y1, step=edge?1:x1-x0;
      for (let cx=x0; cx<=x1; cx+=step||1){
        if (cx<0||cx>=GC) continue;
        const bin=g[cx+cy*GC];
        for (let n=0;n<bin.length;n++){ const o=bin[n]; if (o.dead||o===skip) continue; const dx=o.x-a.x, dy=o.y-a.y, dd=dx*dx+dy*dy; if (dd<d2){ d2=dd; best=o; } }
      }
    }
    const reach=k*CELL; if (reach*reach>=d2) break;
  }
  q.obj=best; q.dist=best?Math.sqrt(d2):r; return q;
}
function nearestBuilding(a, r, q, pred){
  let best=null, d2=r*r;
  for (const b of buildings){ if (!pred(b)) continue; const dx=b.x-a.x, dy=b.y-a.y, dd=dx*dx+dy*dy; if (dd<d2){ d2=dd; best=b; } }
  q.obj=best; q.dist=best?Math.sqrt(d2):r; return q;
}
function nearestStorm(a, r, q){
  let best=null, d2=r*r;
  for (const s of storms){ const dx=s.x-a.x, dy=s.y-a.y, dd=dx*dx+dy*dy; if (dd<d2){ d2=dd; best=s; } }
  q.obj=best; q.dist=best?Math.sqrt(d2):r; return q;
}
const isShelter = b => b.type==='house' || b.type==='store';
const isFire = b => b.type==='fire';
const env = {food:{},tree:{},stone:{},shelter:{},fire:{},storm:{},other:{}};

// ---------- brains ----------
function randArr(n, s=.65){ const f=new Float32Array(n); for (let i=0;i<n;i++) f[i]=rnd(-s,s); return f; }
function freshBrain(){ const inputs=['bias','energy','foodX','foodY','foodNear','temp','load','agentNear']; return {inputs, sizes:[inputs.length,9,O], w:[randArr(9*inputs.length), randArr(O*9)]}; }
function copyBrain(b){ return {inputs:[...b.inputs], sizes:[...b.sizes], w:b.w.map(f=>new Float32Array(f))}; }
function toNested(b){ return {inputs:[...b.inputs], sizes:[...b.sizes], weights:b.w.map((f,l)=>{ const rows=b.sizes[l+1], cols=b.sizes[l], m=[]; for (let j=0;j<rows;j++) m.push(Array.from(f.subarray(j*cols,(j+1)*cols))); return m; })}; }
function fromNested(n){ return {inputs:n.inputs, sizes:n.sizes, w:n.weights.map((m,l)=>{ const cols=n.sizes[l], f=new Float32Array(m.length*cols); m.forEach((r,j)=>f.set(r.slice(0,cols),j*cols)); return f; })}; }
const mat = (n,m) => Array.from({length:n}, () => Array.from({length:m}, () => rnd(-.65,.65)));
function mutateBrain(src){
  const b = toNested(src);
  if (Math.random()<.18){
    const mode=pick(['add','remove','replace']), avail=KEYS.filter(k=>!b.inputs.includes(k));
    if (mode==='add' && avail.length && b.inputs.length<LIMITS.inputs){ const i=Math.floor(rnd(0,b.inputs.length+1)); b.inputs.splice(i,0,pick(avail)); b.weights[0].forEach(r=>r.splice(i,0,rnd(-.5,.5))); b.sizes[0]++; }
    else if (mode==='remove' && b.inputs.length>3){ const i=Math.floor(rnd(0,b.inputs.length)); b.inputs.splice(i,1); b.weights[0].forEach(r=>r.splice(i,1)); b.sizes[0]--; }
    else if (mode==='replace' && avail.length) b.inputs[Math.floor(rnd(0,b.inputs.length))]=pick(avail);
  }
  if (Math.random()<.07 && b.sizes.length-2<LIMITS.layers){
    const at=Math.floor(rnd(1,b.sizes.length-1)), n=Math.floor(rnd(3,9)), prev=b.sizes[at-1], next=b.sizes[at];
    b.sizes.splice(at,0,n); b.weights.splice(at-1,1,mat(n,prev),mat(next,n));
  } else if (Math.random()<.035 && b.sizes.length>3){
    const at=Math.floor(rnd(1,b.sizes.length-1)); b.sizes.splice(at,1); b.weights.splice(at-1,2,mat(b.sizes[at],b.sizes[at-1]));
  }
  if (Math.random()<.18){
    const l=Math.floor(rnd(1,b.sizes.length-1)), n=b.sizes[l];
    if (Math.random()<.55 && n<LIMITS.neurons){ b.weights[l-1].push(Array.from({length:b.sizes[l-1]},()=>rnd(-.5,.5))); b.weights[l].forEach(r=>r.push(rnd(-.5,.5))); b.sizes[l]++; }
    else if (n>2){ const i=Math.floor(rnd(0,n)); b.weights[l-1].splice(i,1); b.weights[l].forEach(r=>r.splice(i,1)); b.sizes[l]--; }
  }
  for (const m of b.weights) for (const r of m) for (let i=0;i<r.length;i++){ if (Math.random()<.13) r[i]=clamp(r[i]+rnd(-.38,.38),-3,3); if (Math.random()<.003) r[i]=0; }
  return fromNested(b);
}
function brainState(a){ a.learned=a.brain.w.map(f=>new Float32Array(f.length)); a.acts=a.brain.sizes.map(n=>new Float32Array(n)); }

const ex = new Float64Array(O), gradA = new Float64Array(32), gradB = new Float64Array(32);
function forward(a){
  const b=a.brain, acts=a.acts, L=b.w.length;
  for (let l=0;l<L;l++){
    const p=acts[l], out=acts[l+1], w=b.w[l], d=a.learned[l], cols=b.sizes[l], rows=b.sizes[l+1];
    for (let j=0;j<rows;j++){ let s=0, base=j*cols; for (let i=0;i<cols;i++) s+=(w[base+i]+d[base+i])*p[i]; out[j]=Math.tanh(s); }
  }
  const z=acts[L], temp=.22+a.traits.explore; let m=-1e9;
  for (let i=0;i<O;i++) if (z[i]>m) m=z[i];
  let sum=0; for (let i=0;i<O;i++){ ex[i]=Math.exp((z[i]-m)/temp); sum+=ex[i]; }
  let r=Math.random(), choice=O-1;
  for (let i=0;i<O;i++){ a.probs[i]=ex[i]/sum; }
  for (let i=0;i<O;i++){ if ((r-=a.probs[i])<=0){ choice=i; break; } }
  a.lastChoice=choice; return temp;
}
function learn(a, reward, temp){
  const adv=clamp(reward-a.baseline,-4,4); a.baseline=.98*a.baseline+.02*reward;
  const b=a.brain, acts=a.acts, lr=a.traits.lr; let grad=gradA, back=gradB;
  for (let i=0;i<O;i++) grad[i]=lr*adv*((i===a.lastChoice?1:0)-a.probs[i])/temp;
  for (let l=b.w.length-1;l>=0;l--){
    const w=b.w[l], d=a.learned[l], prev=acts[l], next=acts[l+1], cols=b.sizes[l], rows=b.sizes[l+1];
    for (let i=0;i<cols;i++) back[i]=0;
    for (let j=0;j<rows;j++){
      const g=grad[j]*(1-next[j]*next[j]); if (g===0) continue; const base=j*cols;
      for (let i=0;i<cols;i++){ const k=base+i; back[i]+=g*(w[k]+d[k]); const v=d[k]+g*prev[i]; d[k]=v>1.2?1.2:v<-1.2?-1.2:v; }
    }
    const t=grad; grad=back; back=t;
  }
}

// ---------- agents ----------
function freshTraits(){ return {budget:rnd(5,8),strength:rnd(.8,1.5),speed:rnd(.8,1.6),thermal:rnd(.6,1.4),sense:rnd(60,130),social:rnd(.3,1.4),lr:rnd(.001,.03),explore:rnd(.12,1.2),hue:rnd(0,360)}; }
const traitCost = t => t.strength*1.7+t.speed*1.5+t.thermal*.8+t.sense/95+t.social*.35;
const traitMetab = t => .7+.12*t.budget+.13*Math.max(0,traitCost(t)-t.budget)+.025*traitCost(t);
const TB = {lr:[.0001,.15],explore:[.02,2.8],sense:[30,210],budget:[2,15],speed:[.2,3],strength:[.2,3]};
function mutateTraits(src){ const t={}; for (const k in src){ const v=src[k]; if (k==='hue') t[k]=(v+rnd(-20,20)+360)%360; else { const [lo,hi]=TB[k]||[.2,2.5]; t[k]=clamp(v*Math.exp(rnd(-.18,.18)),lo,hi); } } return t; }
function makeAgent(x,y,brain=freshBrain(),gen=0,parent=null,traits=freshTraits(),energy=90,lineage=[]){
  const a={id:nextId++,x,y,vx:0,vy:0,hd:rnd(0,6.283),brain,gen,parent,lineage,traits,energy,health:100,age:0,lifespan:rnd(3600,5100),
    inv:{food:0,wood:0,stone:0},memory:0,signal:0,trust:new Map(),lastChoice:13,probs:new Float32Array(O),builds:0,success:0,kids:0,
    actionCounts:new Uint32Array(O),baseline:0,sheltered:false,harm:'hunger'};
  brainState(a); if (gen>maxGen) maxGen=gen; return a;
}
function child(a){
  const lineage=[{id:a.id,gen:a.gen,hue:a.traits.hue},...a.lineage].slice(0,12);
  const c=makeAgent(clamp(a.x+rnd(-13,13),8,W-8),clamp(a.y+rnd(-13,13),8,H-8),mutateBrain(a.brain),a.gen+1,a.id,mutateTraits(a.traits),60,lineage);
  a.kids++; return c;
}
const load = a => a.inv.food+a.inv.wood*1.4+a.inv.stone*2;
const capacity = a => 2+a.traits.strength*4;
function setTrust(a,id,v){ a.trust.set(id,clamp(v,-1,1)); if (a.trust.size>48){ const keep=[...a.trust].sort((x,y)=>Math.abs(y[1])-Math.abs(x[1])).slice(0,32); a.trust=new Map(keep); } }

function addItem(type,x=rnd(5,W-5),y=rnd(5,H-5)){
  if (items.length>1200) return;
  const t=ITYPES.indexOf(type), life=t===0?rnd(400,1100):t===1?rnd(1600,3600):rnd(2500,6000);
  items.push({t,type,x:clamp(x,4,W-4),y:clamp(y,4,H-4),life,max:life,dead:false});
}
function occupied(x,y,r){ return buildings.some(b=>Math.hypot(b.x-x,b.y-y)<b.r+r+3); }
function placeBuilding(type,x,y,owner){ const s=SPECS[type]; buildings.push({id:nextBid++,type,x,y,r:s.r,hp:s.hp,max:s.hp,owner,stock:{food:0,wood:0,stone:0},life:type==='fire'?600:10000,max_life:type==='fire'?600:10000}); }
function build(type,a){
  const s=SPECS[type], r=s.r;
  if (buildings.length>=100||a.inv.wood<s.wood||a.inv.stone<s.stone) return false;
  // fires are lit a step ahead of the builder so it does not stand in the flames
  let x=a.x, y=a.y; if (type==='fire'){ x+=Math.cos(a.hd)*(r+7); y+=Math.sin(a.hd)*(r+7); }
  if (x<r||y<r||x>W-r||y>H-r||occupied(x,y,r)) return false;
  a.inv.wood-=s.wood; a.inv.stone-=s.stone; placeBuilding(type,x,y,a.id); a.builds++;
  if (buildings.length%10===0) log(`${buildings.length} structures standing`,'build');
  return true;
}
function log(s,kind='info'){ events.unshift({t:ticks,s,kind}); if (events.length>60) events.length=60; }
function toast(s,kind){ self.postMessage({type:'toast',s,kind}); }

// ---------- environment ----------
function temperature(){ return settings.temperature+dayS*6+seasonS*10; }
function stormAt(a){ for (const s of storms) if (Math.abs(a.x-s.x)<s.w/2&&Math.abs(a.y-s.y)<s.h/2) return s; return null; }
function inside(a){
  for (const b of buildings){ if (!isShelter(b)||b.hp<=0) continue; const dx=a.x-b.x, dy=a.y-b.y; if (dx*dx+dy*dy<(b.r-1)*(b.r-1) && (!b.owner||b.owner===a.id||(a.trust.get(b.owner)||0)>-.25)) return b; }
  return null;
}
function tempAt(a){ let t=baseTemp; for (const b of buildings) if (b.type==='fire'&&b.hp>0){ const d=Math.hypot(a.x-b.x,a.y-b.y); if (d<65) t+=22*(1-d/65); } return t; }
function sensory(a,k,e){
  const range=a.traits.sense, dir=(q,ax)=>q.obj?(q.obj[ax]-a[ax])/Math.max(1,q.dist):0, pro=q=>q.obj?1-q.dist/range:0;
  switch(k){
    case 'bias':return 1; case 'energy':return clamp(a.energy/90-1,-1,1); case 'health':return a.health/100; case 'age':return clamp(a.age/2000,0,1);
    case 'temp':return clamp((a._t-20)/30,-1,1); case 'comfort':return clamp(1-Math.abs(a._t-20)/(12*a.traits.thermal),-1,1);
    case 'strength':return a.traits.strength/3; case 'speed':return a.traits.speed/3; case 'load':return load(a)/capacity(a);
    case 'foodX':return dir(e.food,'x'); case 'foodY':return dir(e.food,'y'); case 'foodNear':return pro(e.food);
    case 'treeX':return dir(e.tree,'x'); case 'treeY':return dir(e.tree,'y'); case 'stoneX':return dir(e.stone,'x'); case 'stoneY':return dir(e.stone,'y');
    case 'shelterX':return dir(e.shelter,'x'); case 'shelterY':return dir(e.shelter,'y'); case 'shelterNear':return pro(e.shelter); case 'fireNear':return pro(e.fire);
    case 'stormNear':return stormAt(a)?1:pro(e.storm); case 'stormX':return dir(e.storm,'x'); case 'stormY':return dir(e.storm,'y');
    case 'agentX':return dir(e.other,'x'); case 'agentY':return dir(e.other,'y'); case 'agentNear':return pro(e.other);
    case 'agentHue':return e.other.obj?Math.cos(e.other.obj.traits.hue*Math.PI/180):0; case 'agentID':return e.other.obj?((e.other.obj.id*7919)%101)/50-1:0;
    case 'trust':return e.other.obj?(a.trust.get(e.other.obj.id)||0):0; case 'signal':return e.other.obj?e.other.obj.signal:0;
    case 'ownHue':return Math.cos(a.traits.hue*Math.PI/180); case 'memory':return a.memory;
    case 'foodStock':return a.inv.food/8; case 'woodStock':return a.inv.wood/8; case 'stoneStock':return a.inv.stone/8;
    case 'structureHP':return e.shelter.obj?e.shelter.obj.hp/e.shelter.obj.max:0;
    case 'time':return Math.sin(ticks*2*Math.PI/settings.day); case 'season':return seasonS; case 'random':return rnd(-1,1); default:return 0;
  }
}
function wallBlocks(nx,ny){ for (const b of buildings) if (b.type==='wall'&&b.hp>0){ const dx=b.x-nx, dy=b.y-ny, rr=b.r+3; if (dx*dx+dy*dy<rr*rr) return true; } return false; }

function act(a,choice,e){
  let reward=-.012, moved=false; const insideNow=inside(a); a.actionCounts[choice]++;
  if (choice<4){
    const sp=(.7+a.traits.speed*1.7)/(1+load(a)/(capacity(a)*1.2));
    a.vx=a.vx*.35+DX[choice]*sp*.65; a.vy=a.vy*.35+DY[choice]*sp*.65; a.energy-=.008*sp; reward+=.008; moved=true;
  } else if (choice===4){
    let best=null, bd=11;
    for (let t=0;t<3;t++){ const q=nearestIn(GRIDS[t],a,11,env._h||(env._h={})); if (q.obj&&q.dist<bd){ bd=q.dist; best=q.obj; } }
    if (best && load(a)+1<=capacity(a)){ a.inv[best.t===1?'wood':best.type]++; best.dead=true; reward+=best.t===0?.65:.3; a.success++; }
  } else if (choice===5){
    if (a.inv.food>0&&a.energy<170){ a.inv.food--; a.energy+=30; reward+=1.2; }
    else if (insideNow&&insideNow.stock.food>0&&a.energy<170){ insideNow.stock.food--; a.energy+=30; reward+=1.1; }
  } else if (choice===6){
    if (insideNow){ let n=0; for (const k of ['food','wood','stone']) if (a.inv[k]>0){ insideNow.stock[k]+=a.inv[k]; n+=a.inv[k]; a.inv[k]=0; } reward+=Math.min(.4,n*.09); }
  } else if (choice<=10){
    if (build(BTYPES[choice-7],a)) reward+=.45; else reward-=.08;
  } else if (choice===11){
    const b=nearestBuilding(a,17,env._r||(env._r={}),x=>x.hp<x.max*.85).obj;
    if (b&&a.inv.wood>=1&&(b.type==='fire'||a.inv.stone>=1)){ a.inv.wood--; if (b.type!=='fire') a.inv.stone--; b.hp=Math.min(b.max,b.hp+90); reward+=.65; }
  } else if (choice===12){
    a.signal=rnd(-1,1)*a.traits.social; const o=e.other.obj;
    if (o&&e.other.dist<16){
      const tr=a.trust.get(o.id)||0;
      if (tr>-.5&&a.inv.food>0&&o.energy<a.energy-20){ a.inv.food--; o.inv.food++; setTrust(o,a.id,(o.trust.get(a.id)||0)+.2); setTrust(a,o.id,tr+.05); reward+=.15; }
      else if (tr<-.65&&a.traits.strength>o.traits.strength&&o.inv.food>0){ o.inv.food--; a.inv.food++; setTrust(o,a.id,-1); reward+=.25; }
      else setTrust(a,o.id,tr+.005);
    }
  } else {
    if (insideNow){ a.energy+=.16; a.health=Math.min(100,a.health+.06); reward+=.08; }
    else if (nearestBuilding(a,18,env._f2||(env._f2={}),isFire).obj) a.energy+=.04;
  }
  if (!moved){ a.vx*=.5; a.vy*=.5; }
  if (a.vx*a.vx+a.vy*a.vy>.0004){
    const nx=clamp(a.x+a.vx,4,W-4), ny=clamp(a.y+a.vy,4,H-4);
    if (wallBlocks(nx,ny)){ a.vx=a.vy=0; if (moved) reward-=.06; } else { a.x=nx; a.y=ny; }
    if (moved) a.hd=Math.atan2(a.vy,a.vx);
  }
  return reward;
}

function sendStorm(){ storms.push({x:-120,y:rnd(50,H-50),w:rnd(85,150),h:rnd(120,260),vx:rnd(1.1,2.5),vy:rnd(-.1,.1),life:650,max:650}); log('Storm front moving in from the west','storm'); toast('Storm front incoming','storm'); }
function archive(a){
  const score=a.age+a.kids*350+a.builds*60+a.success*2;
  if (elite.length<24||score>elite[elite.length-1].score){
    elite.push({score,gen:a.gen,id:a.id,traits:{...a.traits},brain:copyBrain(a.brain)});
    elite.sort((x,y)=>y.score-x.score); if (elite.length>24) elite.length=24;
  }
}
function reseed(){
  const n=40;
  for (let i=0;i<n;i++){
    const src=elite.length?pick(elite):null;
    agents.push(src?makeAgent(rnd(10,W-10),rnd(10,H-10),mutateBrain(src.brain),src.gen+1,null,mutateTraits(src.traits),90,[{id:src.id,gen:src.gen,hue:src.traits.hue}]):makeAgent(rnd(10,W-10),rnd(10,H-10)));
  }
  log(`Extinction. ${n} colonists reseeded from ${elite.length?elite.length+' archived genomes':'scratch'}`,'death');
  toast('Extinction: colony reseeded from the archive','death');
}

function tick(){
  ticks++;
  dayS=Math.sin(2*Math.PI*ticks/settings.day); seasonS=settings.season?Math.sin(2*Math.PI*ticks/settings.season):0; baseTemp=temperature();
  const rate=settings.food*(1+.35*seasonS);
  for (let i=0;i<Math.floor(rate);i++) addItem('food');
  if (Math.random()<rate%1) addItem('food');
  if (Math.random()<settings.trees) addItem('tree');
  if (Math.random()<settings.stone) addItem('stone');
  // decay + compact items in place
  let w=0; for (let i=0;i<items.length;i++){ const it=items[i]; if (it.dead) continue; it.life-=settings.decay; if (it.life<=0) continue; items[w++]=it; } items.length=w;
  for (let i=buildings.length-1;i>=0;i--){
    const b=buildings[i], prot=b.type==='store'?3:b.type==='house'?2:1;
    b.hp-=settings.decay*(b.type==='fire'?.6:.045); b.life-=settings.decay;
    for (const k in b.stock){ if (!b.stock[k]) continue; if (Math.random()<(k==='food'?.0008:.00014)*settings.decay/prot) b.stock[k]--; }
    if (b.hp<=0||b.life<=0){ buildings.splice(i,1); if (isShelter(b)) log(`${b.type==='store'?'Storehouse':'House'} collapsed`,'build'); }
  }
  for (let i=storms.length-1;i>=0;i--){ const s=storms[i]; s.x+=s.vx; s.y+=s.vy; s.life--; if (s.life<=0||s.x>W+s.w||s.x<-s.w*2) storms.splice(i,1); }
  if (ticks%1500===0&&Math.random()<.7) sendStorm();

  clearGrid(gFood); clearGrid(gTree); clearGrid(gStone); clearGrid(gAgent);
  for (const it of items) GRIDS[it.t][cellOf(it.x,it.y)].push(it);
  for (const a of agents) gAgent[cellOf(a.x,a.y)].push(a);

  const newborn=[]; let dead=0;
  for (const a of agents){
    a.age++; a.signal*=.94;
    const r=a.traits.sense;
    nearestIn(gFood,a,r,env.food); nearestIn(gTree,a,r,env.tree); nearestIn(gStone,a,r,env.stone);
    nearestBuilding(a,r,env.shelter,isShelter); nearestBuilding(a,r,env.fire,isFire); nearestStorm(a,r,env.storm); nearestIn(gAgent,a,r,env.other,a);
    a._t=tempAt(a);
    const inp=a.acts[0], keys=a.brain.inputs;
    for (let i=0;i<keys.length;i++) inp[i]=sensory(a,keys[i],env);
    const temp=forward(a);
    let reward=act(a,a.lastChoice,env);
    const sheltered=inside(a), storm=stormAt(a), lt=tempAt(a), cold=Math.max(0,15-lt), hot=Math.max(0,lt-31), thermal=(cold+hot)/(16*a.traits.thermal);
    a.sheltered=!!sheltered;
    let nn=0; for (const s of a.brain.sizes) nn+=s;
    a.energy-=.11*settings.drain*traitMetab(a.traits)+.005*nn+thermal*(sheltered?.009:.045);
    if (storm&&!sheltered){ a.health-=.15*settings.storm; a.energy-=.12*settings.storm; a.harm='storm'; }
    for (const b of buildings) if (b.type==='fire'){ const dx=a.x-b.x, dy=a.y-b.y; if (dx*dx+dy*dy<(b.r+2)*(b.r+2)){ a.health-=.9; a.energy-=.1; a.harm='fire'; } }
    if (a.energy<0){ a.health+=a.energy*.08; a.energy=0; a.harm='hunger'; }
    if (a.energy>200) a.energy=200;
    if (a.energy<45&&a.inv.food>0){ a.inv.food--; a.energy=Math.min(200,a.energy+28); reward+=.7; }
    a.memory=clamp(.96*a.memory+.04*(a.energy/100-1),-1,1);
    reward+=clamp((a.energy-80)/200,-.1,.1);
    learn(a,reward,temp);
    if (a.energy>135&&a.age>100&&Math.random()<.012&&agents.length+newborn.length<220){
      a.energy-=60; const c=child(a); newborn.push(c); births++;
      if (births%50===0) log(`${births} births so far, newest is generation ${c.gen}`,'birth');
      if (c.gen>=lastMilestone+10){ lastMilestone=c.gen-c.gen%10; toast(`Generation ${lastMilestone} reached`,'birth'); log(`Generation ${lastMilestone} reached`,'birth'); }
    }
    if (a.health<=0||a.age>a.lifespan){ a.dead=true; dead++; deaths++; deathsBy[a.age>a.lifespan?'age':a.harm]++; archive(a); }
  }
  if (dead) agents=agents.filter(a=>!a.dead);
  for (const c of newborn) agents.push(c);
  if (agents.length>peakPop) peakPop=agents.length;
  if (!agents.length&&settings.autoReseed) reseed();
  if (ticks%25===0) pushHistory();
}
function avg(f){ if (!agents.length) return 0; let s=0; for (const a of agents) s+=f(a); return s/agents.length; }
function pushHistory(){
  let food=0; for (const it of items) if (!it.dead&&it.t===0) food++;
  history.push({t:ticks,pop:agents.length,food,build:buildings.length,gen:avg(a=>a.gen),str:avg(a=>a.traits.strength),spd:avg(a=>a.traits.speed),sense:avg(a=>a.traits.sense),neurons:avg(a=>a.brain.sizes.reduce((s,n)=>s+n,0)),births,deaths});
  if (history.length>480) history.shift();
}

function reset(){
  agents=[]; items=[]; buildings=[]; storms=[]; events=[]; history=[]; elite=[];
  ticks=0; nextId=1; nextBid=1; births=0; deaths=0; maxGen=0; lastMilestone=0; peakPop=0; deathsBy={age:0,hunger:0,storm:0,fire:0};
  for (let i=0;i<100;i++) agents.push(makeAgent(rnd(10,W-10),rnd(10,H-10)));
  for (let i=0;i<320;i++) addItem('food'); for (let i=0;i<115;i++) addItem('tree'); for (let i=0;i<95;i++) addItem('stone');
  selected=0; log('100 founders released into a finite ecosystem','birth');
}

// ---------- serialization ----------
const r4 = v => Math.round(v*1e4)/1e4, r2 = v => Math.round(v*100)/100;
const serBrain = b => ({inputs:b.inputs,sizes:b.sizes,w:b.w.map(f=>Array.from(f,r4))});
function serialize(){
  return {version:10,ticks,nextId,nextBid,births,deaths,deathsBy,maxGen,peakPop,selected,settings:{...settings},
    agents:agents.map(a=>({id:a.id,x:r2(a.x),y:r2(a.y),hd:r2(a.hd),gen:a.gen,parent:a.parent,lineage:a.lineage,traits:a.traits,energy:r2(a.energy),health:r2(a.health),age:a.age,lifespan:a.lifespan|0,inv:a.inv,memory:r4(a.memory),builds:a.builds,success:a.success,kids:a.kids,baseline:r4(a.baseline),trust:[...a.trust].map(([k,v])=>[k,r4(v)]),actionCounts:Array.from(a.actionCounts),brain:serBrain(a.brain),learned:a.learned.map(f=>Array.from(f,r4))})),
    items:items.filter(i=>!i.dead).map(i=>[i.t,r2(i.x),r2(i.y),i.life|0,i.max|0]),
    buildings:buildings.map(b=>({...b,hp:r2(b.hp)})),storms,events,history,elite:elite.map(e=>({...e,brain:serBrain(e.brain)}))};
}
const deBrain = b => b.weights ? fromNested(b) : {inputs:b.inputs,sizes:b.sizes,w:b.w.map(x=>Float32Array.from(x))};
function deLearned(l,brain){ if (!l) return brain.w.map(f=>new Float32Array(f.length)); return l.map((x,i)=>{ if (Array.isArray(x[0])){ const f=new Float32Array(brain.w[i].length), cols=brain.sizes[i]; x.forEach((r,j)=>f.set(r.slice(0,cols),j*cols)); return f; } return Float32Array.from(x); }); }
function deserialize(s){
  if (!s||!Array.isArray(s.agents)||(s.version!==10&&s.version!==6)) throw Error('Not an ALife Lab save (expected version 0.6 or 1.0)');
  const reg=s.registry||{};
  const A=s.agents.map(o=>{
    const brain=deBrain(o.brain);
    const a={...makeAgent(o.x,o.y,brain,o.gen,o.parent,o.traits,o.energy),id:o.id};
    Object.assign(a,{health:o.health,age:o.age,lifespan:o.lifespan||rnd(3600,5100),inv:o.inv||{food:0,wood:0,stone:0},memory:o.memory||0,builds:o.builds||0,success:o.success||0,kids:o.kids||0,baseline:o.baseline||0,hd:o.hd||0});
    a.trust=new Map(Array.isArray(o.trust)?o.trust:Object.entries(o.trust||{}).map(([k,v])=>[+k,v]));
    if (o.actionCounts) a.actionCounts=Uint32Array.from(o.actionCounts);
    a.learned=deLearned(o.learned,brain);
    if (o.lineage) a.lineage=o.lineage; else { const ch=[]; let id=o.parent; for (let i=0;i<12&&id&&reg[id];i++){ ch.push({id,gen:reg[id].gen,hue:0}); id=reg[id].parent; } a.lineage=ch; }
    return a;
  });
  agents=A; ticks=s.ticks||0; nextId=Math.max(s.nextId||1,...A.map(a=>a.id+1)); births=s.births||0; deaths=s.deaths||0;
  deathsBy=s.deathsBy||{age:0,hunger:0,storm:0,fire:0}; maxGen=s.maxGen||Math.max(0,...A.map(a=>a.gen)); peakPop=s.peakPop||A.length;
  items=(s.items||[]).map(i=>Array.isArray(i)?{t:i[0],type:ITYPES[i[0]],x:i[1],y:i[2],life:i[3],max:i[4]||i[3],dead:false}:{t:ITYPES.indexOf(i.type),type:i.type,x:i.x,y:i.y,life:i.life,max:i.life,dead:false});
  nextBid=1; buildings=(s.buildings||[]).map(b=>({...b,id:b.id||nextBid++,max_life:b.max_life||(b.type==='fire'?600:10000)})); nextBid=Math.max(nextBid,...buildings.map(b=>b.id+1),1);
  storms=(s.storms||[]).map(x=>({max:650,...x})); events=(s.events||[]).map(e=>typeof e==='string'?{t:0,s:e,kind:'info'}:e); history=Array.isArray(s.history)?s.history.filter(h=>h&&typeof h.pop==='number'):[];
  elite=(s.elite||[]).map(e=>({...e,brain:deBrain(e.brain)}));
  Object.assign(settings,s.settings||{}); selected=s.selected||0; lastMilestone=maxGen-maxGen%10;
  log('Snapshot loaded','info');
}

// ---------- reporting ----------
let running=true, speed=3, last=performance.now(), acc=0, stepsWin=0, tps=0, lastMetrics=last, lastFrame=0, lastStats=0, lastInspect=0, inspecting=false;
function postFrame(){
  const na=agents.length, A=new Float32Array(na*9);
  for (let i=0,o=0;i<na;i++,o+=9){ const a=agents[i]; A[o]=a.id; A[o+1]=a.x; A[o+2]=a.y; A[o+3]=a.traits.hue; A[o+4]=a.hd; A[o+5]=a.energy/200; A[o+6]=a.health/100; A[o+7]=(a.sheltered?1:0)|(a.inv.food+a.inv.wood+a.inv.stone>0?2:0); A[o+8]=a.traits.sense; }
  let ni=0; for (const it of items) if (!it.dead) ni++;
  const I=new Float32Array(ni*4); let o=0;
  for (const it of items){ if (it.dead) continue; I[o]=it.t; I[o+1]=it.x; I[o+2]=it.y; I[o+3]=it.life/it.max; o+=4; }
  const nb=buildings.length, B=new Float32Array(nb*8);
  for (let i=0,p=0;i<nb;i++,p+=8){ const b=buildings[i]; B[p]=BTYPES.indexOf(b.type); B[p+1]=b.x; B[p+2]=b.y; B[p+3]=b.r; B[p+4]=b.hp/b.max; B[p+5]=b.id; B[p+6]=b.stock.food+b.stock.wood+b.stock.stone; B[p+7]=b.life/(b.max_life||10000); }
  const S=new Float32Array(storms.length*5);
  storms.forEach((s,i)=>{ S[i*5]=s.x; S[i*5+1]=s.y; S[i*5+2]=s.w; S[i*5+3]=s.h; S[i*5+4]=s.life/(s.max||650); });
  self.postMessage({type:'frame',ticks,tps,running,temp:baseTemp,day:settings.day,season:settings.season,A,I,B,S},[A.buffer,I.buffer,B.buffer,S.buffer]);
}
function postStats(withHistory){
  const n=agents.length||1, sensUse={}, act=new Float64Array(O), byType={house:0,store:0,wall:0,fire:0};
  let layers=0, neurons=0, inputs=0;
  for (const a of agents){ for (const k of a.brain.inputs) sensUse[k]=(sensUse[k]||0)+1; let tot=0; for (let i=0;i<O;i++) tot+=a.actionCounts[i]; if (tot) for (let i=0;i<O;i++) act[i]+=a.actionCounts[i]/tot; layers+=a.brain.sizes.length-2; for (let l=1;l<a.brain.sizes.length-1;l++) neurons+=a.brain.sizes[l]; inputs+=a.brain.inputs.length; }
  for (const b of buildings) byType[b.type]++;
  const counts=[0,0,0]; for (const it of items) if (!it.dead) counts[it.t]++;
  const t=k=>avg(a=>a.traits[k]);
  self.postMessage({type:'stats',ticks,pop:agents.length,peakPop,births,deaths,deathsBy,maxGen,avgGen:avg(a=>a.gen),byType,counts,temp:baseTemp,
    traits:{strength:t('strength'),speed:t('speed'),thermal:t('thermal'),sense:t('sense'),social:t('social'),explore:t('explore'),lr:t('lr'),budget:t('budget')},
    brain:{layers:layers/n,neurons:neurons/n,inputs:inputs/n},sensUse:Object.entries(sensUse).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k,v/n]),
    actMix:Array.from(act,v=>v/n),events,eliteTop:elite.slice(0,5).map(e=>({id:e.id,gen:e.gen,score:e.score|0,hue:e.traits.hue})),history:withHistory?history:null,settings});
}
function postInspect(){
  const a=agents.find(x=>x.id===selected);
  if (!a){ self.postMessage({type:'inspect',none:true,id:selected}); return; }
  const alive=new Set(agents.map(x=>x.id)), b=a.brain;
  const ws=b.w.map((f,l)=>{ const d=a.learned[l], o=new Float32Array(f.length); for (let i=0;i<f.length;i++) o[i]=f[i]+d[i]; return o; });
  const kids=agents.filter(x=>x.parent===a.id).map(x=>({id:x.id,hue:x.traits.hue,age:x.age}));
  self.postMessage({type:'inspect',id:a.id,gen:a.gen,age:a.age,lifespan:a.lifespan,energy:a.energy,health:a.health,x:a.x,y:a.y,traits:a.traits,inv:a.inv,load:load(a),cap:capacity(a),
    builds:a.builds,success:a.success,kids:a.kids,livingKids:kids,sheltered:a.sheltered,temp:a._t,lastChoice:a.lastChoice,probs:Array.from(a.probs),inputs:b.inputs,sizes:b.sizes,ws,
    acts:a.acts.map(x=>Array.from(x)),trust:[...a.trust].sort((x,y)=>Math.abs(y[1])-Math.abs(x[1])).slice(0,10).map(([id,v])=>({id,v,alive:alive.has(id)})),
    lineage:a.lineage.map(l=>({...l,alive:alive.has(l.id)})),parent:a.parent,parentAlive:alive.has(a.parent),cost:traitCost(a.traits),metab:traitMetab(a.traits),
    actionCounts:Array.from(a.actionCounts),memory:a.memory,signal:a.signal});
}
function work(){
  const now=performance.now(), dt=Math.min(150,now-last); last=now;
  if (running){ acc=Math.min(400,acc+dt*speed/42); const st=performance.now(); while (acc>=1&&performance.now()-st<22){ tick(); acc--; stepsWin++; } }
  if (now-lastMetrics>=1000){ tps=Math.round(stepsWin*1000/(now-lastMetrics)); stepsWin=0; lastMetrics=now; }
  if (now-lastFrame>=30){ postFrame(); lastFrame=now; }
  if (inspecting&&selected&&now-lastInspect>=140){ postInspect(); lastInspect=now; }
  if (now-lastStats>=600){ postStats(true); lastStats=now; }
  setTimeout(work, running&&acc>=1?0:4);
}
function pickAgent(how){
  if (!agents.length) return;
  const cur=agents.find(a=>a.id===selected);
  let a=null;
  if (how==='random') a=pick(agents);
  else if (how==='oldest') a=agents.reduce((x,y)=>x.age>y.age?x:y);
  else if (how==='fittest') a=agents.reduce((x,y)=>(x.kids*350+x.age)>(y.kids*350+y.age)?x:y);
  else if (how==='youngest') a=agents.reduce((x,y)=>x.gen>y.gen||(x.gen===y.gen&&x.age<y.age)?x:y);
  else if (how==='child'&&cur){ const k=agents.filter(x=>x.parent===cur.id); if (k.length) a=pick(k); else toast('No living children yet','info'); }
  else if (how==='parent'&&cur){ a=agents.find(x=>x.id===cur.parent)||null; if (!a) toast('Parent is no longer alive','info'); }
  if (a){ selected=a.id; self.postMessage({type:'selected',id:a.id}); postInspect(); }
}
self.onmessage=e=>{
  const m=e.data;
  switch(m.type){
    case 'play': running=m.running; break;
    case 'speed': speed=m.speed; break;
    case 'settings': Object.assign(settings,m.settings); break;
    case 'step': for (let i=0;i<(m.n||100);i++) tick(); postFrame(); postStats(true); break;
    case 'reset': reset(); postFrame(); postStats(true); self.postMessage({type:'selected',id:0}); break;
    case 'storm': sendStorm(); break;
    case 'cold': settings.temperature=clamp(settings.temperature-12,-20,50); log('Cold snap: average temperature down 12°C','cold'); postStats(false); break;
    case 'heat': settings.temperature=clamp(settings.temperature+12,-20,50); log('Heatwave: average temperature up 12°C','heat'); postStats(false); break;
    case 'bloom': for (let i=0;i<200;i++) addItem('food'); log('Food bloom: 200 food scattered','food'); break;
    case 'select': selected=m.id||0; if (selected) postInspect(); break;
    case 'inspect': inspecting=m.on; break;
    case 'pick': pickAgent(m.how); break;
    case 'paint': {
      const {x,y,k}=m;
      if (k==='erase'){ for (const it of items) if (Math.hypot(it.x-x,it.y-y)<=20) it.dead=true; }
      else if (k==='fire'){ if (!occupied(x,y,12)) placeBuilding('fire',x,y,null); }
      else for (let i=0;i<(k==='food'?15:5);i++) addItem(k,x+rnd(-17,17),y+rnd(-17,17));
      break;
    }
    case 'save': self.postMessage({type:'saved',state:JSON.stringify(serialize()),ticks,purpose:m.purpose}); break;
    case 'load': try { deserialize(typeof m.state==='string'?JSON.parse(m.state):m.state); postFrame(); postStats(true); self.postMessage({type:'loaded',ok:true,settings}); } catch(err){ self.postMessage({type:'loaded',ok:false,error:err.message}); } break;
  }
};
self.postMessage({type:'meta',senses:SENSES,actions:ACTIONS,W,H,settings});
reset(); postFrame(); postStats(true); work();
