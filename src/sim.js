'use strict';
// ALife Lab simulation core. Runs inside a Web Worker (or a main-thread shim).
// Hot paths: flat Float32Array weights, per-type spatial grids, compiled sensor codes,
// lazy environment queries (an agent only pays for the senses its brain is wired to).
// The world is a square torus about 3x the area of 1.1: walking off one edge brings you in at the opposite one,
// and every sense, grid query and distance uses the shortest way around.
const CELL = 32, FC = 16;
let W = 1344, H = 1344, GC, GR, FW, FH, shape='square';

const rnd = (a,b) => a + Math.random()*(b-a);
const clamp = (x,a,b) => x < a ? a : x > b ? b : x;
const pick = a => a[Math.floor(Math.random()*a.length)];
const wrapX = x => x<0?x+W:x>=W?x-W:x, wrapY = y => y<0?y+H:y>=H?y-H:y;
const wd = (d,L) => d>L/2?d-L:d<-L/2?d+L:d;            // shortest signed offset on a ring
const ddx = (a,b) => wd(b.x-a.x,W), ddy = (a,b) => wd(b.y-a.y,H);
const wdist = (a,b) => Math.hypot(ddx(a,b),ddy(a,b));
const wdistXY = (x1,y1,x2,y2) => Math.hypot(wd(x2-x1,W),wd(y2-y1,H));

// ---------- actions ----------
const ACTIONS = ['Move north','Move east','Move south','Move west','Harvest','Eat','Deposit in store','Withdraw from store','Build house','Build storehouse','Build wall','Build fire','Repair','Share food','Attack yip','Fight beast','Craft tool','Rest','Drink','Thank nearest yip','Befriend nearest yip'];
const SHORT   = ['N','E','S','W','Harvest','Eat','Deposit','Withdraw','House','Store','Wall','Fire','Repair','Share','Attack','Hunt','Craft','Rest','Drink','Thank','Befriend'];
const O = ACTIONS.length;            // discrete, softmax-sampled
const CONT = ['Voice','Memory A','Memory B','Scent'];   // continuous tanh outputs
const NOUT = O + CONT.length;
const A_ = Object.fromEntries(['N','E','S','W','HARVEST','EAT','DEPOSIT','WITHDRAW','HOUSE','STORE','WALL','FIRE','REPAIR','SHARE','ATTACK','HUNT','CRAFT','REST','DRINK','THANK','BEFRIEND'].map((k,i)=>[k,i]));
const ITYPES = ['food','tree','stone'];
const BTYPES = ['house','store','wall','fire'];
const SPECS = {house:{wood:3,stone:1,hp:450,r:16},store:{wood:5,stone:4,hp:720,r:23},wall:{wood:2,stone:1,hp:420,r:15},fire:{wood:2,stone:0,hp:180,r:12}};
const LIMITS = {layers:6, neurons:24, inputs:32};
const DX = [0,1,0,-1], DY = [-1,0,1,0];
const settings = {food:7.5,trees:.3,stone:.2,drain:1,decay:1,storm:1,temperature:19,day:500,season:2600,beasts:6,beastPower:1,popCap:450,mutation:1,learning:true,autoReseed:true};

// ---------- query masks ----------
const Q = {FRIEND:1024,FOOD:1,TREE:2,STONE:4,SHELTER:8,FIRE:16,STORM:32,OTHER:64,PRED:128,CROWD:256,WALL:512};

let agents=[], items=[], buildings=[], storms=[], beasts=[], events=[], history=[], elite=[];
let ticks=0, nextId=1, nextBid=1, births=0, deaths=0, maxGen=0, peakPop=0, selected=0, lastMilestone=0, seed=1;
let deathsBy = {age:0,hunger:0,thirst:0,drowning:0,storm:0,fire:0,beast:0,attack:0};
let tally = {loveBirths:0,befriends:0,gifts:0,thanks:0,loves:0,pairings:0,shares:0,thefts:0,attacks:0,hunts:0,beastKills:0,crafts:0,deposits:0,withdraws:0,builds:0};
let baseTemp = 19, dayS = 0, seasonS = 0;
let fires=[], shelters=[], walls=[];
let fert = new Float32Array(FW*FH), forest = new Float32Array(FW*FH), rock = new Float32Array(FW*FH);

