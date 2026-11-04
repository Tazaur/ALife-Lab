'use strict';
// ALife Lab simulation core. Runs inside a Web Worker (or a main-thread shim).
// Hot paths: flat Float32Array weights, per-type spatial grids, compiled sensor codes,
// lazy environment queries (an agent only pays for the senses its brain is wired to).
// world size is chosen per world (wide, tall or square) so phones in portrait get a portrait map
const CELL = 32, FC = 16;
const SHAPES = {wide:[960,600], tall:[600,960], square:[780,780]};
let W = 960, H = 600, GC, GR, FW, FH, shape='wide';

const rnd = (a,b) => a + Math.random()*(b-a);
const clamp = (x,a,b) => x < a ? a : x > b ? b : x;
const pick = a => a[Math.floor(Math.random()*a.length)];

// ---------- actions ----------
const ACTIONS = ['Move north','Move east','Move south','Move west','Harvest','Eat','Deposit in store','Withdraw from store','Build house','Build storehouse','Build wall','Build fire','Repair','Share food','Attack agent','Fight beast','Craft tool','Rest'];
const SHORT   = ['N','E','S','W','Harvest','Eat','Deposit','Withdraw','House','Store','Wall','Fire','Repair','Share','Attack','Hunt','Craft','Rest'];
const O = ACTIONS.length;            // discrete, softmax-sampled
const CONT = ['Voice','Memory A','Memory B'];   // continuous tanh outputs
const NOUT = O + CONT.length;
const A_ = Object.fromEntries(['N','E','S','W','HARVEST','EAT','DEPOSIT','WITHDRAW','HOUSE','STORE','WALL','FIRE','REPAIR','SHARE','ATTACK','HUNT','CRAFT','REST'].map((k,i)=>[k,i]));
const ITYPES = ['food','tree','stone'];
const BTYPES = ['house','store','wall','fire'];
const SPECS = {house:{wood:3,stone:1,hp:450,r:16},store:{wood:5,stone:4,hp:720,r:23},wall:{wood:1,stone:1,hp:420,r:15},fire:{wood:2,stone:0,hp:180,r:12}};
const LIMITS = {layers:6, neurons:24, inputs:32};
const DX = [0,1,0,-1], DY = [-1,0,1,0];
const settings = {food:3,trees:.12,stone:.08,drain:1,decay:1,storm:1,temperature:19,day:500,season:2600,beasts:3,beastPower:1,popCap:260,mutation:1,learning:true,autoReseed:true};

// ---------- query masks ----------
const Q = {FOOD:1,TREE:2,STONE:4,SHELTER:8,FIRE:16,STORM:32,OTHER:64,PRED:128,CROWD:256,WALL:512};

let agents=[], items=[], buildings=[], storms=[], beasts=[], events=[], history=[], elite=[];
let ticks=0, nextId=1, nextBid=1, births=0, deaths=0, maxGen=0, peakPop=0, selected=0, lastMilestone=0, seed=1;
let deathsBy = {age:0,hunger:0,storm:0,fire:0,beast:0,attack:0};
let tally = {shares:0,thefts:0,attacks:0,hunts:0,beastKills:0,crafts:0,deposits:0,withdraws:0,builds:0};
let baseTemp = 19, dayS = 0, seasonS = 0;
let fires=[], shelters=[], walls=[];
let fert = new Float32Array(FW*FH), forest = new Float32Array(FW*FH), rock = new Float32Array(FW*FH);