// ---------- biome fields (seeded value noise) ----------
function mulberry(s){ return () => { s|=0; s=s+0x6D2B79F5|0; let t=Math.imul(s^s>>>15,1|s); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function noiseField(r, scale){
  // value noise on a periodic lattice, so the field wraps seamlessly at the world's edges
  const P=Math.max(2,Math.round(FW/scale)), g=new Float32Array(P*P); for (let i=0;i<g.length;i++) g[i]=r();
  const f=new Float32Array(FW*FH), k=P/FW;
  for (let y=0;y<FH;y++) for (let x=0;x<FW;x++){
    const gx=x*k, gy=y*k, x0=gx|0, y0=gy|0, tx=gx-x0, ty=gy-y0, sx=tx*tx*(3-2*tx), sy=ty*ty*(3-2*ty), x1=(x0+1)%P, y1=(y0+1)%P;
    const a=g[x0+y0*P], b=g[x1+y0*P], c=g[x0+y1*P], d=g[x1+y1*P];
    f[x+y*FW]=a+(b-a)*sx+(c-a)*sy+(a-b-c+d)*sx*sy;
  }
  return f;
}
function makeFields(s){
  const r=mulberry(s), mix=(a,b,w)=>{ const o=new Float32Array(a.length); let lo=1e9, hi=-1e9; for (let i=0;i<a.length;i++){ o[i]=a[i]*w+b[i]*(1-w); if (o[i]<lo) lo=o[i]; if (o[i]>hi) hi=o[i]; } for (let i=0;i<o.length;i++) o[i]=(o[i]-lo)/(hi-lo); return o; };
  fert=mix(noiseField(r,9),noiseField(r,3.5),.72);
  forest=mix(noiseField(r,8),noiseField(r,3),.7);
  rock=mix(noiseField(r,10),noiseField(r,2.5),.65);
  // lakes sit in the lowest ground; land near water is the most fertile
  const elev=mix(noiseField(r,7),noiseField(r,2.6),.7);
  water=new Uint8Array(FW*FH); for (let i=0;i<elev.length;i++) water[i]=elev[i]<.2?1:0;
  buildWaterDistance();
  for (let i=0;i<fert.length;i++){
    const near=1-Math.min(1,waterDist[i]/8);
    fert[i]=water[i]?0:clamp((fert[i]*.7+.45*near)*(1-.55*rock[i]),0,1); forest[i]=water[i]?0:clamp(forest[i]*(1-.6*rock[i]),0,1); rock[i]=water[i]?0:rock[i];
  }
}
// multi-source BFS over the torus: for every cell, the nearest water cell and its distance in cells
let water=new Uint8Array(0), waterDist=new Float32Array(0), waterNear=new Int32Array(0);
function buildWaterDistance(){
  const n=FW*FH; waterDist=new Float32Array(n).fill(1e9); waterNear=new Int32Array(n).fill(-1);
  const q=new Int32Array(n); let h=0, t=0;
  for (let i=0;i<n;i++) if (water[i]){ waterDist[i]=0; waterNear[i]=i; q[t++]=i; }
  while (h<t){ const i=q[h++], x=i%FW, y=(i/FW)|0;
    for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const nx=(x+dx+FW)%FW, ny=(y+dy+FH)%FH, j=nx+ny*FW; if (waterDist[j]>waterDist[i]+1){ waterDist[j]=waterDist[i]+1; waterNear[j]=waterNear[i]; q[t++]=j; } } }
}
const cellIdx = (x,y) => (Math.floor(wrapX(x)/FC)%FW)+(Math.floor(wrapY(y)/FC)%FH)*FW;
const isWater = (x,y) => water[cellIdx(x,y)]===1;
// offset from (x,y) to the centre of the nearest water cell, by the shortest way around
function waterVec(x,y,out){ const j=waterNear[cellIdx(x,y)]; if (j<0){ out.dx=0; out.dy=0; out.d=1e9; return out; } const cx=(j%FW+.5)*FC, cy=(((j/FW)|0)+.5)*FC; out.dx=wd(cx-x,W); out.dy=wd(cy-y,H); out.d=Math.hypot(out.dx,out.dy); return out; }
const fieldAt = (f,x,y) => f[cellIdx(x,y)];
function spawnPoint(f, power){
  for (let i=0;i<10;i++){ const x=rnd(0,W), y=rnd(0,H); if (!isWater(x,y)&&Math.random()<.04+.96*Math.pow(fieldAt(f,x,y),power)) return [x,y]; }
  for (let i=0;i<30;i++){ const x=rnd(0,W), y=rnd(0,H); if (!isWater(x,y)) return [x,y]; }
  return [rnd(0,W),rnd(0,H)];
}

// ---------- spatial grids ----------
const mkGrid = () => Array.from({length: GC*GR}, () => []);
let gFood, gTree, gStone, gAgent, GRIDS;
function setSize(){
  shape='square'; GC=W/CELL; GR=H/CELL; FW=W/FC; FH=H/FC;
  pher=new Float32Array(FW*FH); pherTmp=new Float32Array(FW*FH); mateSc=new Float32Array(FW*FH); mateTmp=new Float32Array(FW*FH);
  gFood=mkGrid(); gTree=mkGrid(); gStone=mkGrid(); gAgent=mkGrid(); GRIDS=[gFood,gTree,gStone];
}
let pher, pherTmp, mateSc, mateTmp;
setSize();
function clearGrid(g){ for (let i=0;i<g.length;i++) g[i].length = 0; }
function cellOf(x,y){ return (Math.floor(x/CELL)%GC+GC)%GC + ((Math.floor(y/CELL)%GR+GR)%GR)*GC; }
// visit every grid bin within r of (x,y), wrapping across the edges
function forBins(g,x,y,r,fn){
  const x0=Math.floor((x-r)/CELL), x1=Math.floor((x+r)/CELL), y0=Math.floor((y-r)/CELL), y1=Math.floor((y+r)/CELL);
  for (let cy=y0;cy<=y1;cy++){ const wy=((cy%GR)+GR)%GR; for (let cx=x0;cx<=x1;cx++){ const bin=g[((cx%GC)+GC)%GC+wy*GC]; for (let n=0;n<bin.length;n++) fn(bin[n]); } }
}
function nearestIn(g, a, r, q, skip){
  // expanding-ring search on the torus: stops once no unvisited ring can hold anything closer
  let best=null, d2=r*r, bx=0, by=0;
  const cx0=Math.floor(a.x/CELL), cy0=Math.floor(a.y/CELL), K=Math.min(Math.ceil(r/CELL)+1,(GC>>1)-1);
  for (let k=0;k<=K;k++){
    const y0=cy0-k, y1=cy0+k, x0=cx0-k, x1=cx0+k;
    for (let cy=y0; cy<=y1; cy++){
      const wy=((cy%GR)+GR)%GR, step=(cy===y0||cy===y1)?1:(x1-x0)||1;
      for (let cx=x0; cx<=x1; cx+=step){
        const bin=g[((cx%GC)+GC)%GC+wy*GC];
        for (let n=0;n<bin.length;n++){ const o=bin[n]; if (o.dead||o===skip) continue; const dx=wd(o.x-a.x,W), dy=wd(o.y-a.y,H), dd=dx*dx+dy*dy; if (dd<d2){ d2=dd; best=o; bx=dx; by=dy; } }
      }
    }
    const reach=k*CELL; if (reach*reach>=d2) break;
  }
  q.obj=best; q.dist=best?Math.sqrt(d2):r; q.dx=bx; q.dy=by; return q;
}
function crowdAt(a, r, out){
  let n=0, sig=0; const r2=r*r;
  forBins(gAgent,a.x,a.y,r,o=>{ if (o===a||o.dead) return; const dx=wd(o.x-a.x,W), dy=wd(o.y-a.y,H); if (dx*dx+dy*dy<r2){ n++; sig+=o.signal; } });
  out.n=n; out.sig=n?sig/n:0; return out;
}
function nearestList(list, a, r, q, pred){
  let best=null, d2=r*r;
  let bx=0, by=0;
  for (const b of list){ if (pred&&!pred(b)) continue; const dx=wd(b.x-a.x,W), dy=wd(b.y-a.y,H), dd=dx*dx+dy*dy; if (dd<d2){ d2=dd; best=b; bx=dx; by=dy; } }
  q.obj=best; q.dist=best?Math.sqrt(d2):r; q.dx=bx; q.dy=by; return q;
}
const isShelter = b => (b.type==='house'||b.type==='store')&&b.hp>0;
const isFire = b => b.type==='fire';
const isDamaged = b => b.hp<b.max*.85;

// walls are segments: centre (x,y), half-length r, angle ang
function segDist(px,py,b){ const c=b.c, s=b.s, dx=wd(px-b.x,W), dy=wd(py-b.y,H); const t=clamp(dx*c+dy*s,-b.r,b.r); const ex=dx-c*t, ey=dy-s*t; return Math.sqrt(ex*ex+ey*ey); }
function wallBlocks(nx,ny,pad){ for (const b of walls) if (b.hp>0&&Math.abs(wd(b.x-nx,W))<b.r+pad+2&&Math.abs(wd(b.y-ny,H))<b.r+pad+2&&segDist(nx,ny,b)<pad) return true; return false; }
function nearestWall(a,r){ let d=r; for (const b of walls) if (b.hp>0&&Math.abs(wd(b.x-a.x,W))<b.r+r&&Math.abs(wd(b.y-a.y,H))<b.r+r){ const s=segDist(a.x,a.y,b); if (s<d) d=s; } return d; }

// ---------- senses ----------
// [key, label, query mask, fn(a,e)]
const dir = (a,q,ax) => q.obj ? (ax==='x'?q.dx:q.dy)/Math.max(1,q.dist) : 0;
const pro = (a,q) => q.obj ? 1-q.dist/a._r : 0;
function kinship(a,o){
  if (!o) return 0;
  if (o.parent===a.id||a.parent===o.id||o.coparent===a.id||a.coparent===o.id) return 1;
  if ((a.parent&&(a.parent===o.parent||a.parent===o.coparent))||(a.coparent&&(a.coparent===o.parent||a.coparent===o.coparent))) return .8;
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
  ['hungerDrive','Hunger',0,a=>a.drv.hunger],
  ['thirst','Thirst',0,a=>a.drv.thirst],
  ['grief','Grief',0,a=>a.drv.grief],
  ['inWater','Swimming',0,a=>a.inWater?1:0],
  ['waterX','Water direction X',0,a=>{ const v=waterVec(a.x,a.y,_wv); return v.d>1?v.dx/v.d:0; }],
  ['waterY','Water direction Y',0,a=>{ const v=waterVec(a.x,a.y,_wv); return v.d>1?v.dy/v.d:0; }],
  ['waterNear','Water proximity',0,a=>{ const v=waterVec(a.x,a.y,_wv); return Math.max(0,1-v.d/a._r); }],
  ['scent','Scent here',0,a=>Math.min(1,pher[cellIdx(a.x,a.y)]/4)],
  ['scentX','Scent gradient X',0,a=>clamp((pher[cellIdx(a.x+FC,a.y)]-pher[cellIdx(a.x-FC,a.y)])/2,-1,1)],
  ['scentY','Scent gradient Y',0,a=>clamp((pher[cellIdx(a.x,a.y+FC)]-pher[cellIdx(a.x,a.y-FC)])/2,-1,1)],
  ['friendX','Most trusted yip direction X',Q.FRIEND,(a,e)=>dir(a,e.friend,'x')],
  ['friendY','Most trusted yip direction Y',Q.FRIEND,(a,e)=>dir(a,e.friend,'y')],
  ['friendNear','Most trusted yip proximity',Q.FRIEND,(a,e)=>pro(a,e.friend)],
  ['mateScent','Mating scent here',0,a=>Math.min(1,mateSc[cellIdx(a.x,a.y)]/3)],
  ['mateScentX','Mating scent gradient X',0,a=>clamp((mateSc[cellIdx(a.x+FC,a.y)]-mateSc[cellIdx(a.x-FC,a.y)]),-1,1)],
  ['mateScentY','Mating scent gradient Y',0,a=>clamp((mateSc[cellIdx(a.x,a.y+FC)]-mateSc[cellIdx(a.x,a.y-FC)]),-1,1)],
  ['gratitude','Gratitude owed to nearest yip',Q.OTHER,(a,e)=>e.other.obj?Math.min(1,a.owed.get(e.other.obj.id)||0):0],
  ['coldDrive','Feeling cold or hot',0,a=>a.drv.cold],
  ['fatigue','Fatigue',0,a=>a.drv.fatigue],
  ['lonely','Loneliness',0,a=>a.drv.lonely],
  ['insecure','Insecurity (few supplies)',0,a=>a.drv.insecure],
  ['popularity','Own popularity',0,a=>clamp(repOf(a.id)/5,-1,1)],
  ['agentRep','Nearest yip\'s popularity',Q.OTHER,(a,e)=>e.other.obj?clamp(repOf(e.other.obj.id)/5,-1,1):0],
  ['sheltered','Inside a house or store',0,a=>a.sheltered?1:0],
  ['night','Night',0,()=>dayS<-.15?1:0],
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
  ['agentX','Nearest yip direction X',Q.OTHER,(a,e)=>dir(a,e.other,'x')],
  ['agentY','Nearest yip direction Y',Q.OTHER,(a,e)=>dir(a,e.other,'y')],
  ['agentNear','Nearest yip proximity',Q.OTHER,(a,e)=>pro(a,e.other)],
  ['kin','Kinship with nearest yip',Q.OTHER,(a,e)=>kinship(a,e.other.obj)],
  ['trust','Trust toward nearest yip',Q.OTHER,(a,e)=>e.other.obj?(a.trust.get(e.other.obj.id)||0):0],
  ['agentEnergy','Nearest yip energy',Q.OTHER,(a,e)=>e.other.obj?e.other.obj.energy/100-1:0],
  ['agentFood','Nearest yip carries food',Q.OTHER,(a,e)=>e.other.obj?Math.min(1,e.other.obj.inv.food/3):0],
  ['agentTool','Nearest yip holds a tool',Q.OTHER,(a,e)=>e.other.obj&&e.other.obj.tool>0?1:0],
  ['agentStrength','Nearest yip strength vs mine',Q.OTHER,(a,e)=>e.other.obj?clamp(e.other.obj.traits.strength-a.traits.strength,-1,1):0],
  ['agentHue','Nearest yip color',Q.OTHER,(a,e)=>e.other.obj?Math.cos(e.other.obj.traits.hue*Math.PI/180):0],
  ['signal','Nearest yip\'s voice',Q.OTHER,(a,e)=>e.other.obj?e.other.obj.signal:0],
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
const DEFAULT_INPUTS = ['bias','energy','health','pain','thirst','waterX','waterY','coldDrive','lonely','foodX','foodY','foodNear','agentX','agentY','agentNear','friendX','friendY','mateScentX','mateScentY','predX','predY','predNear','foodStock','memA','memB','signal'];
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
  const b=a.brain; a.learned=b.w.map(f=>new Float32Array(f.length)); a.eff=b.w.map(f=>new Float32Array(f)); a.tr=b.w.map(f=>new Float32Array(f.length)); a.acts=b.sizes.map(n=>new Float32Array(n));
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
    const last=l===L-1;
    // hidden layers and continuous outputs use tanh; action preferences are linear so a brain can become decisive
    for (let j=0;j<rows;j++){ let s=0, base=j*cols; for (let i=0;i<cols;i++) s+=w[base+i]*p[i]; out[j]=last&&j<O?(s>8?8:s<-8?-8:s):ftanh(s); }
  }
  const z=acts[L], temp=.22+a.traits.explore; let m=-1e9;
  for (let i=0;i<O;i++) if (z[i]>m) m=z[i];
  let sum=0; for (let i=0;i<O;i++){ ex[i]=Math.exp((z[i]-m)/temp); sum+=ex[i]; }
  let r=Math.random(), choice=O-1;
  for (let i=0;i<O;i++) a.probs[i]=ex[i]/sum;
  for (let i=0;i<O;i++){ if ((r-=a.probs[i])<=0){ choice=i; break; } }
  a.signal=z[O]; a.memA=.7*a.memA+.3*z[O+1]; a.memB=.7*a.memB+.3*z[O+2]; if (z[O+3]>0) pher[cellIdx(a.x,a.y)]+=z[O+3]*.5;
  a.lastChoice=choice; return temp;
}
// Lifetime learning: policy gradient with eligibility traces. Each tick the gradient of the chosen action's
// log-probability is added to a fading trace (lambda); every reward then updates the weights along that trace,
// so relief that arrives later (eating) also credits the steps that led to it (walking to food, harvesting).
const LAMBDA=.93;
function learn(a, reward, temp){
  const adv=clamp(reward-a.baseline,-4,4); a.baseline=.985*a.baseline+.015*reward;
  const b=a.brain, acts=a.acts, step=a.traits.lr*adv, L=b.w.length; let grad=gradA, back=gradB;
  for (let i=0;i<O;i++) grad[i]=((i===a.lastChoice?1:0)-a.probs[i])/temp;
  for (let i=O;i<NOUT;i++) grad[i]=0;
  // the first layer (sensory wiring) is left to evolution; lifetime learning adjusts the deeper layers
  const stop=L>1?1:0;
  for (let l=L-1;l>=stop;l--){
    const w=b.w[l], e=a.eff[l], d=a.learned[l], tr=a.tr[l], prev=acts[l], next=acts[l+1], cols=b.sizes[l], rows=b.sizes[l+1], deep=l>stop, last=l===L-1;
    if (deep) for (let i=0;i<cols;i++) back[i]=0;
    for (let j=0;j<rows;j++){
      const g=last?(j<O?grad[j]:0):grad[j]*(1-next[j]*next[j]), base=j*cols;
      for (let i=0;i<cols;i++){
        const k=base+i; if (deep&&g!==0) back[i]+=g*e[k];
        const tv=tr[k]*LAMBDA+g*prev[i]; tr[k]=tv;
        if (step!==0){ let v=d[k]+step*tv; v=v>2?2:v<-2?-2:v; d[k]=v; e[k]=w[k]+v; }
      }
    }
    const t=grad; grad=back; back=t;
  }
}

// ---------- drives & reward ----------
// Rewards come from inside the yip. Each drive is an urgency from 0 (satisfied) to 1 (desperate):
//   hunger, cold/heat, injury, fatigue, loneliness, insecurity.
// Wellbeing = -sum(weight * urgency^2) and reward = change in wellbeing. Squaring makes relief worth the most when
// the need is greatest and almost nothing once satisfied (sitting by a fire pays less every tick), while a slowly
// growing need builds the desire back up. It is a potential over the yip's own state, so no loop can farm it.
const DRIVES = ['hunger','thirst','cold','injury','fatigue','lonely','insecure','grief'];
function updateDrives(a,lt,moved,exertion,restBoost){
  const ph=a.ph, d=a.drv;
  d.hunger=clamp(1-a.energy/(ph.maxE*.7),0,1);
  d.thirst=clamp(d.thirst+.0005*(1+Math.max(0,lt-24)/12),0,1);   // grows faster in the heat; only drinking lowers it
  const disc=clamp((Math.max(0,ph.coldT-lt)+Math.max(0,lt-ph.hotT))/12,0,1);
  d.cold+=(disc-d.cold)*(disc>d.cold?.015:.12);                     // chill builds slowly, warmth relieves fast
  d.injury=clamp((1-a.health/ph.maxH)*.8+a.pain*.4,0,1);
  d.fatigue=clamp(d.fatigue+.0002+(moved?.00025:0)+exertion-restBoost,0,1);
  d.insecure=clamp(1-(a.inv.food+.4*a.inv.wood+.4*a.inv.stone+.8*a.stash+3*(ownVal.get(a.id)||0))/6,0,1);
  d.grief=Math.max(0,d.grief-.0015);   // grief fades slowly; witnessing a death raises it (see onDeath)
  // loneliness is updated where yips meet (socialTick) and relieved by thanks
}
function wellbeing(a){
  const d=a.drv, t=a.traits;
  return -(d.hunger*d.hunger + d.thirst*d.thirst + d.cold*d.cold + t.caution*d.injury*d.injury + .6*d.fatigue*d.fatigue + 1.6*t.social*d.lonely*d.lonely + (.5+t.greed)*d.insecure*d.insecure + d.grief*d.grief);
}
const MATV={wood:.12,stone:.15}; let ownVal=new Map();
const buildValue=b=>{ const s=SPECS[b.type]; return (s.wood*MATV.wood+s.stone*MATV.stone)*Math.max(0,b.hp/b.max); };
const REWARD_SCALE=8;   // one wellbeing unit = one energy-100; scaled so learning moves at a useful pace
const actFreq=new Float64Array(O).fill(1/O), okTick=new Float64Array(O);
function updateActFreq(){ let s=0; for (let i=0;i<O;i++) s+=okTick[i]; if (s>0) for (let i=0;i<O;i++){ actFreq[i]=.995*actFreq[i]+.005*okTick[i]/s; okTick[i]=0; } }

// ---------- agents ----------
// ---------- genetics ----------
// Physical traits change slowly between generations and draw heavily on the body budget.
// Mental traits (temperament and motivations) mutate fast and cost almost nothing.
const PHYS = ['budget','strength','speed','thermal','sense','rest','regen'];
const MENT = ['lr','explore','curiosity','aggression','social','trustful','despTrust','dread','altruism','greed','caution'];
const TRAIT_INFO = {
  budget:['Body budget','Room for costly traits before metabolism suffers; larger bodies burn more at rest'],
  strength:['Strength','Damage, carrying capacity and winning food fights'],
  speed:['Speed','Movement per step'],
  thermal:['Thermal tolerance','How slowly cold and heat drain energy'],
  sense:['Sensing range','How far it can perceive food, other yips, beasts and shelter'],
  rest:['Rest efficiency','Energy regained while resting, most of all inside a house'],
  regen:['Regeneration','Health recovered over time while fed'],
  lr:['Learning rate','How fast experience reshapes its brain during life'],
  explore:['Impulsiveness','Randomness in its choices'],
  curiosity:['Curiosity','Reward for succeeding at things few yips do; fades with repetition'],
  aggression:['Aggression','Harder hits, at a higher energy cost'],
  social:['Sociability','How much it needs company; loneliness weighs more'],
  despTrust:['Desperation response','Positive: hardship makes it trust others faster. Negative: hardship makes it suspicious'],
  dread:['Fear of death','How much seeing a yip die hurts, most of all one it trusted or was related to'],
  trustful:['Trustfulness','How readily it trusts, and how much benefit of the doubt it gives yips it already trusts'],
  altruism:['Altruism','How much helping a needier kin or ally feels like a gain'],
  greed:['Greed','How much food in its own store counts as wealth'],
  caution:['Caution','How much its own health counts toward wellbeing'],
};
const TB = {budget:[2,15],strength:[.2,3],speed:[.2,3],thermal:[.2,2.5],sense:[30,210],rest:[.2,3],regen:[.2,3],
  lr:[.0001,.15],explore:[.02,2.8],curiosity:[0,3],aggression:[.05,3],social:[.2,2.5],trustful:[.1,2],despTrust:[-1,1],dread:[0,2],altruism:[0,2],greed:[0,1.5],caution:[.1,3]};
function freshTraits(){ return {budget:rnd(6.5,9),strength:rnd(.8,1.5),speed:rnd(.8,1.6),thermal:rnd(.6,1.4),sense:rnd(60,130),rest:rnd(.7,1.3),regen:rnd(.7,1.3),
  lr:rnd(.004,.03),explore:rnd(.12,1.2),curiosity:rnd(.2,1.2),aggression:rnd(.2,1),social:rnd(.3,1.4),trustful:rnd(.5,1.2),despTrust:rnd(-.3,.3),dread:rnd(.3,1),altruism:rnd(0,.6),greed:rnd(0,.6),caution:rnd(.5,1.5),hue:rnd(0,360)}; }