// ---------- biome fields (seeded value noise) ----------
function mulberry(s){ return () => { s|=0; s=s+0x6D2B79F5|0; let t=Math.imul(s^s>>>15,1|s); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function noiseField(r, scale){
  const gw=Math.ceil(FW/scale)+2, gh=Math.ceil(FH/scale)+2, g=new Float32Array(gw*gh); for (let i=0;i<g.length;i++) g[i]=r();
  const f=new Float32Array(FW*FH);
  for (let y=0;y<FH;y++) for (let x=0;x<FW;x++){
    const gx=x/scale, gy=y/scale, x0=gx|0, y0=gy|0, tx=gx-x0, ty=gy-y0, sx=tx*tx*(3-2*tx), sy=ty*ty*(3-2*ty);
    const a=g[x0+y0*gw], b=g[x0+1+y0*gw], c=g[x0+(y0+1)*gw], d=g[x0+1+(y0+1)*gw];
    f[x+y*FW]=a+(b-a)*sx+(c-a)*sy+(a-b-c+d)*sx*sy;
  }
  return f;
}
function makeFields(s){
  const r=mulberry(s), mix=(a,b,w)=>{ const o=new Float32Array(a.length); let lo=1e9, hi=-1e9; for (let i=0;i<a.length;i++){ o[i]=a[i]*w+b[i]*(1-w); if (o[i]<lo) lo=o[i]; if (o[i]>hi) hi=o[i]; } for (let i=0;i<o.length;i++) o[i]=(o[i]-lo)/(hi-lo); return o; };
  fert=mix(noiseField(r,9),noiseField(r,3.5),.72);
  forest=mix(noiseField(r,8),noiseField(r,3),.7);
  rock=mix(noiseField(r,10),noiseField(r,2.5),.65);
  // rock pushes out fertility; forest prefers mid fertility
  for (let i=0;i<fert.length;i++){ fert[i]=clamp(fert[i]*(1-.55*rock[i]),0,1); forest[i]=clamp(forest[i]*(1-.6*rock[i]),0,1); }
}
const fieldAt = (f,x,y) => f[clamp(x/FC|0,0,FW-1)+clamp(y/FC|0,0,FH-1)*FW];
function spawnPoint(f, power){
  for (let i=0;i<8;i++){ const x=rnd(5,W-5), y=rnd(5,H-5); if (Math.random()<.04+.96*Math.pow(fieldAt(f,x,y),power)) return [x,y]; }
  return [rnd(5,W-5),rnd(5,H-5)];
}

// ---------- spatial grids ----------
const mkGrid = () => Array.from({length: GC*GR}, () => []);
let gFood, gTree, gStone, gAgent, GRIDS;
function setSize(name){
  shape=SHAPES[name]?name:'wide'; [W,H]=SHAPES[shape];
  GC=Math.ceil(W/CELL)+1; GR=Math.ceil(H/CELL)+1; FW=Math.ceil(W/FC); FH=Math.ceil(H/FC);
  gFood=mkGrid(); gTree=mkGrid(); gStone=mkGrid(); gAgent=mkGrid(); GRIDS=[gFood,gTree,gStone];
}
setSize('wide');
function clearGrid(g){ for (let i=0;i<g.length;i++) g[i].length = 0; }
function cellOf(x,y){ return clamp(x/CELL|0,0,GC-1) + clamp(y/CELL|0,0,GR-1)*GC; }
function nearestIn(g, a, r, q, skip){
  // expanding-ring search: stops once no unvisited ring can hold anything closer
  let best=null, d2=r*r;
  const cx0=clamp(a.x/CELL|0,0,GC-1), cy0=clamp(a.y/CELL|0,0,GR-1), K=Math.ceil(r/CELL)+1;
  for (let k=0;k<=K;k++){
    const y0=cy0-k, y1=cy0+k, x0=cx0-k, x1=cx0+k;
    for (let cy=y0; cy<=y1; cy++){
      if (cy<0||cy>=GR) continue;
      const step=(cy===y0||cy===y1)?1:(x1-x0)||1;
      for (let cx=x0; cx<=x1; cx+=step){
        if (cx<0||cx>=GC) continue;
        const bin=g[cx+cy*GC];
        for (let n=0;n<bin.length;n++){ const o=bin[n]; if (o.dead||o===skip) continue; const dx=o.x-a.x, dy=o.y-a.y, dd=dx*dx+dy*dy; if (dd<d2){ d2=dd; best=o; } }
      }
    }
    const reach=k*CELL; if (reach*reach>=d2) break;
  }
  q.obj=best; q.dist=best?Math.sqrt(d2):r; return q;
}
function crowdAt(a, r, out){
  let n=0, sig=0; const r2=r*r, x0=Math.max(0,(a.x-r)/CELL|0), x1=Math.min(GC-1,(a.x+r)/CELL|0), y0=Math.max(0,(a.y-r)/CELL|0), y1=Math.min(GR-1,(a.y+r)/CELL|0);
  for (let cy=y0;cy<=y1;cy++) for (let cx=x0;cx<=x1;cx++){ const bin=gAgent[cx+cy*GC]; for (const o of bin){ if (o===a||o.dead) continue; const dx=o.x-a.x, dy=o.y-a.y; if (dx*dx+dy*dy<r2){ n++; sig+=o.signal; } } }
  out.n=n; out.sig=n?sig/n:0; return out;
}
function nearestList(list, a, r, q, pred){
  let best=null, d2=r*r;
  for (const b of list){ if (pred&&!pred(b)) continue; const dx=b.x-a.x, dy=b.y-a.y, dd=dx*dx+dy*dy; if (dd<d2){ d2=dd; best=b; } }
  q.obj=best; q.dist=best?Math.sqrt(d2):r; return q;
}
const isShelter = b => (b.type==='house'||b.type==='store')&&b.hp>0;
const isFire = b => b.type==='fire';
const isDamaged = b => b.hp<b.max*.85;

// walls are segments: centre (x,y), half-length r, angle ang
function segDist(px,py,b){ const c=b.c, s=b.s, dx=px-b.x, dy=py-b.y; const t=clamp(dx*c+dy*s,-b.r,b.r); const ex=dx-c*t, ey=dy-s*t; return Math.sqrt(ex*ex+ey*ey); }
function wallBlocks(nx,ny,pad){ for (const b of walls) if (b.hp>0&&Math.abs(b.x-nx)<b.r+pad+2&&Math.abs(b.y-ny)<b.r+pad+2&&segDist(nx,ny,b)<pad) return true; return false; }
function nearestWall(a,r){ let d=r; for (const b of walls) if (b.hp>0&&Math.abs(b.x-a.x)<b.r+r&&Math.abs(b.y-a.y)<b.r+r){ const s=segDist(a.x,a.y,b); if (s<d) d=s; } return d; }

// ---------- senses ----------
// [key, label, query mask, fn(a,e)]
const dir = (a,q,ax) => q.obj ? (q.obj[ax]-a[ax])/Math.max(1,q.dist) : 0;
const pro = (a,q) => q.obj ? 1-q.dist/a.traits.sense : 0;
function kinship(a,o){
  if (!o) return 0;
  if (o.parent===a.id||a.parent===o.id) return 1;
  if (a.parent&&a.parent===o.parent) return .8;
  const la=a.lineage, lo=o.lineage, n=Math.min(4,la.length), m=Math.min(4,lo.length);
  for (let i=0;i<n;i++){ if (la[i].id===o.id) return .6/(1+i); for (let j=0;j<m;j++) if (la[i].id===lo[j].id) return .5/(1+Math.max(i,j)); }
  for (let j=0;j<m;j++) if (lo[j].id===a.id) return .6/(1+j);
  return 0;
}
const SENSOR_DEFS = [
  ['bias','Constant',0,()=>1],
  ['energy','Energy reserve',0,a=>clamp(a.energy/90-1,-1,1)],
  ['health','Health',0,a=>a.health/100],
  ['age','Age',0,a=>clamp(a.age/a.lifespan,0,1)],
  ['pain','Recently hurt',0,a=>a.pain],
  ['temp','Local temperature',0,a=>clamp((a._t-20)/30,-1,1)],
  ['comfort','Thermal comfort',0,a=>clamp(1-Math.abs(a._t-20)/(12*a.traits.thermal),-1,1)],
  ['strength','Strength',0,a=>a.traits.strength/3],
  ['speed','Speed',0,a=>a.traits.speed/3],
  ['load','Carried weight',0,a=>load(a)/capacity(a)],
  ['hasTool','Holding a tool',0,a=>a.tool>0?1:0],
  ['fertility','Ground fertility',0,a=>fieldAt(fert,a.x,a.y)*2-1],
  ['foodX','Food direction X',Q.FOOD,(a,e)=>dir(a,e.food,'x')],
  ['foodY','Food direction Y',Q.FOOD,(a,e)=>dir(a,e.food,'y')],
  ['foodNear','Food proximity',Q.FOOD,(a,e)=>pro(a,e.food)],
  ['treeX','Tree direction X',Q.TREE,(a,e)=>dir(a,e.tree,'x')],
  ['treeY','Tree direction Y',Q.TREE,(a,e)=>dir(a,e.tree,'y')],
  ['treeNear','Tree proximity',Q.TREE,(a,e)=>pro(a,e.tree)],
  ['stoneX','Stone direction X',Q.STONE,(a,e)=>dir(a,e.stone,'x')],
  ['stoneY','Stone direction Y',Q.STONE,(a,e)=>dir(a,e.stone,'y')],
  ['stoneNear','Stone proximity',Q.STONE,(a,e)=>pro(a,e.stone)],
  ['shelterX','Shelter direction X',Q.SHELTER,(a,e)=>dir(a,e.shelter,'x')],
  ['shelterY','Shelter direction Y',Q.SHELTER,(a,e)=>dir(a,e.shelter,'y')],
  ['shelterNear','Shelter proximity',Q.SHELTER,(a,e)=>pro(a,e.shelter)],
  ['storeFood','Food stocked in nearest shelter',Q.SHELTER,(a,e)=>e.shelter.obj?Math.min(1,e.shelter.obj.stock.food/20):0],
  ['storeMine','Nearest shelter is mine or an ally\'s',Q.SHELTER,(a,e)=>{ const b=e.shelter.obj; if (!b) return 0; return b.owner===a.id?1:clamp(a.trust.get(b.owner)||0,-1,1); }],
  ['structureHP','Nearby structure condition',Q.SHELTER,(a,e)=>e.shelter.obj?e.shelter.obj.hp/e.shelter.obj.max:0],
  ['fireNear','Fire proximity',Q.FIRE,(a,e)=>pro(a,e.fire)],
  ['wallNear','Wall proximity',Q.WALL,(a,e)=>1-e.wall/30],
  ['stormNear','Storm proximity',Q.STORM,(a,e)=>stormAt(a)?1:pro(a,e.storm)],
  ['stormX','Storm direction X',Q.STORM,(a,e)=>dir(a,e.storm,'x')],
  ['stormY','Storm direction Y',Q.STORM,(a,e)=>dir(a,e.storm,'y')],
  ['predX','Beast direction X',Q.PRED,(a,e)=>dir(a,e.pred,'x')],
  ['predY','Beast direction Y',Q.PRED,(a,e)=>dir(a,e.pred,'y')],
  ['predNear','Beast proximity',Q.PRED,(a,e)=>pro(a,e.pred)],
  ['agentX','Nearest agent direction X',Q.OTHER,(a,e)=>dir(a,e.other,'x')],
  ['agentY','Nearest agent direction Y',Q.OTHER,(a,e)=>dir(a,e.other,'y')],
  ['agentNear','Nearest agent proximity',Q.OTHER,(a,e)=>pro(a,e.other)],
  ['kin','Kinship with nearest agent',Q.OTHER,(a,e)=>kinship(a,e.other.obj)],
  ['trust','Trust toward nearest agent',Q.OTHER,(a,e)=>e.other.obj?(a.trust.get(e.other.obj.id)||0):0],
  ['agentEnergy','Nearest agent energy',Q.OTHER,(a,e)=>e.other.obj?e.other.obj.energy/100-1:0],
  ['agentFood','Nearest agent carries food',Q.OTHER,(a,e)=>e.other.obj?Math.min(1,e.other.obj.inv.food/3):0],
  ['agentTool','Nearest agent holds a tool',Q.OTHER,(a,e)=>e.other.obj&&e.other.obj.tool>0?1:0],
  ['agentStrength','Nearest agent strength vs mine',Q.OTHER,(a,e)=>e.other.obj?clamp(e.other.obj.traits.strength-a.traits.strength,-1,1):0],
  ['agentHue','Nearest agent color',Q.OTHER,(a,e)=>e.other.obj?Math.cos(e.other.obj.traits.hue*Math.PI/180):0],
  ['signal','Nearest agent\'s voice',Q.OTHER,(a,e)=>e.other.obj?e.other.obj.signal:0],
  ['chorus','Average voice nearby',Q.CROWD,(a,e)=>e.crowd.sig],
  ['crowd','Crowding',Q.CROWD,(a,e)=>Math.min(1,e.crowd.n/8)],
  ['ownHue','Own color',0,a=>Math.cos(a.traits.hue*Math.PI/180)],
  ['memA','Memory A',0,a=>a.memA],
  ['memB','Memory B',0,a=>a.memB],
  ['trend','Energy trend',0,a=>a.memory],
  ['foodStock','Carried food',0,a=>a.inv.food/6],
  ['woodStock','Carried wood',0,a=>a.inv.wood/6],
  ['stoneStock','Carried stone',0,a=>a.inv.stone/6],
  ['time','Day phase',0,()=>dayS],
  ['season','Season phase',0,()=>seasonS],
  ['random','Noise',0,()=>rnd(-1,1)],
];
const SENSES = Object.fromEntries(SENSOR_DEFS.map(d=>[d[0],d[1]]));
const KEYS = SENSOR_DEFS.map(d=>d[0]);
const KEYIDX = Object.fromEntries(KEYS.map((k,i)=>[k,i]));
const SMASK = SENSOR_DEFS.map(d=>d[2]);
const SFN = SENSOR_DEFS.map(d=>d[3]);
KEYIDX.memory = KEYIDX.trend;   // pre-1.1 saves

// ---------- brains ----------
function randArr(n, s=.6){ const f=new Float32Array(n); for (let i=0;i<n;i++) f[i]=rnd(-s,s); return f; }
const DEFAULT_INPUTS = ['bias','energy','health','pain','foodX','foodY','foodNear','agentX','agentY','agentNear','kin','predX','predY','predNear','foodStock','memA','memB','signal'];
function freshBrain(){ const inputs=[...DEFAULT_INPUTS], sizes=[inputs.length,14,12,NOUT]; return {inputs, sizes, w:[randArr(14*inputs.length), randArr(12*14), randArr(NOUT*12)]}; }
function copyBrain(b){ return {inputs:[...b.inputs], sizes:[...b.sizes], w:b.w.map(f=>new Float32Array(f))}; }
function toNested(b){ return {inputs:[...b.inputs], sizes:[...b.sizes], weights:b.w.map((f,l)=>{ const rows=b.sizes[l+1], cols=b.sizes[l], m=[]; for (let j=0;j<rows;j++) m.push(Array.from(f.subarray(j*cols,(j+1)*cols))); return m; })}; }
function fromNested(n){ return {inputs:n.inputs, sizes:n.sizes, w:n.weights.map((m,l)=>{ const cols=n.sizes[l], f=new Float32Array(m.length*cols); m.forEach((r,j)=>f.set(r.slice(0,cols),j*cols)); return f; })}; }
const mat = (n,m,s=.6) => Array.from({length:n}, () => Array.from({length:m}, () => rnd(-s,s)));
function mutateBrain(src){
  const b = toNested(src), mu=settings.mutation;
  if (Math.random()<.2*mu){
    const mode=pick(['add','add','remove','replace']), avail=KEYS.filter(k=>!b.inputs.includes(k));
    if (mode==='add' && avail.length && b.inputs.length<LIMITS.inputs){ const i=Math.floor(rnd(0,b.inputs.length+1)); b.inputs.splice(i,0,pick(avail)); b.weights[0].forEach(r=>r.splice(i,0,rnd(-.5,.5))); b.sizes[0]++; }
    else if (mode==='remove' && b.inputs.length>4){ const i=Math.floor(rnd(0,b.inputs.length)); b.inputs.splice(i,1); b.weights[0].forEach(r=>r.splice(i,1)); b.sizes[0]--; }
    else if (mode==='replace' && avail.length) b.inputs[Math.floor(rnd(0,b.inputs.length))]=pick(avail);
  }
  if (Math.random()<.04*mu && b.sizes.length-2<LIMITS.layers){
    // insert a near-identity layer so the new depth does not wreck what was learned
    const at=Math.floor(rnd(1,b.sizes.length)), prev=b.sizes[at-1], n=Math.min(LIMITS.neurons,Math.max(4,prev));
    const id=mat(n,prev,.1); for (let j=0;j<Math.min(n,prev);j++) id[j][j]+=1;
    const next=b.weights[at-1]; // rows = sizes[at], cols = prev
    const proj=next.map(r=>{ const o=Array(n).fill(0); for (let j=0;j<Math.min(n,prev);j++) o[j]=r[j]; for (let j=prev;j<n;j++) o[j]=rnd(-.1,.1); return o; });
    b.sizes.splice(at,0,n); b.weights.splice(at-1,1,id,proj);
  } else if (Math.random()<.02*mu && b.sizes.length>3){
    const at=Math.floor(rnd(1,b.sizes.length-1)); b.sizes.splice(at,1); b.weights.splice(at-1,2,mat(b.sizes[at],b.sizes[at-1]));
  }
  if (Math.random()<.2*mu && b.sizes.length>2){
    const l=Math.floor(rnd(1,b.sizes.length-1)), n=b.sizes[l];
    if (Math.random()<.6 && n<LIMITS.neurons){ b.weights[l-1].push(Array.from({length:b.sizes[l-1]},()=>rnd(-.5,.5))); b.weights[l].forEach(r=>r.push(rnd(-.3,.3))); b.sizes[l]++; }
    else if (n>3){ const i=Math.floor(rnd(0,n)); b.weights[l-1].splice(i,1); b.weights[l].forEach(r=>r.splice(i,1)); b.sizes[l]--; }
  }
  const pw=.12*mu, pz=.003*mu;
  for (const m of b.weights) for (const r of m) for (let i=0;i<r.length;i++){ if (Math.random()<pw) r[i]=clamp(r[i]+rnd(-.38,.38),-3,3); if (Math.random()<pz) r[i]=0; }
  return fromNested(b);
}
function compileBrain(a){
  const b=a.brain; a.learned=b.w.map(f=>new Float32Array(f.length)); a.eff=b.w.map(f=>new Float32Array(f)); a.acts=b.sizes.map(n=>new Float32Array(n));
  a.codes=Int16Array.from(b.inputs,k=>KEYIDX[k]??0); let m=Q.OTHER; for (const c of a.codes) m|=SMASK[c]; a.qmask=m;
  let nn=0; for (let l=1;l<b.sizes.length-1;l++) nn+=b.sizes[l]; a.brainCost=.0025*nn+.001*b.sizes[0];
}

// rational tanh approximation (max error ~2%), several times cheaper than Math.tanh
const ftanh = x => x<-3?-1:x>3?1:x*(27+x*x)/(27+9*x*x);
const ex = new Float64Array(O), gradA = new Float64Array(64), gradB = new Float64Array(64);
function forward(a){
  const b=a.brain, acts=a.acts, L=b.w.length;
  for (let l=0;l<L;l++){
    const p=acts[l], out=acts[l+1], w=a.eff[l], cols=b.sizes[l], rows=b.sizes[l+1];
    for (let j=0;j<rows;j++){ let s=0, base=j*cols; for (let i=0;i<cols;i++) s+=w[base+i]*p[i]; out[j]=ftanh(s); }
  }
  const z=acts[L], temp=.22+a.traits.explore; let m=-1e9;
  for (let i=0;i<O;i++) if (z[i]>m) m=z[i];
  let sum=0; for (let i=0;i<O;i++){ ex[i]=Math.exp((z[i]-m)/temp); sum+=ex[i]; }
  let r=Math.random(), choice=O-1;
  for (let i=0;i<O;i++) a.probs[i]=ex[i]/sum;
  for (let i=0;i<O;i++){ if ((r-=a.probs[i])<=0){ choice=i; break; } }
  a.signal=z[O]; a.memA=.7*a.memA+.3*z[O+1]; a.memB=.7*a.memB+.3*z[O+2];
  a.lastChoice=choice; return temp;
}
function learn(a, reward, temp){
  const adv=clamp(reward-a.baseline,-4,4); a.baseline=.98*a.baseline+.02*reward;
  // learn on a random half of ticks with doubled step: same expected update, half the cost
  if (adv===0||Math.random()<.5) return;
  const b=a.brain, acts=a.acts, lr=a.traits.lr*2; let grad=gradA, back=gradB;
  for (let i=0;i<O;i++) grad[i]=lr*adv*((i===a.lastChoice?1:0)-a.probs[i])/temp;
  for (let i=O;i<NOUT;i++) grad[i]=0;
  for (let l=b.w.length-1;l>=0;l--){
    const w=b.w[l], e=a.eff[l], d=a.learned[l], prev=acts[l], next=acts[l+1], cols=b.sizes[l], rows=b.sizes[l+1], deep=l>0;
    if (deep) for (let i=0;i<cols;i++) back[i]=0;
    for (let j=0;j<rows;j++){
      const g=grad[j]*(1-next[j]*next[j]); if (g>-1e-7&&g<1e-7) continue; const base=j*cols;
      for (let i=0;i<cols;i++){ const k=base+i; if (deep) back[i]+=g*e[k]; let v=d[k]+g*prev[i]; v=v>1.2?1.2:v<-1.2?-1.2:v; d[k]=v; e[k]=w[k]+v; }
    }
    const t=grad; grad=back; back=t;
  }
}

// ---------- agents ----------
function freshTraits(){ return {budget:rnd(5,8),strength:rnd(.8,1.5),speed:rnd(.8,1.6),thermal:rnd(.6,1.4),sense:rnd(60,130),social:rnd(.3,1.4),lr:rnd(.001,.03),explore:rnd(.12,1.2),aggression:rnd(.2,1),hue:rnd(0,360)}; }
const traitCost = t => t.strength*1.7+t.speed*1.5+t.thermal*.8+t.sense/95+t.social*.35;
const traitMetab = t => .7+.12*t.budget+.13*Math.max(0,traitCost(t)-t.budget)+.025*traitCost(t);
const TB = {lr:[.0001,.15],explore:[.02,2.8],sense:[30,210],budget:[2,15],speed:[.2,3],strength:[.2,3],aggression:[.05,3]};
function mutateTraits(src){ const t={}, s=.18*Math.sqrt(settings.mutation); for (const k in src){ const v=src[k]; if (k==='hue') t[k]=(v+rnd(-20,20)+360)%360; else { const [lo,hi]=TB[k]||[.2,2.5]; t[k]=clamp(v*Math.exp(rnd(-s,s)),lo,hi); } } if (t.aggression==null) t.aggression=rnd(.2,1); return t; }
function makeAgent(x,y,brain=freshBrain(),gen=0,parent=null,traits=freshTraits(),energy=90,lineage=[]){
  const a={id:nextId++,x,y,vx:0,vy:0,hd:rnd(0,6.283),brain,gen,parent,lineage,traits,energy,health:100,prevHealth:100,age:0,lifespan:rnd(3600,5100),
    inv:{food:0,wood:0,stone:0},tool:0,memory:0,memA:0,memB:0,signal:0,pain:0,trust:new Map(),lastChoice:O-1,probs:new Float32Array(O),
    builds:0,success:0,kids:0,shared:0,stolen:0,attacks:0,kills:0,hunts:0,beastKills:0,crafts:0,deposits:0,
    actionCounts:new Uint32Array(O),baseline:0,sheltered:false,harm:'hunger',fx:0,_t:20};
  if (a.traits.aggression==null) a.traits.aggression=rnd(.2,1);
  compileBrain(a); if (gen>maxGen) maxGen=gen; return a;
}
function child(a){
  const lineage=[{id:a.id,gen:a.gen,hue:a.traits.hue},...a.lineage].slice(0,12);
  const c=makeAgent(clamp(a.x+rnd(-13,13),8,W-8),clamp(a.y+rnd(-13,13),8,H-8),mutateBrain(a.brain),a.gen+1,a.id,mutateTraits(a.traits),60,lineage);
  c.trust.set(a.id,.5); a.trust.set(c.id,.5);
  a.kids++; return c;
}
const load = a => a.inv.food+a.inv.wood*1.4+a.inv.stone*2;
const capacity = a => 2+a.traits.strength*4;
function setTrust(a,id,v){ a.trust.set(id,clamp(v,-1,1)); if (a.trust.size>48){ const keep=[...a.trust].sort((x,y)=>Math.abs(y[1])-Math.abs(x[1])).slice(0,32); a.trust=new Map(keep); } }

function addItem(type,x,y){
  if (items.length>1600) return;
  const t=ITYPES.indexOf(type);
  if (x===undefined){ [x,y]=spawnPoint(t===0?fert:t===1?forest:rock,t===0?1.6:2.2); }
  const life=t===0?rnd(400,1100):t===1?rnd(1600,3600):rnd(2500,6000);
  items.push({t,type,x:clamp(x,4,W-4),y:clamp(y,4,H-4),life,max:life,dead:false});
}
function occupied(x,y,r,type){
  for (const b of buildings){
    if (type==='wall'&&b.type==='wall'){ if (Math.hypot(b.x-x,b.y-y)<10) return true; continue; }
    const br=b.type==='wall'?4:b.r, d=b.type==='wall'?segDist(x,y,b):Math.hypot(b.x-x,b.y-y);
    if (d<br+(type==='wall'?3:r)+2) return true;
  }
  return false;
}
function placeBuilding(type,x,y,owner,ang=0){
  const s=SPECS[type];
  const b={id:nextBid++,type,x,y,r:s.r,hp:s.hp,max:s.hp,owner,stock:{food:0,wood:0,stone:0},life:type==='fire'?600:10000,max_life:type==='fire'?600:10000,ang,c:Math.cos(ang),s:Math.sin(ang)};
  buildings.push(b); return b;
}
function build(type,a){
  const s=SPECS[type], r=s.r;
  if (buildings.length>=160||a.inv.wood<s.wood||a.inv.stone<s.stone) return false;
  let x=a.x, y=a.y, ang=0;
  if (type==='fire'){ x+=Math.cos(a.hd)*(r+7); y+=Math.sin(a.hd)*(r+7); }
  else if (type==='wall'){ ang=a.hd; x+=Math.cos(a.hd+Math.PI/2)*5; y+=Math.sin(a.hd+Math.PI/2)*5; }   // laid along the direction of travel, offset to the side
  if (x<r||y<r||x>W-r||y>H-r||occupied(x,y,r,type)) return false;
  a.inv.wood-=s.wood; a.inv.stone-=s.stone; placeBuilding(type,x,y,a.id,ang); a.builds++; tally.builds++;
  if (buildings.length%20===0) log(`${buildings.length} structures standing`,'build');
  return true;
}
function log(s,kind='info'){ events.unshift({t:ticks,s,kind}); if (events.length>80) events.length=80; }
function toast(s,kind){ self.postMessage({type:'toast',s,kind}); }
function dropInventory(a){
  for (const k of ['food','wood','stone']) for (let i=0;i<a.inv[k];i++) addItem(k==='wood'?'tree':k,a.x+rnd(-6,6),a.y+rnd(-6,6));
  a.inv.food=a.inv.wood=a.inv.stone=0;
}

// ---------- beasts ----------
let nextBeast=1;
function spawnBeast(x,y){
  if (x===undefined){ const side=Math.floor(rnd(0,4)); x=side===0?4:side===1?W-4:rnd(0,W); y=side<2?rnd(0,H):side===2?4:H-4; }
  beasts.push({id:nextBeast++,x,y,vx:0,vy:0,hd:0,hp:80,max:80,cd:0,energy:100,age:0,target:null,wander:rnd(0,6.28)});
}
const _bq={}, _bf={};
function tickBeasts(){
  if (beasts.length<settings.beasts&&Math.random()<1/300) spawnBeast();
  while (beasts.length>settings.beasts+3) beasts.shift();
  const pw=settings.beastPower;
  for (const z of beasts){
    z.age++; z.cd--; z.energy-=.03;
    let tgt=z.target&&!z.target.dead&&!z.target.sheltered&&Math.hypot(z.target.x-z.x,z.target.y-z.y)<160?z.target:null;
    if (!tgt){ const q=nearestIn(gAgent,z,110,_bq); tgt=q.obj&&!q.obj.sheltered?q.obj:null; }
    z.target=tgt;
    let ax, ay, sp;
    const f=nearestList(fires,z,48,_bf);
    if (f.obj){ ax=z.x-f.obj.x; ay=z.y-f.obj.y; sp=1.9; }
    else if (tgt){ ax=tgt.x-z.x; ay=tgt.y-z.y; sp=1.55*(.8+.2*pw); }
    else { z.wander+=rnd(-.3,.3); ax=Math.cos(z.wander); ay=Math.sin(z.wander); sp=.6; }
    const n=Math.hypot(ax,ay)||1; z.vx=z.vx*.7+ax/n*sp*.3; z.vy=z.vy*.7+ay/n*sp*.3;
    const nx=clamp(z.x+z.vx,3,W-3), ny=clamp(z.y+z.vy,3,H-3);
    if (wallBlocks(nx,ny,4.5)){ z.vx*=-.5; z.vy*=-.5; z.wander+=Math.PI/2; } else { z.x=nx; z.y=ny; }
    if (nx<=3||nx>=W-3||ny<=3||ny>=H-3) z.wander+=Math.PI;
    if (z.vx*z.vx+z.vy*z.vy>.01) z.hd=Math.atan2(z.vy,z.vx);
    if (tgt&&z.cd<=0&&Math.hypot(tgt.x-z.x,tgt.y-z.y)<7){ const dmg=10*pw*(.6+.4*Math.random()); tgt.health-=dmg; tgt.pain=1; tgt.harm='beast'; tgt.fx|=32; z.cd=18; z.energy=Math.min(140,z.energy+8); }
  }
  for (let i=beasts.length-1;i>=0;i--){ const z=beasts[i]; if (z.hp<=0||z.energy<=0||z.age>12000){ if (z.hp<=0) for (let k=0;k<4;k++) addItem('food',z.x+rnd(-8,8),z.y+rnd(-8,8)); beasts.splice(i,1); } }
}

// ---------- environment ----------
function temperature(){ return settings.temperature+dayS*6+seasonS*10; }
function stormAt(a){ for (const s of storms) if (Math.abs(a.x-s.x)<s.w/2&&Math.abs(a.y-s.y)<s.h/2) return s; return null; }
function inside(a){
  for (const b of shelters){ if (b.hp<=0) continue; const dx=a.x-b.x, dy=a.y-b.y; if (dx*dx+dy*dy<(b.r-1)*(b.r-1) && (!b.owner||b.owner===a.id||(a.trust.get(b.owner)||0)>-.25)) return b; }
  return null;
}
function tempAt(a){ let t=baseTemp; for (const b of fires) if (b.hp>0){ const dx=a.x-b.x, dy=a.y-b.y; if (dx*dx+dy*dy<4225) t+=22*(1-Math.sqrt(dx*dx+dy*dy)/65); } return t; }
const env = {food:{},tree:{},stone:{},shelter:{},fire:{},storm:{},other:{},pred:{},crowd:{n:0,sig:0},wall:30};
function sense(a){
  const r=a.traits.sense, m=a.qmask;
  if (m&Q.FOOD) nearestIn(gFood,a,r,env.food);
  if (m&Q.TREE) nearestIn(gTree,a,r,env.tree);
  if (m&Q.STONE) nearestIn(gStone,a,r,env.stone);
  if (m&Q.SHELTER) nearestList(shelters,a,r,env.shelter,isShelter);
  if (m&Q.FIRE) nearestList(fires,a,r,env.fire);
  if (m&Q.STORM) nearestList(storms,a,r,env.storm);
  if (m&Q.PRED) nearestList(beasts,a,r,env.pred);
  if (m&Q.CROWD) crowdAt(a,40,env.crowd);
  if (m&Q.WALL) env.wall=nearestWall(a,30);
  nearestIn(gAgent,a,r,env.other,a);
  const inp=a.acts[0], codes=a.codes;
  for (let i=0;i<codes.length;i++) inp[i]=SFN[codes[i]](a,env);
}
const _h={}, _r={}, _z={}, _f2={};
function act(a,choice,e){
  let reward=-.012, moved=false; const insideNow=inside(a); a.actionCounts[choice]++;
  const o=e.other.obj, od=e.other.dist;
  switch (choice){
    case 0: case 1: case 2: case 3: {
      const sp=(.7+a.traits.speed*1.7)/(1+load(a)/(capacity(a)*1.2));
      a.vx=a.vx*.35+DX[choice]*sp*.65; a.vy=a.vy*.35+DY[choice]*sp*.65; a.energy-=.008*sp; reward+=.008; moved=true; break;
    }
    case A_.HARVEST: {
      let best=null, bd=11;
      for (let t=0;t<3;t++){ const q=nearestIn(GRIDS[t],a,11,_h); if (q.obj&&q.dist<bd){ bd=q.dist; best=q.obj; } }
      if (best && load(a)+1<=capacity(a)){
        const k=best.t===1?'wood':best.type; a.inv[k]++; if (best.t>0&&a.tool>0&&load(a)+1.5<=capacity(a)){ a.inv[k]++; a.tool--; }
        best.dead=true; reward+=best.t===0?.65:.3; a.success++;
      }
      break;
    }
    case A_.EAT:
      if (a.inv.food>0&&a.energy<170){ a.inv.food--; a.energy+=30; reward+=1.2; }
      else if (insideNow&&insideNow.stock.food>0&&a.energy<170){ insideNow.stock.food--; a.energy+=30; reward+=1.1; }
      break;
    case A_.DEPOSIT:
      if (insideNow){ let n=0; for (const k of ['food','wood','stone']) if (a.inv[k]>0){ insideNow.stock[k]+=a.inv[k]; n+=a.inv[k]; a.inv[k]=0; } if (n){ reward+=Math.min(.4,n*.09); a.deposits+=n; tally.deposits+=n; a.fx|=64; } }
      break;
    case A_.WITHDRAW:
      if (insideNow){ let n=0; for (const k of ['wood','stone','food']) while (insideNow.stock[k]>0&&load(a)+(k==='stone'?2:k==='wood'?1.4:1)<=capacity(a)&&n<4){ insideNow.stock[k]--; a.inv[k]++; n++; } if (n){ reward+=.08; tally.withdraws+=n; if (insideNow.owner&&insideNow.owner!==a.id){ const ow=agents.find(x=>x.id===insideNow.owner); if (ow) setTrust(ow,a.id,(ow.trust.get(a.id)||0)-.15); } } }
      break;
    case A_.HOUSE: case A_.STORE: case A_.WALL: case A_.FIRE:
      if (build(BTYPES[choice-A_.HOUSE],a)) reward+=.45; else reward-=.08; break;
    case A_.REPAIR: {
      const b=nearestList(buildings,a,17,_r,isDamaged).obj;
      if (b&&a.inv.wood>=1&&(b.type==='fire'||a.inv.stone>=1)){ a.inv.wood--; if (b.type!=='fire') a.inv.stone--; b.hp=Math.min(b.max,b.hp+110); reward+=.65; }
      break;
    }
    case A_.SHARE:
      if (o&&od<16&&a.inv.food>0&&load(o)+1<=capacity(o)){
        a.inv.food--; o.inv.food++; setTrust(o,a.id,(o.trust.get(a.id)||0)+.25); setTrust(a,o.id,(a.trust.get(o.id)||0)+.05);
        reward+=.1; a.shared++; tally.shares++; a.fx|=1;
      }
      break;
    case A_.ATTACK:
      if (o&&od<14){
        const dmg=5*a.traits.strength*(a.tool>0?2.2:1)*(o.sheltered?.3:1)*(.6+.4*a.traits.aggression);
        o.health-=dmg; o.pain=1; o.harm='attack'; a.energy-=1.2; a.attacks++; tally.attacks++; a.fx|=2; o.fx|=32;
        if (a.tool>0) a.tool--;
        setTrust(o,a.id,(o.trust.get(a.id)||0)-.6); setTrust(a,o.id,(a.trust.get(o.id)||0)-.2);
        if (o.inv.food>0&&a.traits.strength>o.traits.strength*.8&&load(a)+1<=capacity(a)){ o.inv.food--; a.inv.food++; a.stolen++; tally.thefts++; reward+=.35; }
        else reward+=.05;
        if (o.health<=0) a.kills++;
      }
      break;
    case A_.HUNT: {
      const z=nearestList(beasts,a,16,_z).obj;
      if (z){
        const dmg=5*a.traits.strength*(a.tool>0?2.2:1)*(.7+.3*a.traits.aggression);
        z.hp-=dmg; z.target=a; a.energy-=1; a.hunts++; tally.hunts++; a.fx|=4; if (a.tool>0) a.tool--;
        reward+=.3;
        if (z.hp<=0){ a.beastKills++; tally.beastKills++; reward+=1.5; log(`Agent #${a.id} slew a beast`,'beast'); }
      }
      break;
    }
    case A_.CRAFT:
      if (a.tool<=0&&a.inv.wood>=1&&a.inv.stone>=1){ a.inv.wood--; a.inv.stone--; a.tool=40; a.crafts++; tally.crafts++; reward+=.4; a.fx|=8; }
      break;
    default:
      if (insideNow){ a.energy+=.16; a.health=Math.min(100,a.health+.08); reward+=.08; }
      else if (nearestList(fires,a,18,_f2).obj) a.energy+=.04;
  }
  if (!moved){ a.vx*=.5; a.vy*=.5; }
  if (a.vx*a.vx+a.vy*a.vy>.0004){
    const nx=clamp(a.x+a.vx,4,W-4), ny=clamp(a.y+a.vy,4,H-4);
    if (wallBlocks(nx,ny,3.5)){ a.vx=a.vy=0; if (moved) reward-=.06; } else { a.x=nx; a.y=ny; }
    if (moved) a.hd=Math.atan2(a.vy,a.vx);
  }
  return reward;
}

function sendStorm(){ storms.push({x:-120,y:rnd(50,H-50),w:rnd(90,170),h:rnd(140,300),vx:rnd(1.1,2.5),vy:rnd(-.1,.1),life:750,max:750}); log('Storm front moving in from the west','storm'); toast('Storm front incoming','storm'); }
function archive(a){
  const score=a.age+a.kids*350+a.builds*60+a.success*2+a.beastKills*200+a.shared*20;
  if (elite.length<24||score>elite[elite.length-1].score){
    elite.push({score,gen:a.gen,id:a.id,traits:{...a.traits},brain:copyBrain(a.brain)});
    elite.sort((x,y)=>y.score-x.score); if (elite.length>24) elite.length=24;
  }
}
function reseed(){
  const n=40;
  for (let i=0;i<n;i++){
    const src=elite.length?pick(elite):null, [x,y]=spawnPoint(fert,1);
    agents.push(src?makeAgent(x,y,mutateBrain(src.brain),src.gen+1,null,mutateTraits(src.traits),90,[{id:src.id,gen:src.gen,hue:src.traits.hue}]):makeAgent(x,y));
  }
  log(`Extinction. ${n} colonists reseeded from ${elite.length?elite.length+' archived genomes':'scratch'}`,'death');
  toast('Extinction: colony reseeded from the archive','death');
}

function tick(){
  ticks++;
  dayS=Math.sin(2*Math.PI*ticks/settings.day); seasonS=settings.season?Math.sin(2*Math.PI*ticks/settings.season):0; baseTemp=temperature();
  const rate=settings.food*(1+.45*seasonS);
  for (let i=0;i<Math.floor(rate);i++) addItem('food');
  if (Math.random()<rate%1) addItem('food');
  if (Math.random()<settings.trees) addItem('tree');
  if (Math.random()<settings.stone) addItem('stone');
  let w=0; for (let i=0;i<items.length;i++){ const it=items[i]; if (it.dead) continue; it.life-=settings.decay; if (it.life<=0) continue; items[w++]=it; } items.length=w;
  for (let i=buildings.length-1;i>=0;i--){
    const b=buildings[i], prot=b.type==='store'?4:b.type==='house'?2:1;
    b.hp-=settings.decay*(b.type==='fire'?.6:.045); b.life-=settings.decay;
    if (b.stock.food&&Math.random()<.0004*b.stock.food*settings.decay/prot) b.stock.food--;
    if (b.hp<=0||b.life<=0){ buildings.splice(i,1); if (b.type==='store'&&b.stock.food+b.stock.wood+b.stock.stone>0) for (const k of ['food','wood','stone']) for (let n=0;n<Math.min(6,b.stock[k]);n++) addItem(k==='wood'?'tree':k,b.x+rnd(-10,10),b.y+rnd(-10,10)); }
  }
  for (let i=storms.length-1;i>=0;i--){ const s=storms[i]; s.x+=s.vx; s.y+=s.vy; s.life--; if (s.life<=0||s.x>W+s.w||s.x<-s.w*2) storms.splice(i,1); }
  if (ticks%1500===0&&Math.random()<.7) sendStorm();

  clearGrid(gFood); clearGrid(gTree); clearGrid(gStone); clearGrid(gAgent);
  for (const it of items) GRIDS[it.t][cellOf(it.x,it.y)].push(it);
  for (const a of agents) gAgent[cellOf(a.x,a.y)].push(a);
  fires=[]; shelters=[]; walls=[];
  for (const b of buildings){ if (b.type==='fire') fires.push(b); else if (b.type==='wall') walls.push(b); else shelters.push(b); }
  for (const a of agents) a.fx=0;
  tickBeasts();

  const newborn=[], cap=settings.popCap, drainK=.11*settings.drain; let dead=0;
  for (const a of agents){
    if (a.dead) continue;
    a.age++; a.pain*=.9;
    a._t=tempAt(a);
    sense(a);
    const temp=forward(a);
    let reward=act(a,a.lastChoice,env);
    const sheltered=inside(a), storm=stormAt(a), lt=a._t, cold=Math.max(0,15-lt), hot=Math.max(0,lt-31), thermal=(cold+hot)/(16*a.traits.thermal);
    a.sheltered=!!sheltered;
    a.energy-=drainK*traitMetab(a.traits)+a.brainCost+thermal*(sheltered?.009:.045);
    if (storm&&!sheltered){ const wb=nearestWall(a,12)<12?.4:1; a.health-=.15*settings.storm*wb; a.energy-=.12*settings.storm*wb; a.harm='storm'; }
    for (const b of fires){ const dx=a.x-b.x, dy=a.y-b.y; if (dx*dx+dy*dy<(b.r+2)*(b.r+2)){ a.health-=.9; a.energy-=.1; a.harm='fire'; } }
    if (a.energy<0){ a.health+=a.energy*.08; a.energy=0; a.harm='hunger'; }
    if (a.energy>200) a.energy=200;
    if (a.energy<45&&a.inv.food>0){ a.inv.food--; a.energy=Math.min(200,a.energy+28); reward+=.7; }
    if (a.inv.food&&Math.random()<.0012*a.inv.food) a.inv.food--;   // carried food spoils; stores keep it better
    a.memory=clamp(.96*a.memory+.04*(a.energy/100-1),-1,1);
    const hurt=Math.max(0,a.prevHealth-a.health); a.prevHealth=a.health;
    reward+=clamp((a.energy-80)/200,-.1,.1)-hurt*.04;
    if (settings.learning) learn(a,reward,temp);
    if (a.energy>135&&a.age>100&&Math.random()<.012&&agents.length+newborn.length<cap){
      a.energy-=60; const c=child(a); newborn.push(c); births++;
      if (c.gen>=lastMilestone+10){ lastMilestone=c.gen-c.gen%10; toast(`Generation ${lastMilestone} reached`,'birth'); log(`Generation ${lastMilestone} reached`,'birth'); }
    }
    if (a.health<=0||a.age>a.lifespan){ a.dead=true; dead++; deaths++; deathsBy[a.age>a.lifespan?'age':a.harm]=(deathsBy[a.age>a.lifespan?'age':a.harm]||0)+1; dropInventory(a); archive(a); }
  }
  if (dead) agents=agents.filter(a=>!a.dead);
  for (const c of newborn) agents.push(c);
  if (agents.length>peakPop) peakPop=agents.length;
  if (!agents.length&&settings.autoReseed) reseed();
  if (ticks%25===0) pushHistory();
}
function avg(f){ if (!agents.length) return 0; let s=0; for (const a of agents) s+=f(a); return s/agents.length; }
let lastTally={...tally};
function pushHistory(){
  let food=0; for (const it of items) if (!it.dead&&it.t===0) food++;
  let stocked=0; for (const b of buildings) stocked+=b.stock.food;
  const d={}; for (const k in tally){ d[k]=tally[k]-(lastTally[k]||0); } lastTally={...tally};
  history.push({t:ticks,pop:agents.length,food,build:buildings.length,beasts:beasts.length,stocked,gen:avg(a=>a.gen),str:avg(a=>a.traits.strength),spd:avg(a=>a.traits.speed),sense:avg(a=>a.traits.sense),agg:avg(a=>a.traits.aggression),
    neurons:avg(a=>a.brain.sizes.reduce((s,n)=>s+n,0)),tools:avg(a=>a.tool>0?1:0),births,deaths,...d});
  if (history.length>600){ // keep long runs readable: thin the older half
    const half=history.length>>1, old=history.slice(0,half).filter((_,i)=>i%2===0); history=old.concat(history.slice(half));
  }
}

function reset(newShape){
  if (newShape) setSize(newShape);
  seed=(Math.random()*2**31)|0; makeFields(seed);
  agents=[]; items=[]; buildings=[]; storms=[]; beasts=[]; events=[]; history=[]; elite=[];
  ticks=0; nextId=1; nextBid=1; births=0; deaths=0; maxGen=0; peakPop=0; lastMilestone=0;
  deathsBy={age:0,hunger:0,storm:0,fire:0,beast:0,attack:0}; for (const k in tally) tally[k]=0; lastTally={...tally};
  for (let i=0;i<120;i++){ const [x,y]=spawnPoint(fert,1); agents.push(makeAgent(x,y)); }
  for (let i=0;i<420;i++) addItem('food'); for (let i=0;i<160;i++) addItem('tree'); for (let i=0;i<120;i++) addItem('stone');
  for (let i=0;i<settings.beasts;i++) spawnBeast();
  selected=0; log('120 founders released. Fertile valleys, forests and rocky ground are spread across the map.','birth');
  postMeta();
}

// ---------- serialization ----------
const r4 = v => Math.round(v*1e4)/1e4, r2 = v => Math.round(v*100)/100;
const serBrain = b => ({inputs:b.inputs,sizes:b.sizes,w:b.w.map(f=>Array.from(f,r4))});
const AGENT_KEYS=['gen','parent','lineage','traits','age','lifespan','inv','tool','builds','success','kids','shared','stolen','attacks','kills','hunts','beastKills','crafts','deposits'];
function serialize(){
  return {version:11,shape,seed,ticks,nextId,nextBid,births,deaths,deathsBy,tally,maxGen,peakPop,selected,settings:{...settings},
    agents:agents.map(a=>{ const o={id:a.id,x:r2(a.x),y:r2(a.y),hd:r2(a.hd),energy:r2(a.energy),health:r2(a.health),memory:r4(a.memory),memA:r4(a.memA),memB:r4(a.memB),baseline:r4(a.baseline),
      trust:[...a.trust].map(([k,v])=>[k,r4(v)]),actionCounts:Array.from(a.actionCounts),brain:serBrain(a.brain),learned:a.learned.map(f=>Array.from(f,r4))}; for (const k of AGENT_KEYS) o[k]=a[k]; return o; }),
    items:items.filter(i=>!i.dead).map(i=>[i.t,r2(i.x),r2(i.y),i.life|0,i.max|0]),
    buildings:buildings.map(b=>({...b,hp:r2(b.hp)})),storms,beasts:beasts.map(z=>({...z,target:null})),events,history,elite:elite.map(e=>({...e,brain:serBrain(e.brain)}))};
}
// pre-1.1 brains had 14 outputs: map them onto the new action set and add fresh rows for the rest
const OLD_MAP=[0,1,2,3,4,5,6,8,9,10,11,12,13,17];
function upgradeBrain(b){
  const L=b.sizes.length-1, cols=b.sizes[L-1], old=b.w[L-1], rowsOld=b.sizes[L];
  if (rowsOld===NOUT) return b;
  const f=randArr(NOUT*cols,.3);
  if (rowsOld===14) for (let j=0;j<14;j++) f.set(old.subarray(j*cols,(j+1)*cols),OLD_MAP[j]*cols);
  b.w[L-1]=f; b.sizes[L]=NOUT; b.inputs=b.inputs.map(k=>k==='memory'?'trend':k); return b;
}
const deBrain = b => upgradeBrain(b.weights ? fromNested(b) : {inputs:b.inputs,sizes:b.sizes,w:b.w.map(x=>Float32Array.from(x))});
function deserialize(s){
  if (!s||!Array.isArray(s.agents)||![6,10,11].includes(s.version)) throw Error('Not an ALife Lab save (expected version 0.6 to 1.1)');
  const legacy=s.version<11; setSize(legacy?'wide':(s.shape||'wide'));
  const sx=legacy?W/840:1, sy=legacy?H/520:1, reg=s.registry||{};
  seed=s.seed||12345; makeFields(seed);
  const A=s.agents.map(o=>{
    const brain=deBrain(o.brain);
    const a=makeAgent(o.x*sx,o.y*sy,brain,o.gen||0,o.parent??null,{...freshTraits(),...o.traits},o.energy);
    a.id=o.id;
    for (const k of AGENT_KEYS) if (o[k]!==undefined&&k!=='traits'&&k!=='gen'&&k!=='parent') a[k]=o[k];
    Object.assign(a,{health:o.health,prevHealth:o.health,memory:o.memory||0,memA:o.memA||0,memB:o.memB||0,baseline:o.baseline||0,hd:o.hd||0,lifespan:o.lifespan||rnd(3600,5100),inv:o.inv||{food:0,wood:0,stone:0}});
    a.trust=new Map(Array.isArray(o.trust)?o.trust:Object.entries(o.trust||{}).map(([k,v])=>[+k,v]));
    if (o.actionCounts&&o.actionCounts.length===O) a.actionCounts=Uint32Array.from(o.actionCounts);
    if (o.learned&&!legacy){ a.learned=o.learned.map(x=>Float32Array.from(x)); }
    if (!o.lineage){ const ch=[]; let id=o.parent; for (let i=0;i<12&&id&&reg[id];i++){ ch.push({id,gen:reg[id].gen,hue:0}); id=reg[id].parent; } a.lineage=ch; }
    return a;
  });
  agents=A; ticks=s.ticks||0; nextId=Math.max(s.nextId||1,...A.map(a=>a.id+1)); births=s.births||0; deaths=s.deaths||0;
  deathsBy={age:0,hunger:0,storm:0,fire:0,beast:0,attack:0,...(s.deathsBy||{})}; Object.assign(tally,s.tally||{}); lastTally={...tally};
  maxGen=s.maxGen||Math.max(0,...A.map(a=>a.gen)); peakPop=s.peakPop||A.length;
  items=(s.items||[]).map(i=>Array.isArray(i)?{t:i[0],type:ITYPES[i[0]],x:i[1]*sx,y:i[2]*sy,life:i[3],max:i[4]||i[3],dead:false}:{t:ITYPES.indexOf(i.type),type:i.type,x:i.x*sx,y:i.y*sy,life:i.life,max:i.life,dead:false});
  nextBid=1;
  buildings=(s.buildings||[]).map(b=>{ const ang=b.ang||0; return {...b,x:b.x*sx,y:b.y*sy,r:b.type==='wall'?SPECS.wall.r:b.r,id:b.id||nextBid++,ang,c:Math.cos(ang),s:Math.sin(ang),max_life:b.max_life||(b.type==='fire'?600:10000)}; });
  nextBid=Math.max(nextBid,...buildings.map(b=>b.id+1),1);
  storms=(s.storms||[]).map(x=>({max:650,...x})); beasts=(s.beasts||[]).map(z=>({...z,target:null}));
  events=(s.events||[]).map(e=>typeof e==='string'?{t:0,s:e,kind:'info'}:e); history=Array.isArray(s.history)&&!legacy?s.history:[];
  elite=(s.elite||[]).map(e=>({...e,brain:deBrain(e.brain)}));
  Object.assign(settings,s.settings||{}); selected=s.selected||0; lastMilestone=maxGen-maxGen%10;
  log(legacy?'Older snapshot loaded and upgraded to the 1.1 action set':'Snapshot loaded','info');
  postMeta();
}

// ---------- reporting ----------
let started=false, running=true, speed=3, maxMode=false, last=performance.now(), acc=0, stepsWin=0, tps=0, lastMetrics=last, lastFrame=0, lastStats=0, lastInspect=0, inspecting=false;
function postMeta(){ self.postMessage({type:'meta',senses:SENSES,actions:ACTIONS,short:SHORT,cont:CONT,W,H,FW,FH,FC,shape,settings,fert,forest,rock,seed}); }
function postFrame(){
  const na=agents.length, A=new Float32Array(na*10);
  for (let i=0,o=0;i<na;i++,o+=10){ const a=agents[i]; A[o]=a.id; A[o+1]=a.x; A[o+2]=a.y; A[o+3]=a.traits.hue; A[o+4]=a.hd; A[o+5]=a.energy/200; A[o+6]=a.health/100;
    A[o+7]=(a.sheltered?1:0)|(a.inv.food+a.inv.wood+a.inv.stone>0?2:0)|(a.tool>0?4:0); A[o+8]=a.traits.sense; A[o+9]=a.fx; }
  let ni=0; for (const it of items) if (!it.dead) ni++;
  const I=new Float32Array(ni*4); let o=0;
  for (const it of items){ if (it.dead) continue; I[o]=it.t; I[o+1]=it.x; I[o+2]=it.y; I[o+3]=it.life/it.max; o+=4; }
  const nb=buildings.length, B=new Float32Array(nb*9);
  for (let i=0,p=0;i<nb;i++,p+=9){ const b=buildings[i]; B[p]=BTYPES.indexOf(b.type); B[p+1]=b.x; B[p+2]=b.y; B[p+3]=b.r; B[p+4]=b.hp/b.max; B[p+5]=b.id; B[p+6]=b.stock.food+b.stock.wood+b.stock.stone; B[p+7]=b.life/(b.max_life||10000); B[p+8]=b.ang||0; }
  const S=new Float32Array(storms.length*5);
  storms.forEach((s,i)=>{ S[i*5]=s.x; S[i*5+1]=s.y; S[i*5+2]=s.w; S[i*5+3]=s.h; S[i*5+4]=s.life/(s.max||650); });
  const Z=new Float32Array(beasts.length*6);
  beasts.forEach((z,i)=>{ Z[i*6]=z.id; Z[i*6+1]=z.x; Z[i*6+2]=z.y; Z[i*6+3]=z.hd; Z[i*6+4]=z.hp/z.max; Z[i*6+5]=z.target?1:0; });
  self.postMessage({type:'frame',ticks,tps,running,maxMode,temp:baseTemp,day:settings.day,season:settings.season,A,I,B,S,Z},[A.buffer,I.buffer,B.buffer,S.buffer,Z.buffer]);
}
function postStats(withHistory){
  const n=agents.length||1, sensUse={}, act=new Float64Array(O), byType={house:0,store:0,wall:0,fire:0};
  let layers=0, neurons=0, inputs=0, tools=0, stocked=0;
  for (const a of agents){ for (const k of a.brain.inputs) sensUse[k]=(sensUse[k]||0)+1; let tot=0; for (let i=0;i<O;i++) tot+=a.actionCounts[i]; if (tot) for (let i=0;i<O;i++) act[i]+=a.actionCounts[i]/tot; layers+=a.brain.sizes.length-2; for (let l=1;l<a.brain.sizes.length-1;l++) neurons+=a.brain.sizes[l]; inputs+=a.brain.inputs.length; if (a.tool>0) tools++; }
  for (const b of buildings){ byType[b.type]++; stocked+=b.stock.food; }
  const counts=[0,0,0]; for (const it of items) if (!it.dead) counts[it.t]++;
  const t=k=>avg(a=>a.traits[k]);
  self.postMessage({type:'stats',ticks,pop:agents.length,peakPop,births,deaths,deathsBy,tally,maxGen,avgGen:avg(a=>a.gen),byType,counts,temp:baseTemp,beasts:beasts.length,tools,stocked,
    traits:{strength:t('strength'),speed:t('speed'),thermal:t('thermal'),sense:t('sense'),social:t('social'),explore:t('explore'),lr:t('lr'),budget:t('budget'),aggression:t('aggression')},
    brain:{layers:layers/n,neurons:neurons/n,inputs:inputs/n},sensUse:Object.entries(sensUse).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k,v/n]),
    actMix:Array.from(act,v=>v/n),events,eliteTop:elite.slice(0,6).map(e=>({id:e.id,gen:e.gen,score:e.score|0,hue:e.traits.hue})),history:withHistory?history:null,settings});
}
function postInspect(){
  const a=agents.find(x=>x.id===selected);
  if (!a){ self.postMessage({type:'inspect',none:true,id:selected}); return; }
  const alive=new Set(agents.map(x=>x.id)), b=a.brain;
  const ws=b.w.map((f,l)=>{ const d=a.learned[l], o=new Float32Array(f.length); for (let i=0;i<f.length;i++) o[i]=f[i]+d[i]; return o; });
  const kids=agents.filter(x=>x.parent===a.id).map(x=>({id:x.id,hue:x.traits.hue,age:x.age}));
  self.postMessage({type:'inspect',id:a.id,gen:a.gen,age:a.age,lifespan:a.lifespan,energy:a.energy,health:a.health,x:a.x,y:a.y,traits:a.traits,inv:a.inv,tool:a.tool,load:load(a),cap:capacity(a),
    builds:a.builds,success:a.success,kids:a.kids,livingKids:kids,sheltered:a.sheltered,temp:a._t,lastChoice:a.lastChoice,probs:Array.from(a.probs),inputs:b.inputs,sizes:b.sizes,ws,
    acts:a.acts.map(x=>Array.from(x)),trust:[...a.trust].sort((x,y)=>Math.abs(y[1])-Math.abs(x[1])).slice(0,10).map(([id,v])=>({id,v,alive:alive.has(id)})),
    lineage:a.lineage.map(l=>({...l,alive:alive.has(l.id)})),parent:a.parent,cost:traitCost(a.traits),metab:traitMetab(a.traits),brainCost:a.brainCost,
    deeds:{shared:a.shared,stolen:a.stolen,attacks:a.attacks,kills:a.kills,hunts:a.hunts,beastKills:a.beastKills,crafts:a.crafts,deposits:a.deposits,builds:a.builds},
    actionCounts:Array.from(a.actionCounts),memory:a.memory,memA:a.memA,memB:a.memB,signal:a.signal,pain:a.pain});
}
// yield through a MessageChannel: unlike setTimeout(0) it is not clamped to 4 ms, so hyperspeed keeps the CPU busy
const chan=new MessageChannel(); let pending=false;
chan.port1.onmessage=()=>{ pending=false; work(); };
function schedule(idle){ if (idle) setTimeout(work,8); else if (!pending){ pending=true; chan.port2.postMessage(0); } }
function work(){
  const now=performance.now(), dt=Math.min(150,now-last); last=now;
  let busy=false;
  if (!started){ schedule(true); return; }
  if (running){
    const st=performance.now();
    if (maxMode){ while (performance.now()-st<45){ tick(); stepsWin++; } busy=true; acc=0; }
    else { acc=Math.min(Math.max(40,speed*4),acc+dt*speed/42); while (acc>=1&&performance.now()-st<30){ tick(); acc--; stepsWin++; } busy=acc>=1; }
  }
  if (now-lastMetrics>=1000){ tps=Math.round(stepsWin*1000/(now-lastMetrics)); stepsWin=0; lastMetrics=now; }
  const frameGap=maxMode?60:30;
  if (now-lastFrame>=frameGap){ postFrame(); lastFrame=now; }
  if (inspecting&&selected&&now-lastInspect>=(maxMode?300:140)){ postInspect(); lastInspect=now; }
  if (now-lastStats>=700){ postStats(true); lastStats=now; }
  schedule(!busy);
}
function pickAgent(how){
  if (!agents.length) return;
  const cur=agents.find(a=>a.id===selected);
  let a=null;
  const best=f=>agents.reduce((x,y)=>f(y)>f(x)?y:x);
  if (how==='random') a=pick(agents);
  else if (how==='oldest') a=best(x=>x.age);
  else if (how==='fittest') a=best(x=>x.kids*350+x.age);
  else if (how==='youngest') a=best(x=>x.gen*1e5-x.age);
  else if (how==='generous') a=best(x=>x.shared);
  else if (how==='violent') a=best(x=>x.attacks+x.kills*20);
  else if (how==='hunter') a=best(x=>x.hunts+x.beastKills*20);
  else if (how==='builder') a=best(x=>x.builds*10+x.deposits);
  else if (how==='child'&&cur){ const k=agents.filter(x=>x.parent===cur.id); if (k.length) a=pick(k); else toast('No living children yet','info'); }
  else if (how==='parent'&&cur){ a=agents.find(x=>x.id===cur.parent)||null; if (!a) toast('Parent is no longer alive','info'); }
  if (a){ selected=a.id; self.postMessage({type:'selected',id:a.id,x:a.x,y:a.y}); postInspect(); }
}
self.onmessage=e=>{
  const m=e.data;
  switch(m.type){
    case 'play': running=m.running; break;
    case 'speed': speed=m.speed; maxMode=!!m.max; break;
    case 'settings': Object.assign(settings,m.settings); break;
    case 'step': for (let i=0;i<(m.n||100);i++) tick(); postFrame(); postStats(true); break;
    case 'init': if (!started){ started=true; reset(m.shape); postFrame(); postStats(true); } break;
    case 'reset': reset(m.shape||shape); started=true; postFrame(); postStats(true); self.postMessage({type:'selected',id:0}); break;
    case 'storm': sendStorm(); break;
    case 'cold': settings.temperature=clamp(settings.temperature-12,-20,50); log('Cold snap: average temperature down 12°C','cold'); postStats(false); break;
    case 'heat': settings.temperature=clamp(settings.temperature+12,-20,50); log('Heatwave: average temperature up 12°C','heat'); postStats(false); break;
    case 'bloom': for (let i=0;i<220;i++) addItem('food'); log('Food bloom: 220 food scattered over fertile ground','food'); break;
    case 'select': selected=m.id||0; if (selected) postInspect(); break;
    case 'inspect': inspecting=m.on; break;
    case 'pick': pickAgent(m.how); break;
    case 'paint': {
      const {x,y,k,r=20,n=1}=m;
      if (k==='erase'){ for (const it of items) if (Math.hypot(it.x-x,it.y-y)<=r) it.dead=true; buildings=buildings.filter(b=>Math.hypot(b.x-x,b.y-y)>r); beasts=beasts.filter(z=>Math.hypot(z.x-x,z.y-y)>r); }
      else if (k==='fire'){ if (!occupied(x,y,12,'fire')) placeBuilding('fire',x,y,null); }
      else if (k==='beast'){ if (beasts.length<40) spawnBeast(x,y); }
      else if (k==='wall'){ const ang=m.ang||0; if (!occupied(x,y,15,'wall')) placeBuilding('wall',x,y,null,ang); }
      else { const cnt=Math.round((k==='food'?12:4)*n*(r/20)); for (let i=0;i<cnt;i++){ const t=rnd(0,6.283), d=Math.sqrt(Math.random())*r; addItem(k,x+Math.cos(t)*d,y+Math.sin(t)*d); } }
      break;
    }
    case 'save': self.postMessage({type:'saved',state:JSON.stringify(serialize()),ticks,purpose:m.purpose}); break;
    case 'load': try { started=true; deserialize(typeof m.state==='string'?JSON.parse(m.state):m.state); postFrame(); postStats(true); self.postMessage({type:'loaded',ok:true,settings}); } catch(err){ self.postMessage({type:'loaded',ok:false,error:err.message}); } break;
  }
};
self.postMessage({type:'ready'}); work();