// Physical upgrade trees. Each perk has a benefit and a drawback; some are physically incompatible.
const PERKS = [
  {id:'muscle',tree:'Might',req:null,cost:1,name:'Dense muscle',good:'+25% attack and hunt damage',bad:'+6% metabolism'},
  {id:'hide',tree:'Might',req:'muscle',cost:1.2,name:'Thick hide',good:'Takes 30% less damage',bad:'−10% speed'},
  {id:'jugg',tree:'Might',req:'hide',cost:1.5,name:'Juggernaut',good:'+3 carry capacity; beast bites halved',bad:'−15% speed, +8% metabolism'},
  {id:'legs',tree:'Swift',req:null,cost:1,name:'Long legs',good:'+15% speed',bad:'−1 carry capacity'},
  {id:'sprint',tree:'Swift',req:'legs',cost:1.2,name:'Sprinter',good:'+20% speed while energy is above 60',bad:'+6% metabolism'},
  {id:'lean',tree:'Swift',req:'legs',cost:.8,name:'Lean frame',good:'−12% metabolism',bad:'Max health 80'},
  {id:'sleeper',tree:'Endurance',req:null,cost:.8,name:'Deep sleeper',good:'Resting restores 60% more energy',bad:'−10% sensing range'},
  {id:'healer',tree:'Endurance',req:'sleeper',cost:1.2,name:'Fast healer',good:'Heals steadily even while hungry',bad:'+5% metabolism'},
  {id:'hibernate',tree:'Endurance',req:'sleeper',cost:1,name:'Hibernator',good:'−30% metabolism below 10°C',bad:'−10% speed'},
  {id:'eyes',tree:'Senses',req:null,cost:1,name:'Keen eyes',good:'+30 sensing range',bad:'+4% metabolism'},
  {id:'night',tree:'Senses',req:'eyes',cost:1,name:'Night vision',good:'Full sensing range at night',bad:'Overheats 4°C sooner'},
  {id:'tremor',tree:'Senses',req:'eyes',cost:1,name:'Tremor sense',good:'Detects beasts from 1.6× as far',bad:'−5% speed'},
  {id:'fur',tree:'Climate',req:null,cost:1,name:'Fur coat',good:'Comfortable down to 5°C',bad:'Overheats above 26°C'},
  {id:'sweat',tree:'Climate',req:null,cost:1,name:'Sweat glands',good:'Comfortable up to 39°C',bad:'Chills below 18°C'},
  {id:'webbed',tree:'Aquatic',req:null,cost:1,name:'Webbed feet',good:'Swims 70% faster at half the energy',bad:'−6% speed on land'},
  {id:'blubber',tree:'Aquatic',req:'webbed',cost:1.2,name:'Blubber',good:'Water barely chills it',bad:'Overheats 4°C sooner, +5% metabolism'},
  {id:'gut',tree:'Gut',req:null,cost:1,name:'Efficient gut',good:'Food gives 25% more energy',bad:'Max energy 175'},
  {id:'fat',tree:'Gut',req:'gut',cost:1.2,name:'Fat reserves',good:'Max energy 260',bad:'−8% speed'},
];
const PERK = Object.fromEntries(PERKS.map(p=>[p.id,p]));
const CLASH = [['blubber','sweat'],['blubber','lean'],['jugg','sprint'],['hide','lean'],['fur','sweat'],['fat','lean'],['hibernate','sprint']];
const clashes = (perks,id) => CLASH.some(([x,y])=>(x===id&&perks.includes(y))||(y===id&&perks.includes(x)));
function perkAvailable(perks,p){ return !perks.includes(p.id)&&(!p.req||perks.includes(p.req))&&!clashes(perks,p.id); }
function mutatePerks(src){
  const perks=[...src], mu=settings.mutation;
  if (Math.random()<.07*mu){ const opts=PERKS.filter(p=>perkAvailable(perks,p)); if (opts.length) perks.push(pick(opts).id); }
  if (Math.random()<.035*mu&&perks.length){ const leaves=perks.filter(id=>!perks.some(o=>PERK[o].req===id)); if (leaves.length) perks.splice(perks.indexOf(pick(leaves)),1); }
  return perks;
}
const perkCost = perks => perks.reduce((s,id)=>s+(PERK[id]?PERK[id].cost:0),0);
const traitCost = (t,perks=[]) => t.strength*1.7+t.speed*1.5+t.thermal*.8+t.sense/95+t.rest*.6+t.regen*.7+perkCost(perks)+(t.social+t.aggression)*.12;
const traitMetab = (t,perks=[]) => { const c=traitCost(t,perks); return .7+.12*t.budget+.13*Math.max(0,c-t.budget)+.025*c; };
// derived physiology: what the traits and perks add up to, cached on the agent
function derive(a){
  const t=a.traits, has=id=>a.perks.includes(id);
  const ph={speed:1,dmg:1,armor:1,beastArmor:1,carry:0,metab:1,senseAdd:0,senseMul:1,coldT:15,hotT:31,food:1,maxE:200,maxH:100,rest:t.rest,regen:.004*t.regen,predMul:1,night:false,hib:false,sprint:false,swim:1,chill:1};
  if (has('muscle')){ ph.dmg*=1.25; ph.metab*=1.06; }
  if (has('hide')){ ph.armor*=.7; ph.speed*=.9; }
  if (has('jugg')){ ph.carry+=3; ph.beastArmor*=.5; ph.speed*=.85; ph.metab*=1.08; }
  if (has('legs')){ ph.speed*=1.15; ph.carry-=1; }
  if (has('sprint')){ ph.sprint=true; ph.metab*=1.06; }
  if (has('lean')){ ph.metab*=.88; ph.maxH=80; }
  if (has('sleeper')){ ph.rest*=1.6; ph.senseMul*=.9; }
  if (has('healer')){ ph.regen+=.025; ph.metab*=1.05; }
  if (has('hibernate')){ ph.hib=true; ph.speed*=.9; }
  if (has('eyes')){ ph.senseAdd+=30; ph.metab*=1.04; }
  if (has('night')){ ph.night=true; ph.hotT-=4; }
  if (has('tremor')){ ph.predMul=1.6; ph.speed*=.95; }
  if (has('fur')){ ph.coldT=5; ph.hotT=Math.min(ph.hotT,26); }
  if (has('sweat')){ ph.hotT+=8; ph.coldT=18; }
  if (has('webbed')){ ph.swim=1.7; ph.speed*=.94; }
  if (has('blubber')){ ph.chill=.2; ph.hotT-=4; ph.metab*=1.05; }
  if (has('gut')){ ph.food=1.25; ph.maxE=175; }
  if (has('fat')){ ph.maxE=260; ph.speed*=.92; }
  ph.sense=(t.sense+ph.senseAdd)*ph.senseMul;
  ph.baseMetab=traitMetab(t,a.perks);
  a.ph=ph; a.health=Math.min(a.health,ph.maxH);
}
function mutateTraits(src){
  const t={}, mu=Math.sqrt(settings.mutation), sP=.07*mu, sM=.2*mu;
  for (const k in src){
    const v=src[k];
    if (k==='hue'){ t[k]=(v+rnd(-20,20)+360)%360; continue; }
    const [lo,hi]=TB[k]||[.2,2.5], phys=PHYS.includes(k);
    t[k]=phys&&Math.random()>.4 ? v : k==='despTrust' ? clamp(v+rnd(-.12,.12)*mu,lo,hi) : clamp(v*Math.exp(rnd(-1,1)*(phys?sP:sM))+(k==='altruism'||k==='greed'||k==='dread'?rnd(-.03,.03):0),lo,hi);
  }
  for (const k of [...PHYS,...MENT]) if (t[k]==null) t[k]=freshTraits()[k];
  return t;
}
// Names: 1-4 syllables, each a vowel then a consonant; half are written backwards (Alaboj -> Jobala) for variety.
const VOW='aeiou', CON='bcdfghjklmnprstvwyz';
function makeName(){
  let n=''; const k=1+Math.floor(Math.random()*4);
  for (let i=0;i<k;i++) n+=VOW[Math.floor(Math.random()*5)]+CON[Math.floor(Math.random()*CON.length)];
  if (Math.random()<.5) n=[...n].reverse().join('');
  return n[0].toUpperCase()+n.slice(1);
}
function makeAgent(x,y,brain=freshBrain(),gen=0,parent=null,traits=freshTraits(),energy=90,lineage=[],perks=[]){
  const a={id:nextId++,name:makeName(),x,y,vx:0,vy:0,hd:rnd(0,6.283),brain,gen,parent,lineage,traits,energy,health:100,prevHealth:100,lastBirth:-1e9,age:0,lifespan:rnd(3600,5100),
    inv:{food:0,wood:0,stone:0},tool:0,memory:0,memA:0,memB:0,signal:0,pain:0,trust:new Map(),lastChoice:O-1,probs:new Float32Array(O),
    builds:0,success:0,kids:0,shared:0,stolen:0,attacks:0,kills:0,hunts:0,beastKills:0,crafts:0,deposits:0,
    actionCounts:new Uint32Array(O),okCounts:new Uint32Array(O),stash:0,shareHeat:0,phi:0,baseline:0,
    drv:{grief:0,hunger:0,thirst:.2,cold:0,injury:0,fatigue:.1,lonely:.2,insecure:.8},owed:new Map(),inWater:false,thanked:new Map(),thanksGot:0,lovesGot:0,coparent:null,partners:0,sheltered:false,harm:'hunger',fx:0,_t:20};
  for (const k of [...PHYS,...MENT]) if (a.traits[k]==null) a.traits[k]=freshTraits()[k];
  a.perks=perks.filter(id=>PERK[id]); derive(a); updateDrives(a,20,false,0,0); a.phi=wellbeing(a);
  compileBrain(a); if (gen>maxGen) maxGen=gen; return a;
}
// using another yip's store or house with its owner's trust: the guest feels grateful
function hostGrace(a,b,strength){ const ow=b.owner&&b.owner!==a.id?byId.get(b.owner):null; if (!ow) return; gainTrust(a,ow.id,.03*strength); owe(a,ow,.3*strength); }
function bestFriend(a,r,q){
  let best=null, bv=.15, bx=0, by=0;
  forBins(gAgent,a.x,a.y,r,o=>{ if (o===a||o.dead) return; const t=a.trust.get(o.id)||0; if (t<=bv) return; const dx=wd(o.x-a.x,W), dy=wd(o.y-a.y,H); if (dx*dx+dy*dy>r*r) return; bv=t; best=o; bx=dx; by=dy; });
  q.obj=best; q.dx=bx; q.dy=by; q.dist=best?Math.hypot(bx,by):r; q.t=best?bv:0; return q;
}
function socialTick(a){
  // loneliness eases near yips it trusts and grows when alone among strangers or enemies
  let friends=0; const r=40;
  forBins(gAgent,a.x,a.y,r,o=>{
    if (o===a||o.dead||wdist(a,o)>=r) return;
    const t=a.trust.get(o.id)||0;
    if (t>-.1) gainTrust(a,o.id,.025);        // familiarity: time spent near a yip that hasn't hurt you builds a little trust on its own
    if (t>.25||kinship(a,o)>.4) friends++;
  });
  const d=a.drv; d.lonely=clamp(d.lonely+(friends?-.015*Math.min(3,friends):.01*a.traits.social),0,1);
}
function findMate(a,need){
  let best=null, bt=need;
  forBins(gAgent,a.x,a.y,50,o=>{
    if (o===a||o.dead||o.energy<60||o.age<150||ticks-o.lastBirth<=200||wdist(a,o)>50||kinship(a,o)>=1) return;
    const m=Math.min(a.trust.get(o.id)||0,o.trust.get(a.id)||0); if (m>bt){ bt=m; best=o; }
  });
  return best;
}
function blendTraits(x,y){ const t={}; for (const k in x){ if (k==='hue'){ let d=((y.hue-x.hue+540)%360)-180; t.hue=(x.hue+d*Math.random()+360)%360; continue; } const w=Math.random(); t[k]=y[k]==null?x[k]:x[k]*w+y[k]*(1-w); } return t; }
function child(a,mate){
  if (!mate) return soloChild(a);
  const lineage=[{id:a.id,name:a.name,gen:a.gen,hue:a.traits.hue},...a.lineage].slice(0,12);
  // traits blend, compatible upgrades can come from either parent, and the brain comes from one of them
  const traits=blendTraits(a.traits,mate.traits), perks=[...a.perks];
  for (const id of mate.perks) if (Math.random()<.5&&perkAvailable(perks,PERK[id])) perks.push(id);
  mate.drv.lonely=Math.max(0,mate.drv.lonely-.25); a.drv.lonely=Math.max(0,a.drv.lonely-.25);
  a.partners++; mate.partners++; tally.pairings++;
  const brain=Math.random()<.5?a.brain:mate.brain;
  const c=makeAgent(wrapX((a.x+wd(mate.x-a.x,W)/2)+rnd(-6,6)),wrapY((a.y+wd(mate.y-a.y,H)/2)+rnd(-6,6)),mutateBrain(brain),Math.max(a.gen,mate.gen)+1,a.id,mutateTraits(traits),80,lineage,mutatePerks(perks));
  c.coparent=mate.id;
  const inbred=kinship(a,mate); if (inbred>0){ c.lifespan*=1-.35*inbred; c.health=c.ph.maxH*(1-.3*inbred); c.inbred=inbred; }
  setTrust(c,a.id,.5); setTrust(a,c.id,.5); setTrust(c,mate.id,.5); setTrust(mate,c.id,.5);
  a.kids++; mate.kids++; return c;
}
function soloChild(a){   // only used when reseeding from the archive
  const c=makeAgent(wrapX(a.x+rnd(-13,13)),wrapY(a.y+rnd(-13,13)),mutateBrain(a.brain),a.gen+1,a.id,mutateTraits(a.traits),80,[{id:a.id,name:a.name,gen:a.gen,hue:a.traits.hue},...a.lineage].slice(0,12),mutatePerks(a.perks));
  a.kids++; return c;
}
const load = a => a.inv.food+a.inv.wood*1.4+a.inv.stone*2;
const capacity = a => Math.max(1,2+a.traits.strength*4+a.ph.carry);
const repMap=new Map();   // id -> sum of trust other living yips hold toward it
const repOf = id => repMap.get(id)||0;
function setTrust(a,id,v){
  v=clamp(v,-1,1); const old=a.trust.get(id)||0; a.trust.set(id,v); repMap.set(id,repOf(id)+v-old);
  if (a.trust.size>48){ const all=[...a.trust].sort((x,y)=>Math.abs(y[1])-Math.abs(x[1])); for (const [k,w] of all.slice(32)) repMap.set(k,repOf(k)-w); a.trust=new Map(all.slice(0,32)); }
}
// trust is slow to earn (diminishing as it nears 1, scaled by the truster's sociability) and quick to lose
const hardship = a => Math.max(a.drv.hunger,a.drv.thirst,a.drv.injury,a.drv.cold);
function gainTrust(a,id,x){ const t=a.trust.get(id)||0, dm=Math.max(.2,1+a.traits.despTrust*hardship(a)); setTrust(a,id,t+x*.6*a.traits.trustful*dm*(1-Math.max(0,t))); }
function loseTrust(a,id,x){ const t=a.trust.get(id)||0, dm=Math.max(.3,1-.6*a.traits.despTrust*hardship(a)); setTrust(a,id,t-x*dm); }
function forgetAll(a){ for (const [k,w] of a.trust) repMap.set(k,repOf(k)-w); a.trust.clear(); }
// a yip that benefits from another thanks them; a trusted, satisfied yip may say it with love
// Receiving help is remembered as gratitude owed to the helper. Nothing forces a yip to act on it:
// it can sense what it owes the yip nearest to it, and Thank is an ordinary action it may or may not choose.
function owe(g,b,amount){ if (!b||b.dead||b===g) return; g.owed.set(b.id,Math.min(2,(g.owed.get(b.id)||0)+amount)); if (g.owed.size>16){ let mk=null, mv=1e9; for (const [k,v] of g.owed) if (v<mv){ mv=v; mk=k; } g.owed.delete(mk); } }
// What thanking does: the thanked yip feels appreciated (loneliness eases, scaled by its altruism) and trusts the thanker a little.
// Thanking the same yip again soon means less. A thank-you from a yip that trusts you a lot lands harder (shown as 😍).
function thank(g,b){
  const last=g.thanked.get(b.id), fresh=last===undefined?1:Math.min(1,(ticks-last)/300);
  g.thanked.set(b.id,ticks); if (g.thanked.size>24) g.thanked.delete(g.thanked.keys().next().value);
  const tr=Math.max(0,g.trust.get(b.id)||0), warmth=fresh*(.5+tr);
  b.drv.lonely=Math.max(0,b.drv.lonely-.08*warmth*(.5+b.traits.altruism));
  gainTrust(b,g.id,.05*warmth);
  g.owed.set(b.id,Math.max(0,(g.owed.get(b.id)||0)-1));
  if (tr>.55){
    b.lovesGot++; tally.loves++; g.fx|=256;
    // a loving thank-you between two yips ready to breed can lead to a child
    const ready=y=>y.energy>60&&y.age>150&&ticks-y.lastBirth>200;
    if (ready(g)&&ready(b)&&kinship(g,b)<1&&(b.trust.get(g.id)||0)>.1&&Math.random()<.25&&agents.length+pendingBirths.length<settings.popCap){
      g.energy-=30; b.energy-=30; g.lastBirth=b.lastBirth=ticks; pendingBirths.push(child(g,b)); births++; tally.loveBirths++;
    }
  } else { b.thanksGot++; tally.thanks++; g.fx|=128; }
}
// A death is felt by those who see it: grief rises with fear of death, more for kin and trusted yips,
// and only a little for strangers. Then the dead are forgotten: every memory of them (trust, gratitude) is dropped.
function onDeath(a){
  forBins(gAgent,a.x,a.y,70,w=>{
    if (w===a||w.dead) return; const d=wdist(a,w); if (d>=70) return;
    const bond=Math.max(kinship(w,a),Math.max(0,w.trust.get(a.id)||0));
    w.drv.grief=Math.min(1,w.drv.grief+w.traits.dread*(.05+.45*bond)*(1-d/90));
  });
  graveNames.set(a.id,{name:a.name,cause:a.age>a.lifespan?'age':a.harm,age:a.age,gen:a.gen,kids:a.kids}); if (graveNames.size>64) graveNames.delete(graveNames.keys().next().value);
  forgetAll(a); repMap.delete(a.id);
  for (const o of agents){ if (o===a) continue; const t=o.trust.get(a.id); if (t!==undefined){ o.trust.delete(a.id); } o.owed.delete(a.id); o.thanked.delete(a.id); }
}
function witness(attacker,victim,amount){
  // Bystanders judge an attack by how they feel about both sides.
  //  - victim is kin or a friend: big loss of trust in the attacker
  //  - victim is a stranger: small loss
  //  - victim is distrusted: a small, slow gain ("enemy of my enemy")
  // A trustful witness gives a yip it already trusts the benefit of the doubt, unless its own kin was hurt.
  forBins(gAgent,attacker.x,attacker.y,40,w=>{
    if (w===attacker||w===victim||w.dead||wdist(w,attacker)>=40) return;
    const kin=kinship(w,victim), tv=w.trust.get(victim.id)||0, ta=w.trust.get(attacker.id)||0;
    if (tv<-.2&&kin<.3){ gainTrust(w,attacker.id,amount*.6*-tv); return; }
    const care=.5+kin+Math.max(0,tv), doubt=kin>.3?1:1-.4*w.traits.trustful*Math.max(0,ta);
    loseTrust(w,attacker.id,amount*care*Math.max(.2,doubt));
  });
}
// bystanders who see a yip help someone (or fight off a beast) trust it a little more, scaled by how they feel about who was helped
function witnessGood(helper,helped,amount){
  forBins(gAgent,helper.x,helper.y,40,w=>{
    if (w===helper||w===helped||w.dead||wdist(w,helper)>=40) return;
    const view=helped?Math.max(kinship(w,helped),w.trust.get(helped.id)||0):.5;
    if (view>-.2) gainTrust(w,helper.id,amount*(.3+Math.max(0,view)));
  });
}

function addItem(type,x,y){
  if (items.length>4500) return;
  const t=ITYPES.indexOf(type);
  if (x===undefined){ [x,y]=spawnPoint(t===0?fert:t===1?forest:rock,t===0?1.6:2.2); }
  const life=t===0?rnd(400,1100):t===1?rnd(1600,3600):rnd(2500,6000);
  x=wrapX(x); y=wrapY(y); if (isWater(x,y)) return;
  items.push({t,type,x,y,life,max:life,dead:false});
}
function occupied(x,y,r,type){
  for (const b of buildings){
    if (type==='wall'&&b.type==='wall'){ if (wdistXY(b.x,b.y,x,y)<10) return true; continue; }
    const br=b.type==='wall'?4:b.r, d=b.type==='wall'?segDist(x,y,b):wdistXY(b.x,b.y,x,y);
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
  x=wrapX(x); y=wrapY(y);
  if (isWater(x,y)||occupied(x,y,r,type)) return false;
  a.inv.wood-=s.wood; a.inv.stone-=s.stone; placeBuilding(type,x,y,a.id,ang); a.builds++; tally.builds++;
  if (buildings.length%20===0) log(`${buildings.length} structures standing`,'build');
  return true;
}
function log(s,kind='info'){ events.unshift({t:ticks,s,kind}); if (events.length>80) events.length=80; }
function toast(s,kind,important=false){ self.postMessage({type:'toast',s,kind,important}); }
function dropInventory(a){
  for (const k of ['food','wood','stone']) for (let i=0;i<a.inv[k];i++) addItem(k==='wood'?'tree':k,a.x+rnd(-6,6),a.y+rnd(-6,6));
  a.inv.food=a.inv.wood=a.inv.stone=0;
}

// ---------- beasts ----------
let nextBeast=1;
function spawnBeast(x,y){
  if (x===undefined){ [x,y]=spawnPoint(rock,.5); }
  beasts.push({id:nextBeast++,x,y,vx:0,vy:0,hd:0,hp:40,max:40,cd:0,energy:100,age:0,target:null,wander:rnd(0,6.28)});
}
const _bq={}, _bf={};
function tickBeasts(){
  if (beasts.length<settings.beasts&&Math.random()<1/600) spawnBeast();
  while (beasts.length>settings.beasts+3) beasts.shift();
  const pw=settings.beastPower;
  for (const z of beasts){
    z.age++; z.cd--; z.energy-=.03;
    let tgt=z.target&&!z.target.dead&&!z.target.sheltered&&!z.target.inWater&&wdist(z,z.target)<160?z.target:null;
    if (!tgt){ const q=nearestIn(gAgent,z,110,_bq); tgt=q.obj&&!q.obj.sheltered&&!q.obj.inWater?q.obj:null; }
    z.target=tgt;
    let ax, ay, sp;
    const f=nearestList(fires,z,48,_bf);
    if (f.obj){ ax=-f.dx; ay=-f.dy; sp=1.9; }
    else if (tgt){ ax=ddx(z,tgt); ay=ddy(z,tgt); sp=1.55*(.8+.2*pw); }
    else { z.wander+=rnd(-.3,.3); ax=Math.cos(z.wander); ay=Math.sin(z.wander); sp=.6; }
    const n=Math.hypot(ax,ay)||1; z.vx=z.vx*.7+ax/n*sp*.3; z.vy=z.vy*.7+ay/n*sp*.3;
    const nx=wrapX(z.x+z.vx), ny=wrapY(z.y+z.vy);
    // beasts cannot swim: water stops them like a wall
    if (wallBlocks(nx,ny,4.5)||isWater(nx,ny)){ z.vx*=-.5; z.vy*=-.5; z.wander+=Math.PI/2; } else { z.x=nx; z.y=ny; }
    if (z.vx*z.vx+z.vy*z.vy>.01) z.hd=Math.atan2(z.vy,z.vx);
    if (tgt&&z.cd<=0&&wdist(z,tgt)<7){ const dmg=5*pw*(.6+.4*Math.random()); tgt.health-=dmg*tgt.ph.armor*tgt.ph.beastArmor; tgt.pain=1; tgt.harm='beast'; tgt.fx|=32; z.cd=18; z.energy=Math.min(140,z.energy+8); }
  }
  for (let i=beasts.length-1;i>=0;i--){ const z=beasts[i]; if (z.hp<=0||z.energy<=0||z.age>12000){ if (z.hp<=0) for (let k=0;k<4;k++) addItem('food',z.x+rnd(-8,8),z.y+rnd(-8,8)); beasts.splice(i,1); } }
}

// ---------- environment ----------
function temperature(){ return settings.temperature+dayS*6+seasonS*10; }
function stormAt(a){ for (const s of storms) if (Math.abs(wd(a.x-s.x,W))<s.w/2&&Math.abs(wd(a.y-s.y,H))<s.h/2) return s; return null; }
function inside(a){
  for (const b of shelters){ if (b.hp<=0) continue; const dx=wd(a.x-b.x,W), dy=wd(a.y-b.y,H); if (dx*dx+dy*dy<(b.r-1)*(b.r-1) && (!b.owner||b.owner===a.id||(a.trust.get(b.owner)||0)>-.25)) return b; }
  return null;
}
function tempAt(a){
  let t=baseTemp; for (const b of fires) if (b.hp>0){ const dx=wd(a.x-b.x,W), dy=wd(a.y-b.y,H); if (dx*dx+dy*dy<4225) t+=22*(1-Math.sqrt(dx*dx+dy*dy)/65); }
  const s=inside(a); if (s) t=20+(t-20)*(s.type==='house'?.2:.55);   // houses insulate: interiors stay near 20°C
  if (isWater(a.x,a.y)) t=Math.min(t,baseTemp*.8)-6*a.ph.chill;      // water is colder than the air and steals body heat
  return t;
}
const env = {friend:{},food:{},tree:{},stone:{},shelter:{},fire:{},storm:{},other:{},pred:{},crowd:{n:0,sig:0},wall:30};
function sense(a){
  const r=a.ph.sense*(dayS<-.15&&!a.ph.night?.75:1), m=a.qmask; a._r=r;
  if (m&Q.FOOD) nearestIn(gFood,a,r,env.food);
  if (m&Q.TREE) nearestIn(gTree,a,r,env.tree);
  if (m&Q.STONE) nearestIn(gStone,a,r,env.stone);
  if (m&Q.SHELTER) nearestList(shelters,a,r,env.shelter,isShelter);
  if (m&Q.FIRE) nearestList(fires,a,r,env.fire);
  if (m&Q.STORM) nearestList(storms,a,r,env.storm);
  if (m&Q.PRED) nearestList(beasts,a,r*a.ph.predMul,env.pred);
  if (m&Q.CROWD) crowdAt(a,40,env.crowd);
  if (m&Q.WALL) env.wall=nearestWall(a,30);
  if (m&Q.FRIEND) bestFriend(a,r,env.friend);
  nearestIn(gAgent,a,r,env.other,a);
  const inp=a.acts[0], codes=a.codes;
  for (let i=0;i<codes.length;i++) inp[i]=SFN[codes[i]](a,env);
}
const _h={}, _r={}, _z={}, _f2={}, _fw={}, _wv={};
let byId=new Map(), pendingBirths=[];
const graveNames=new Map();   // recent deaths, so the inspector can still name a yip that just died
function act(a,choice,e){
  let bonus=0, ok=false, moved=false; const insideNow=inside(a); a.actionCounts[choice]++;
  const o=e.other.obj, od=e.other.dist;
  switch (choice){
    case 0: case 1: case 2: case 3: {
      const swim=a.inWater?.45*a.ph.swim:1;
      const sp=(.7+a.traits.speed*1.7)*a.ph.speed*(a.ph.sprint&&a.energy>60?1.2:1)*swim/(1+load(a)/(capacity(a)*1.2));
      a.vx=a.vx*.35+DX[choice]*sp*.65; a.vy=a.vy*.35+DY[choice]*sp*.65; a.energy-=.008*sp*(a.inWater?2.5/a.ph.swim:1); moved=true; break;
    }
    case A_.HARVEST: {
      let best=null, bd=16;
      for (let t=0;t<3;t++){ const q=nearestIn(GRIDS[t],a,16,_h); if (q.obj&&q.dist<bd){ bd=q.dist; best=q.obj; } }
      if (best && load(a)+1<=capacity(a)){
        const k=best.t===1?'wood':best.type; a.inv[k]++; if (best.t>0&&a.tool>0&&load(a)+1.5<=capacity(a)){ a.inv[k]++; a.tool--; }
        best.dead=true; ok=true; a.success++;
      }
      break;
    }
    case A_.EAT:
      if (a.inv.food>0&&a.energy<a.ph.maxE-30){ a.inv.food--; a.energy+=30*a.ph.food; a.drv.thirst=Math.max(0,a.drv.thirst-.12); ok=true; }
      else if (insideNow&&insideNow.stock.food>0&&a.energy<a.ph.maxE-30){ insideNow.stock.food--; if (insideNow.owner===a.id) a.stash=Math.max(0,a.stash-1); else hostGrace(a,insideNow,.5+a.drv.hunger); a.energy+=30*a.ph.food; a.drv.thirst=Math.max(0,a.drv.thirst-.12); ok=true; }
      break;
    case A_.DEPOSIT:
      if (insideNow){ let n=0; for (const k of ['food','wood','stone']) if (a.inv[k]>0){ insideNow.stock[k]+=a.inv[k]; n+=a.inv[k]; a.inv[k]=0; } if (n){ ok=true; a.stash+=insideNow.owner===a.id?n:0; a.deposits+=n; tally.deposits+=n; a.fx|=64; if (insideNow.owner&&insideNow.owner!==a.id){ const ow=byId.get(insideNow.owner); if (ow){ gainTrust(ow,a.id,.04*n); owe(ow,a,.3+.1*n); } } } }
      break;
    case A_.WITHDRAW:
      if (insideNow){ let n=0; for (const k of ['wood','stone','food']) while (insideNow.stock[k]>0&&load(a)+(k==='stone'?2:k==='wood'?1.4:1)<=capacity(a)&&n<4){ insideNow.stock[k]--; a.inv[k]++; n++; } if (n){ ok=true; if (insideNow.owner===a.id) a.stash=Math.max(0,a.stash-n); tally.withdraws+=n; if (insideNow.owner&&insideNow.owner!==a.id){ const ow=byId.get(insideNow.owner); if (ow){ if ((ow.trust.get(a.id)||0)>.3) hostGrace(a,insideNow,.4+.5*a.drv.insecure); else loseTrust(ow,a.id,.2*n/2); } } } }
      break;
    case A_.HOUSE: case A_.STORE: case A_.WALL: case A_.FIRE:
      ok=build(BTYPES[choice-A_.HOUSE],a); break;
    case A_.REPAIR: {
      const b=nearestList(buildings,a,17,_r,isDamaged).obj;
      if (b&&a.inv.wood>=1&&(b.type==='fire'||a.inv.stone>=1)){ a.inv.wood--; if (b.type!=='fire') a.inv.stone--; b.hp=Math.min(b.max,b.hp+110); ok=true; if (b.owner&&b.owner!==a.id){ const ow=byId.get(b.owner); if (ow){ gainTrust(ow,a.id,.06); owe(ow,a,.5); } } }
      break;
    }
    case A_.SHARE:
      if (o&&od<16){
        // give food to a hungry yip, otherwise the material it is shortest on
        let k=null;
        if (a.inv.food>0&&(o.drv.hunger>.2||o.inv.food===0)) k='food';
        else if (a.inv.wood>0&&o.inv.wood<a.inv.wood) k='wood';
        else if (a.inv.stone>0&&o.inv.stone<a.inv.stone) k='stone';
        else if (a.inv.food>0) k='food';
        const wt=k==='stone'?2:k==='wood'?1.4:1;
        if (k&&load(o)+wt<=capacity(o)){
          a.inv[k]--; o.inv[k]++;
          const value=k==='food'?.4+o.drv.hunger:.3+.5*o.drv.insecure;
          gainTrust(o,a.id,.15*value+.05); gainTrust(a,o.id,.03); owe(o,a,value); witnessGood(a,o,.02);
          ok=true; a.shared++; tally.shares++; if (k!=='food') tally.gifts++; a.fx|=1;
        }
      }
      break;
    case A_.ATTACK:
      if (o&&od<14){
        const dmg=3*a.traits.strength*a.ph.dmg*o.ph.armor*(a.tool>0?2.2:1)*(o.sheltered?.3:1)*(.6+.4*a.traits.aggression);
        o.health-=dmg; o.pain=1; o.harm='attack';
        // fights hurt both sides: the target strikes back in proportion to its own strength
        const recoil=2.5*o.traits.strength*o.ph.dmg*a.ph.armor*(o.tool>0?1.5:1)*(.5+Math.random()); a.health-=recoil; a.pain=Math.max(a.pain,.6); if (a.health<=0) a.harm='attack'; a.energy-=.8+.5*a.traits.aggression; a.attacks++; tally.attacks++; a.fx|=2; o.fx|=32;
        if (a.tool>0) a.tool--;
        loseTrust(o,a.id,.6); loseTrust(a,o.id,.15); witness(a,o,.15);
        if (o.inv.food>0&&a.traits.strength>o.traits.strength*.8&&load(a)+1<=capacity(a)){ o.inv.food--; a.inv.food++; a.stolen++; tally.thefts++; loseTrust(o,a.id,.3); witness(a,o,.1); }
        ok=true;
        if (o.health<=0) a.kills++;
      }
      break;
    case A_.HUNT: {
      const z=nearestList(beasts,a,16,_z).obj;
      if (z){
        const dmg=5*a.traits.strength*a.ph.dmg*(a.tool>0?2.2:1)*(.7+.3*a.traits.aggression);
        const prey=z.target&&z.target!==a&&!z.target.dead?z.target:null;
        if (prey){ gainTrust(prey,a.id,.1); owe(prey,a,.6+prey.drv.injury); }
        witnessGood(a,prey,.015);
        z.hp-=dmg; z.target=a; a.energy-=1; a.hunts++; tally.hunts++; a.fx|=4; if (a.tool>0) a.tool--;
        ok=true;
        if (z.hp<=0){ a.beastKills++; tally.beastKills++; log(`${a.name} slew a beast`,'beast'); }
      }
      break;
    }
    case A_.CRAFT:
      if (a.tool<=0&&a.inv.wood>=1&&a.inv.stone>=1){ a.inv.wood--; a.inv.stone--; a.tool=40; a.crafts++; tally.crafts++; ok=true; a.fx|=8; }
      break;
    case A_.DRINK: {
      // drinking works in the water or right at its edge
      const v=waterVec(a.x,a.y,_wv);
      if (a.inWater||v.d<FC*.9){ a.drv.thirst=Math.max(0,a.drv.thirst-.35); ok=true; }
      break;
    }
    case A_.THANK:
      if (o&&od<22){ thank(a,o); ok=true; }
      break;
    case A_.BEFRIEND:
      // a deliberate choice to trust the nearest yip a little more; steps shrink as trust grows
      if (o&&od<30){ gainTrust(a,o.id,.06); ok=true; tally.befriends++; }
      break;
    default:
      if (insideNow){ const yip=insideNow.type==='house'; a.energy+=(yip?.24:.12)*a.ph.rest; a.health=Math.min(a.ph.maxH,a.health+(yip?.12:.05)*a.traits.regen); ok=yip; }
      else { a.energy+=(nearestList(fires,a,18,_f2).obj?.05:.02)*a.ph.rest; }
  }
  if (!moved){ a.vx*=.5; a.vy*=.5; }
  if (a.vx*a.vx+a.vy*a.vy>.0004){
    const nx=wrapX(a.x+a.vx), ny=wrapY(a.y+a.vy);
    if (wallBlocks(nx,ny,3.5)){ a.vx=a.vy=0; } else { a.x=nx; a.y=ny; }
    if (moved) a.hd=Math.atan2(a.vy,a.vx);
  }
  // curiosity: a successful action that few yips perform earns a bonus that fades the more this yip repeats it
  if (ok&&choice>3){
    const rare=(1/O)/(actFreq[choice]+1/O), n=a.okCounts[choice]++;
    bonus+=a.traits.curiosity*.12*rare/((1+n/6)*(1+n/6));
    okTick[choice]++;
  }
  return bonus;
}

function sendStorm(){ storms.push({x:rnd(0,W),y:rnd(50,H-50),w:rnd(90,170),h:rnd(140,300),vx:rnd(1.1,2.5),vy:rnd(-.1,.1),life:750,max:750}); log('Storm front moving in from the west','storm'); toast('Storm front incoming','storm'); }
function archive(a){
  const score=a.age+a.kids*350+a.builds*60+a.success*2+a.beastKills*200+a.shared*20;
  if (elite.length<24||score>elite[elite.length-1].score){
    elite.push({score,gen:a.gen,id:a.id,name:a.name,traits:{...a.traits},perks:[...a.perks],brain:copyBrain(a.brain)});
    elite.sort((x,y)=>y.score-x.score); if (elite.length>24) elite.length=24;
  }
}
function reseed(){
  const n=150;
  let band=[], bx=0, by=0;
  for (let i=0;i<n;i++){
    if (i%5===0){ for (const p of band) for (const q of band) if (p!==q) setTrust(p,q.id,.3); band=[]; [bx,by]=spawnPoint(fert,1); }
    const src=elite.length?pick(elite):null, x=wrapX(bx+rnd(-25,25)), y=wrapY(by+rnd(-25,25));
    const nb=src?makeAgent(x,y,mutateBrain(src.brain),src.gen+1,null,mutateTraits(src.traits),90,[{id:src.id,name:src.name,gen:src.gen,hue:src.traits.hue}],mutatePerks(src.perks||[])):makeAgent(x,y); agents.push(nb); band.push(nb);
  }
  for (const p of band) for (const q of band) if (p!==q) setTrust(p,q.id,.3);
  log(`Extinction. ${n} colonists reseeded from ${elite.length?elite.length+' archived genomes':'scratch'}`,'death');
  toast('Extinction: colony reseeded from the archive','death',true);
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
    b.hp-=settings.decay*(b.type==='fire'?.6:b.type==='wall'?.09:.045); b.life-=settings.decay;
    if (b.stock.food&&Math.random()<.0004*b.stock.food*settings.decay/prot) b.stock.food--;
    if (b.hp<=0||b.life<=0){ buildings.splice(i,1); if (b.type==='store'&&b.stock.food+b.stock.wood+b.stock.stone>0) for (const k of ['food','wood','stone']) for (let n=0;n<Math.min(6,b.stock[k]);n++) addItem(k==='wood'?'tree':k,b.x+rnd(-10,10),b.y+rnd(-10,10)); }
  }
  for (let i=storms.length-1;i>=0;i--){ const s=storms[i]; s.x=wrapX(s.x+s.vx); s.y=wrapY(s.y+s.vy); s.life--; if (s.life<=0) storms.splice(i,1); }
  if (ticks%1500===0&&Math.random()<.7) sendStorm();

  clearGrid(gFood); clearGrid(gTree); clearGrid(gStone); clearGrid(gAgent);
  for (const it of items) GRIDS[it.t][cellOf(it.x,it.y)].push(it);
  for (const a of agents) gAgent[cellOf(a.x,a.y)].push(a);
  fires=[]; shelters=[]; walls=[];
  for (const b of buildings){ if (b.type==='fire') fires.push(b); else if (b.type==='wall') walls.push(b); else shelters.push(b); }
  ownVal=new Map(); for (const b of buildings) if (b.owner) ownVal.set(b.owner,(ownVal.get(b.owner)||0)+buildValue(b));
  byId=new Map(); for (const a of agents){ a.fx=0; byId.set(a.id,a); }
  tickBeasts();

  const newborn=[], cap=settings.popCap, drainK=.085*settings.drain; let dead=0;
  for (const a of agents){
    if (a.dead) continue;
    a.age++; a.pain*=.9;
    a._t=tempAt(a);
    sense(a);
    const temp=forward(a);
    const preDrv=a.drv.cold, choice=a.lastChoice, bonus=act(a,choice,env);
    const sheltered=inside(a), storm=stormAt(a), lt=tempAt(a), ph=a.ph, cold=Math.max(0,ph.coldT-lt), hot=Math.max(0,lt-ph.hotT), thermal=(cold+hot)/(16*a.traits.thermal); a._t=lt;
    a.sheltered=!!sheltered; a.inWater=isWater(a.x,a.y);
    a.energy-=drainK*ph.baseMetab*ph.metab*(ph.hib&&lt<10?.7:1)+a.brainCost+thermal*(sheltered?.006:.045);
    if (a.energy>40||ph.regen>.02) a.health=Math.min(ph.maxH,a.health+ph.regen);
    if (storm&&!sheltered){ const wb=nearestWall(a,12)<12?.4:1; a.health-=.15*settings.storm*wb; a.energy-=.12*settings.storm*wb; a.harm='storm'; }
    for (const b of fires){ const dx=wd(a.x-b.x,W), dy=wd(a.y-b.y,H); if (dx*dx+dy*dy<(b.r+2)*(b.r+2)){ a.health-=.4; a.energy-=.1; a.harm='fire'; } }
    if (a.inWater){ a.energy-=.015/a.ph.swim; if (a.energy<6){ a.health-=.8; a.harm="drowning"; } }
    if (a.drv.thirst>=1){ a.health-=.08; a.harm='thirst'; }
    if (a.energy<0){ a.health+=a.energy*.08; a.energy=0; a.harm='hunger'; }
    if (a.energy>ph.maxE) a.energy=ph.maxE;
    if (a.inv.food&&Math.random()<.0012*a.inv.food) a.inv.food--;   // carried food spoils; stores keep it better
    a.memory=clamp(.96*a.memory+.04*(a.energy/100-1),-1,1);
    a.prevHealth=a.health; a.shareHeat*=.99;
    const resting=choice===A_.REST, exert=(choice===A_.ATTACK||choice===A_.HUNT)?.003:0;
    updateDrives(a,lt,choice<4,exert,resting?(sheltered&&sheltered.type==='house'?.014:.006)*a.traits.rest:0);
    if (a.drv.fatigue>.8) a.vx*=.8, a.vy*=.8;
    // gratitude for warmth and shelter that someone else provided
    if (preDrv-a.drv.cold>.004){
      if (sheltered&&sheltered.owner&&sheltered.owner!==a.id) hostGrace(a,sheltered,.6+preDrv);
      else { const f=nearestList(fires,a,65,_fw).obj; if (f&&f.owner&&f.owner!==a.id){ const ow=byId.get(f.owner); if (ow){ gainTrust(a,ow.id,.006); owe(a,ow,.02+.1*preDrv); } } }
    }
    if (resting&&sheltered&&sheltered.owner&&sheltered.owner!==a.id&&a.drv.fatigue>.3&&Math.random()<.05) hostGrace(a,sheltered,.4+a.drv.fatigue);
    if ((a.id+ticks)%6===0) socialTick(a);
    const phi=wellbeing(a), reward=(phi-a.phi+bonus)*REWARD_SCALE; a.phi=phi; a.lastReward=.9*(a.lastReward||0)+.1*reward; a.lastBonus=bonus;
    if (settings.learning) learn(a,reward,temp);
    if (a.energy>60&&a.age>150&&ticks-a.lastBirth>200) mateSc[cellIdx(a.x,a.y)]+=1;   // ready to breed: gives off mating scent
    // birth takes two: well-fed, unrelated yips close together who trust each other. Popular yips find it easier.
    const pop=Math.min(1.5,Math.max(0,repOf(a.id))/4);
    if (a.energy>75-15*pop&&a.age>150&&ticks-a.lastBirth>200&&Math.random()<.04*(1+pop)&&agents.length+newborn.length<cap&&(a.id+ticks)%2===0){
      const mate=findMate(a,.12-.05*pop);
      if (mate){
      a.energy-=30; mate.energy-=30; a.lastBirth=mate.lastBirth=ticks;
      const c=child(a,mate); newborn.push(c); births++;
      updateDrives(a,lt,false,0,0); a.phi=wellbeing(a);
      if (c.gen>=lastMilestone+10){ lastMilestone=c.gen-c.gen%10; toast(`Generation ${lastMilestone} reached`,'birth'); log(`Generation ${lastMilestone} reached`,'birth'); }
      }
    }
    if (a.health<=0||a.age>a.lifespan){ onDeath(a); a.dead=true; dead++; deaths++; deathsBy[a.age>a.lifespan?'age':a.harm]=(deathsBy[a.age>a.lifespan?'age':a.harm]||0)+1; dropInventory(a); archive(a); }
  }
  updateActFreq();
  if (dead) agents=agents.filter(a=>!a.dead);
  for (const c of newborn) agents.push(c);
  for (const c of pendingBirths) agents.push(c); pendingBirths=[];
  if (agents.length>peakPop) peakPop=agents.length;
  if (!agents.length&&settings.autoReseed) reseed();
  // scent fades every tick and spreads to neighbouring cells every 8 ticks (wrapping)
  for (let i=0;i<pher.length;i++){ pher[i]*=.993; mateSc[i]*=.985; }
  if (ticks%4===0){ for (let y=0;y<FH;y++) for (let x=0;x<FW;x++){ const i=x+y*FW, l=((x+FW-1)%FW)+y*FW, r=((x+1)%FW)+y*FW, u=x+((y+FH-1)%FH)*FW, d=x+((y+1)%FH)*FW; mateTmp[i]=mateSc[i]*.5+(mateSc[l]+mateSc[r]+mateSc[u]+mateSc[d])*.125; } const t=mateSc; mateSc=mateTmp; mateTmp=t; }
  if (ticks%8===0){ for (let y=0;y<FH;y++) for (let x=0;x<FW;x++){ const i=x+y*FW, l=((x+FW-1)%FW)+y*FW, r=((x+1)%FW)+y*FW, u=x+((y+FH-1)%FH)*FW, d=x+((y+1)%FH)*FW; pherTmp[i]=pher[i]*.6+(pher[l]+pher[r]+pher[u]+pher[d])*.1; } const t=pher; pher=pherTmp; pherTmp=t; }
  if (ticks%25===0) pushHistory();
}
function avg(f){ if (!agents.length) return 0; let s=0; for (const a of agents) s+=f(a); return s/agents.length; }
let lastTally={...tally};
function pushHistory(){
  let food=0; for (const it of items) if (!it.dead&&it.t===0) food++;
  let stocked=0; for (const b of buildings) stocked+=b.stock.food;
  const d={}; for (const k in tally){ d[k]=tally[k]-(lastTally[k]||0); } lastTally={...tally};
  history.push({t:ticks,pop:agents.length,rep:avg(a=>Math.max(0,repOf(a.id))),lonely:avg(a=>a.drv.lonely),food,build:buildings.length,beasts:beasts.length,stocked,gen:avg(a=>a.gen),str:avg(a=>a.traits.strength),spd:avg(a=>a.traits.speed),sense:avg(a=>a.traits.sense),agg:avg(a=>a.traits.aggression),
    neurons:avg(a=>a.brain.sizes.reduce((s,n)=>s+n,0)),tools:avg(a=>a.tool>0?1:0),births,deaths,...d});
  if (history.length>600){ // keep long runs readable: thin the older half
    const half=history.length>>1, old=history.slice(0,half).filter((_,i)=>i%2===0); history=old.concat(history.slice(half));
  }
}

function reset(newShape){
  if (newShape) setSize(newShape);
  seed=(Math.random()*2**31)|0; makeFields(seed);
  agents=[]; items=[]; buildings=[]; storms=[]; beasts=[]; events=[]; history=[]; elite=[]; repMap.clear();
  ticks=0; nextId=1; nextBid=1; births=0; deaths=0; maxGen=0; peakPop=0; lastMilestone=0;
  deathsBy={age:0,hunger:0,thirst:0,drowning:0,storm:0,fire:0,beast:0,attack:0}; for (const k in tally) tally[k]=0; lastTally={...tally};
  // founders arrive in bands of five who already trust each other a little
  for (let b=0;b<60;b++){ const [bx,by]=spawnPoint(fert,1), band=[];
    for (let i=0;i<5;i++){ let x=wrapX(bx+rnd(-25,25)), y=wrapY(by+rnd(-25,25)); if (isWater(x,y)){ x=bx; y=by; } const a=makeAgent(x,y); band.push(a); agents.push(a); }
    for (const a of band) for (const o of band) if (a!==o) setTrust(a,o.id,.3); }
  for (let i=0;i<1100;i++) addItem('food'); for (let i=0;i<420;i++) addItem('tree'); for (let i=0;i<320;i++) addItem('stone');
  for (let i=0;i<settings.beasts;i++) spawnBeast();
  selected=0; log('300 founders released in 60 bands. Fertile valleys, forests and rocky ground are spread across the map.','birth');
  postMeta();
}

// ---------- serialization ----------
const r4 = v => Math.round(v*1e4)/1e4, r2 = v => Math.round(v*100)/100;
const serBrain = b => ({inputs:b.inputs,sizes:b.sizes,w:b.w.map(f=>Array.from(f,r4))});
const AGENT_KEYS=['name','gen','parent','lineage','traits','perks','stash','thanksGot','lovesGot','coparent','partners','age','lifespan','inv','tool','builds','success','kids','shared','stolen','attacks','kills','hunts','beastKills','crafts','deposits'];
function serialize(){
  return {version:12,shape,seed,ticks,nextId,nextBid,births,deaths,deathsBy,tally,maxGen,peakPop,selected,settings:{...settings},
    agents:agents.map(a=>{ const o={drv:a.drv,owed:[...a.owed],id:a.id,x:r2(a.x),y:r2(a.y),hd:r2(a.hd),energy:r2(a.energy),health:r2(a.health),memory:r4(a.memory),memA:r4(a.memA),memB:r4(a.memB),baseline:r4(a.baseline),
      trust:[...a.trust].map(([k,v])=>[k,r4(v)]),actionCounts:Array.from(a.actionCounts),brain:serBrain(a.brain),learned:a.learned.map(f=>Array.from(f,r4))}; for (const k of AGENT_KEYS) o[k]=a[k]; return o; }),
    items:items.filter(i=>!i.dead).map(i=>[i.t,r2(i.x),r2(i.y),i.life|0,i.max|0]),
    buildings:buildings.map(b=>({...b,hp:r2(b.hp)})),storms,beasts:beasts.map(z=>({...z,target:null})),events,history,elite:elite.map(e=>({...e,brain:serBrain(e.brain)}))};
}
// Older brains had fewer outputs. Map each old discrete action and continuous output onto its new row; new rows start small.
const OLD_LAYOUTS={14:{disc:[0,1,2,3,4,5,6,8,9,10,11,12,13,17],cont:0},21:{disc:[...Array(18).keys()],cont:3},24:{disc:[...Array(20).keys()],cont:4}};
function upgradeBrain(b){
  const L=b.sizes.length-1, cols=b.sizes[L-1], old=b.w[L-1], rowsOld=b.sizes[L];
  b.inputs=b.inputs.map(k=>k==='memory'?'trend':k);
  if (rowsOld===NOUT) return b;
  const f=randArr(NOUT*cols,.3), lay=OLD_LAYOUTS[rowsOld];
  if (lay){ lay.disc.forEach((to,j)=>f.set(old.subarray(j*cols,(j+1)*cols),to*cols)); for (let c=0;c<lay.cont;c++){ const j=lay.disc.length+c; f.set(old.subarray(j*cols,(j+1)*cols),(O+c)*cols); } }
  b.w[L-1]=f; b.sizes[L]=NOUT; return b;
}
const deBrain = b => upgradeBrain(b.weights ? fromNested(b) : {inputs:b.inputs,sizes:b.sizes,w:b.w.map(x=>Float32Array.from(x))});
function deserialize(s){
  if (!s||!Array.isArray(s.agents)||![6,10,11,12].includes(s.version)) throw Error('Not an ALife Lab save (expected version 0.6 to 1.5)');
  const legacy=s.version<11, old=s.version<12; setSize();
  const ow=s.version===6||s.version===10?840:s.shape==='tall'?600:s.shape==='square'?780:960, oh=s.version===6||s.version===10?520:s.shape==='tall'?960:s.shape==='square'?780:600;
  const sx=old?W/ow:1, sy=old?H/oh:1, reg=s.registry||{};
  seed=s.seed||12345; makeFields(seed);
  const A=s.agents.map(o=>{
    const brain=deBrain(o.brain);
    const a=makeAgent(o.x*sx,o.y*sy,brain,o.gen||0,o.parent??null,{...freshTraits(),...o.traits},o.energy,[],o.perks||[]);
    a.id=o.id;
    for (const k of AGENT_KEYS) if (o[k]!==undefined&&k!=='traits'&&k!=='gen'&&k!=='parent') a[k]=o[k];
    Object.assign(a,{health:o.health,prevHealth:o.health,memory:o.memory||0,memA:o.memA||0,memB:o.memB||0,baseline:o.baseline||0,hd:o.hd||0,lifespan:o.lifespan||rnd(3600,5100),inv:o.inv||{food:0,wood:0,stone:0}});
    a.trust=new Map(Array.isArray(o.trust)?o.trust:Object.entries(o.trust||{}).map(([k,v])=>[+k,v])); a.owed=new Map(o.owed||[]);
    if (o.actionCounts&&o.actionCounts.length===O) a.actionCounts=Uint32Array.from(o.actionCounts);
    if (o.learned&&!old){ a.learned=o.learned.map(x=>Float32Array.from(x)); a.eff=a.brain.w.map((w,l)=>{ const e=new Float32Array(w.length), d=a.learned[l]; for (let i=0;i<w.length;i++) e[i]=w[i]+(d[i]||0); return e; }); }
    derive(a); if (o.drv) Object.assign(a.drv,o.drv); a.inWater=isWater(a.x,a.y); a.phi=wellbeing(a);
    if (!o.lineage){ const ch=[]; let id=o.parent; for (let i=0;i<12&&id&&reg[id];i++){ ch.push({id,gen:reg[id].gen,hue:0}); id=reg[id].parent; } a.lineage=ch; }
    return a;
  });
  agents=A; repMap.clear(); for (const a of A) for (const [k,v] of a.trust) repMap.set(k,repOf(k)+v);
  ticks=s.ticks||0; nextId=Math.max(s.nextId||1,...A.map(a=>a.id+1)); births=s.births||0; deaths=s.deaths||0;
  deathsBy={age:0,hunger:0,storm:0,fire:0,beast:0,attack:0,...(s.deathsBy||{})}; Object.assign(tally,s.tally||{}); lastTally={...tally};
  maxGen=s.maxGen||Math.max(0,...A.map(a=>a.gen)); peakPop=s.peakPop||A.length;
  items=(s.items||[]).map(i=>Array.isArray(i)?{t:i[0],type:ITYPES[i[0]],x:i[1]*sx,y:i[2]*sy,life:i[3],max:i[4]||i[3],dead:false}:{t:ITYPES.indexOf(i.type),type:i.type,x:i.x*sx,y:i.y*sy,life:i.life,max:i.life,dead:false});
  nextBid=1;
  buildings=(s.buildings||[]).filter(b=>!isWater(b.x*sx,b.y*sy)).map(b=>{ const ang=b.ang||0; return {...b,x:b.x*sx,y:b.y*sy,r:b.type==='wall'?SPECS.wall.r:b.r,id:b.id||nextBid++,ang,c:Math.cos(ang),s:Math.sin(ang),max_life:b.max_life||(b.type==='fire'?600:10000)}; });
  nextBid=Math.max(nextBid,...buildings.map(b=>b.id+1),1);
  storms=(s.storms||[]).map(x=>({max:650,...x})); beasts=(s.beasts||[]).map(z=>({...z,target:null}));
  events=(s.events||[]).map(e=>typeof e==='string'?{t:0,s:e,kind:'info'}:e); history=Array.isArray(s.history)&&!old?s.history:[];
  elite=(s.elite||[]).map(e=>({...e,brain:deBrain(e.brain)}));
  Object.assign(settings,s.settings||{}); selected=s.selected||0; lastMilestone=maxGen-maxGen%10;
  log(old?'Older snapshot loaded and moved onto the new 1.5 world':'Snapshot loaded','info');
  postMeta();
}

// ---------- reporting ----------
let sendPher=false, started=false, running=true, speed=3, maxMode=false, last=performance.now(), acc=0, stepsWin=0, tps=0, lastMetrics=last, lastFrame=0, lastStats=0, lastInspect=0, inspecting=false;
function postMeta(){ self.postMessage({type:'meta',water,drives:DRIVES,bounds:TB,perks:PERKS,clash:CLASH,phys:PHYS,ment:MENT,traitInfo:TRAIT_INFO,senses:SENSES,actions:ACTIONS,short:SHORT,cont:CONT,W,H,FW,FH,FC,shape,settings,fert,forest,rock,seed}); }
function postFrame(){
  const na=agents.length, A=new Float32Array(na*10);
  for (let i=0,o=0;i<na;i++,o+=10){ const a=agents[i]; A[o]=a.id; A[o+1]=a.x; A[o+2]=a.y; A[o+3]=a.traits.hue; A[o+4]=a.hd; A[o+5]=a.energy/200; A[o+6]=a.health/100;
    A[o+7]=(a.sheltered?1:0)|(a.inv.food+a.inv.wood+a.inv.stone>0?2:0)|(a.tool>0?4:0)|(repOf(a.id)>3?8:0)|(a.inWater?16:0); A[o+8]=a._r||a.ph.sense; A[o+9]=a.fx; }
  let ni=0; for (const it of items) if (!it.dead) ni++;
  const I=new Float32Array(ni*4); let o=0;
  for (const it of items){ if (it.dead) continue; I[o]=it.t; I[o+1]=it.x; I[o+2]=it.y; I[o+3]=it.life/it.max; o+=4; }
  const nb=buildings.length, B=new Float32Array(nb*9);
  for (let i=0,p=0;i<nb;i++,p+=9){ const b=buildings[i]; B[p]=BTYPES.indexOf(b.type); B[p+1]=b.x; B[p+2]=b.y; B[p+3]=b.r; B[p+4]=b.hp/b.max; B[p+5]=b.id; B[p+6]=b.stock.food+b.stock.wood+b.stock.stone; B[p+7]=b.life/(b.max_life||10000); B[p+8]=b.ang||0; }
  const S=new Float32Array(storms.length*5);
  storms.forEach((s,i)=>{ S[i*5]=s.x; S[i*5+1]=s.y; S[i*5+2]=s.w; S[i*5+3]=s.h; S[i*5+4]=s.life/(s.max||650); });
  const Z=new Float32Array(beasts.length*6);
  beasts.forEach((z,i)=>{ Z[i*6]=z.id; Z[i*6+1]=z.x; Z[i*6+2]=z.y; Z[i*6+3]=z.hd; Z[i*6+4]=z.hp/z.max; Z[i*6+5]=z.target?1:0; });
  const P=sendPher?Uint8Array.from(pher,v=>Math.min(255,v*40)):null; sendPher=false;
  self.postMessage({type:'frame',P,ticks,tps,running,maxMode,temp:baseTemp,day:settings.day,season:settings.season,A,I,B,S,Z},[A.buffer,I.buffer,B.buffer,S.buffer,Z.buffer]);
}
function postStats(withHistory){
  const n=agents.length||1, sensUse={}, act=new Float64Array(O), byType={house:0,store:0,wall:0,fire:0};
  let layers=0, neurons=0, inputs=0, tools=0, stocked=0;
  for (const a of agents){ for (const k of a.brain.inputs) sensUse[k]=(sensUse[k]||0)+1; let tot=0; for (let i=0;i<O;i++) tot+=a.actionCounts[i]; if (tot) for (let i=0;i<O;i++) act[i]+=a.actionCounts[i]/tot; layers+=a.brain.sizes.length-2; for (let l=1;l<a.brain.sizes.length-1;l++) neurons+=a.brain.sizes[l]; inputs+=a.brain.inputs.length; if (a.tool>0) tools++; }
  for (const b of buildings){ byType[b.type]++; stocked+=b.stock.food; }
  const counts=[0,0,0]; for (const it of items) if (!it.dead) counts[it.t]++;
  const t=k=>avg(a=>a.traits[k]);
  const names={}; for (const a of agents) names[a.id]=a.name;
  self.postMessage({type:'stats',names,ticks,pop:agents.length,peakPop,births,deaths,deathsBy,tally,maxGen,avgGen:avg(a=>a.gen),byType,counts,temp:baseTemp,beasts:beasts.length,tools,stocked,
    traits:Object.fromEntries([...PHYS,...MENT].map(k=>[k,t(k)])),perkUse:PERKS.map(p=>[p.id,agents.filter(a=>a.perks.includes(p.id)).length/n]),
    brain:{layers:layers/n,neurons:neurons/n,inputs:inputs/n},sensUse:Object.entries(sensUse).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k,v/n]),
    actMix:Array.from(act,v=>v/n),events,eliteTop:elite.slice(0,6).map(e=>({id:e.id,name:e.name||('#'+e.id),gen:e.gen,score:e.score|0,hue:e.traits.hue})),history:withHistory?history:null,settings});
}
function postInspect(){
  const a=agents.find(x=>x.id===selected);
  if (!a){ self.postMessage({type:'inspect',none:true,id:selected,grave:graveNames.get(selected)||null}); return; }
  const alive=new Set(agents.map(x=>x.id)), b=a.brain;
  const ws=b.w.map((f,l)=>{ const d=a.learned[l], o=new Float32Array(f.length); for (let i=0;i<f.length;i++) o[i]=f[i]+d[i]; return o; });
  const kids=agents.filter(x=>x.parent===a.id).map(x=>({id:x.id,name:x.name,hue:x.traits.hue,age:x.age}));
  const nm=id=>{ const o=byId.get(id); return o?o.name:null; };
  self.postMessage({type:'inspect',name:a.name,coparentName:nm(a.coparent),parentName:nm(a.parent),id:a.id,gen:a.gen,age:a.age,lifespan:a.lifespan,energy:a.energy,health:a.health,x:a.x,y:a.y,traits:a.traits,inv:a.inv,tool:a.tool,load:load(a),cap:capacity(a),
    builds:a.builds,success:a.success,kids:a.kids,livingKids:kids,sheltered:a.sheltered,temp:a._t,lastChoice:a.lastChoice,probs:Array.from(a.probs),inputs:b.inputs,sizes:b.sizes,ws,
    acts:a.acts.map(x=>Array.from(x)),trust:[...a.trust].sort((x,y)=>Math.abs(y[1])-Math.abs(x[1])).slice(0,10).map(([id,v])=>({id,v,name:nm(id),alive:alive.has(id)})),
    trustedBy:agents.filter(x=>(x.trust.get(a.id)||0)>.3).map(x=>({id:x.id,name:x.name,v:x.trust.get(a.id),hue:x.traits.hue})).sort((p,q)=>q.v-p.v).slice(0,12),coparentAlive:alive.has(a.coparent),
    lineage:a.lineage.map(l=>({...l,alive:alive.has(l.id)})),lastBirth:a.lastBirth,parent:a.parent,cost:traitCost(a.traits,a.perks),metab:a.ph.baseMetab*a.ph.metab,perks:a.perks,ph:{maxE:a.ph.maxE,maxH:a.ph.maxH,speed:a.ph.speed,dmg:a.ph.dmg,armor:a.ph.armor,coldT:a.ph.coldT,hotT:a.ph.hotT,sense:a.ph.sense},brainCost:a.brainCost,
    deeds:{shared:a.shared,stolen:a.stolen,attacks:a.attacks,kills:a.kills,hunts:a.hunts,beastKills:a.beastKills,crafts:a.crafts,deposits:a.deposits,builds:a.builds},
    actionCounts:Array.from(a.actionCounts),owed:[...a.owed].sort((x,y)=>y[1]-x[1]).slice(0,6).map(([id,v])=>[nm(id)||('#'+id),v]),inWater:a.inWater,drv:a.drv,rep:repOf(a.id),admirers:agents.filter(x=>(x.trust.get(a.id)||0)>.5).length,thanksGot:a.thanksGot,lovesGot:a.lovesGot,coparent:a.coparent,partners:a.partners,wellbeing:a.phi,rewardAvg:a.lastReward||0,curiosityGain:a.lastBonus||0,memory:a.memory,memA:a.memA,memB:a.memB,signal:a.signal,pain:a.pain});
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
  if (now-lastStats>=700){ postStats(true); lastStats=now; sendPher=true; }
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
  else if (how==='popular') a=best(x=>repOf(x.id));
  else if (how==='child'&&cur){ const k=agents.filter(x=>x.parent===cur.id); if (k.length) a=pick(k); else toast('No living children yet','info'); }
  else if (how==='parent'&&cur){ a=agents.find(x=>x.id===cur.parent)||null; if (!a) toast('Parent is no longer alive','info'); }
  if (a){ selected=a.id; self.postMessage({type:'selected',name:a.name,id:a.id,x:a.x,y:a.y}); postInspect(); }
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
      if (k==='erase'){ for (const it of items) if (wdistXY(it.x,it.y,x,y)<=r) it.dead=true; buildings=buildings.filter(b=>wdistXY(b.x,b.y,x,y)>r); beasts=beasts.filter(z=>wdistXY(z.x,z.y,x,y)>r); }
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
