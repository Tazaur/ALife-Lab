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
const ACTIONS = ['Move north','Move east','Move south','Move west','Harvest','Eat','Deposit in store','Withdraw from store','Build house','Build storehouse','Build wall','Build fire','Repair','Share food','Attack yip','Fight beast','Craft tool','Rest','Drink','Show affection','Befriend nearest yip','Eat meat','Plant seeds','Speak','Mate with nearest yip'];
const SHORT   = ['N','E','S','W','Harvest','Eat','Deposit','Withdraw','House','Store','Wall','Fire','Repair','Share','Attack','Hunt','Craft','Rest','Drink','Affection','Befriend','Meat','Plant','Speak','Mate'];
const O = ACTIONS.length;            // discrete, softmax-sampled
const CONT = ['Voice','Memory A','Memory B','Scent'];   // continuous tanh outputs
// A small alphabet of vocal symbols. Nothing gives them meaning: a yip that speaks picks one (its brain's choice), and
// symbols spoken in quick succession chain into a word of up to four. Loud enough and it's a shout (!), heard much farther.
const SYMS = ['ᛝ','ᛟ','ᚷ','Ϟ','Ϡ','Ѫ','Ҩ','ᘛ','ᖶ','ᔑ','ᓬ'], NSYM = SYMS.length;
const SYM0 = O + CONT.length, VOL = SYM0 + NSYM;     // output rows: which symbol, then how loud
const NOUT = VOL + 1;
// Hearing is a sensitivity: a sound is heard out to (listener's hearing range × the sound's loudness).
// Normal speech is quiet, a shout is loud, so a shout reaches yips that could never hear the same word spoken.
const SPEAK_L = .45, SHOUT_L = 1.7;
const NOISE_L = [.5, 1, 1.3, 1.6, .8];   // talk, fight, beast, death cry, work
const A_ = Object.fromEntries(['N','E','S','W','HARVEST','EAT','DEPOSIT','WITHDRAW','HOUSE','STORE','WALL','FIRE','REPAIR','SHARE','ATTACK','HUNT','CRAFT','REST','DRINK','THANK','BEFRIEND','EATMEAT','PLANT','SPEAK','MATE'].map((k,i)=>[k,i]));
const ITYPES = ['food','tree','stone','carcass'];
const BTYPES = ['house','store','wall','fire'];
const SPECS = {house:{wood:3,stone:1,hp:450,r:16},store:{wood:5,stone:4,hp:720,r:23},wall:{wood:2,stone:1,hp:420,r:15},fire:{wood:2,stone:0,hp:180,r:12}};
const LIMITS = {layers:6, neurons:24, inputs:32};
const DX = [0,1,0,-1], DY = [-1,0,1,0];
const settings = {worldEnergy:450000,disease:1,food:7.5,trees:.3,stone:.2,drain:1,decay:1,storm:1,temperature:19,day:500,season:2600,beasts:6,beastPower:1,popCap:1200,migrateEvery:3000,migrants:4,mutation:1,learning:true,autoReseed:true};

// ---------- query masks ----------
const Q = {FRIEND:1024,FOOD:1,TREE:2,STONE:4,SHELTER:8,FIRE:16,STORM:32,OTHER:64,PRED:128,CROWD:256,WALL:512,MEAT:2048,SOUND:4096,VOICE:8192};

let agents=[], items=[], buildings=[], storms=[], beasts=[], events=[], history=[], elite=[];
let ticks=0, nextId=1, nextBid=1, births=0, deaths=0, maxGen=0, peakPop=0, selected=0, lastMilestone=0, seed=1;
let deathsBy = {age:0,hunger:0,thirst:0,drowning:0,storm:0,fire:0,beast:0,attack:0,disease:0};
let tally = {words:0,shouts:0,affection:0,conceptions:0,miscarriages:0,infections:0,plantings:0,meals:0,cannibal:0,loveBirths:0,befriends:0,gifts:0,thanks:0,loves:0,pairings:0,shares:0,thefts:0,attacks:0,hunts:0,beastKills:0,crafts:0,deposits:0,withdraws:0,builds:0};
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
  // each world is an island: open sea (salt water, 2) all round the edges with a ragged coast, fresh lakes (1) inland
  const coast=noiseField(r,4);
  water=new Uint8Array(FW*FH);
  for (let y=0;y<FH;y++) for (let x=0;x<FW;x++){
    const i=x+y*FW, ex=Math.min(x+.5,FW-x-.5)/FW, ey=Math.min(y+.5,FH-y-.5)/FH, edge=Math.min(ex,ey);   // 0 at the border, .5 at the centre
    if (edge<.045+.075*coast[i]) water[i]=2; else if (elev[i]<.2) water[i]=1;
  }
  buildWaterDistance();
  for (let i=0;i<fert.length;i++){
    const near=1-Math.min(1,waterDist[i]/8);
    if (water[i]===2){ fert[i]=0; forest[i]=0; rock[i]=0; continue; }
    fert[i]=water[i]?0:clamp((fert[i]*.7+.45*near)*(1-.55*rock[i]),0,1); forest[i]=water[i]?0:clamp(forest[i]*(1-.6*rock[i]),0,1); rock[i]=water[i]?0:rock[i];
  }
}
// multi-source BFS over the torus: for every cell, the nearest water cell and its distance in cells
let water=new Uint8Array(0), waterDist=new Float32Array(0), waterNear=new Int32Array(0);
function buildWaterDistance(){
  const n=FW*FH; waterDist=new Float32Array(n).fill(1e9); waterNear=new Int32Array(n).fill(-1);
  const q=new Int32Array(n); let h=0, t=0;
  for (let i=0;i<n;i++) if (water[i]===1){ waterDist[i]=0; waterNear[i]=i; q[t++]=i; }
  while (h<t){ const i=q[h++], x=i%FW, y=(i/FW)|0;
    for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ const nx=(x+dx+FW)%FW, ny=(y+dy+FH)%FH, j=nx+ny*FW; if (waterDist[j]>waterDist[i]+1){ waterDist[j]=waterDist[i]+1; waterNear[j]=waterNear[i]; q[t++]=j; } } }
}
const cellIdx = (x,y) => (Math.floor(wrapX(x)/FC)%FW)+(Math.floor(wrapY(y)/FC)%FH)*FW;
const isWater = (x,y) => water[cellIdx(x,y)]>0;
const isSea = (x,y) => water[cellIdx(x,y)]===2;
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
let gFood, gTree, gStone, gMeat, gAgent, gSound, GRIDS;
function setSize(){
  shape='square'; GC=W/CELL; GR=H/CELL; FW=W/FC; FH=H/FC;
  pher=new Float32Array(FW*FH); pherTmp=new Float32Array(FW*FH); mateSc=new Float32Array(FW*FH); mateTmp=new Float32Array(FW*FH);
  miasma=new Float32Array(FW*FH); miaTmp=new Float32Array(FW*FH); nut=new Float32Array(FW*FH);
  gFood=mkGrid(); gTree=mkGrid(); gStone=mkGrid(); gMeat=mkGrid(); gAgent=mkGrid(); gSound=mkGrid(); GRIDS=[gFood,gTree,gStone,gMeat];
}
let pher, pherTmp, mateSc, mateTmp, miasma, miaTmp, nut;
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
const pro = (a,q) => q.obj ? 1-q.dist/Math.max(1,a._r) : 0;
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
  ['urge','Urge to reproduce',0,a=>a.drv.urge],
  ['inWater','Swimming',0,a=>a.inWater?1:0],
  ['atSea','In salt water',0,a=>isSea(a.x,a.y)?1:0],
  ['waterX','Water direction X',0,a=>{ const v=waterVec(a.x,a.y,_wv); return v.d>1?v.dx/v.d:0; }],
  ['waterY','Water direction Y',0,a=>{ const v=waterVec(a.x,a.y,_wv); return v.d>1?v.dy/v.d:0; }],
  ['waterNear','Water proximity',0,a=>{ const v=waterVec(a.x,a.y,_wv); return Math.max(0,1-v.d/a._r); }],
  ['scent','Scent here',0,a=>Math.min(1,pher[cellIdx(a.x,a.y)]*a.ph.smell/4)],
  ['scentX','Scent gradient X',0,a=>smellGrad(pher,a,1,2)],
  ['scentY','Scent gradient Y',0,a=>smellGrad(pher,a,0,2)],
  ['friendX','Most trusted yip direction X',Q.FRIEND,(a,e)=>dir(a,e.friend,'x')],
  ['friendY','Most trusted yip direction Y',Q.FRIEND,(a,e)=>dir(a,e.friend,'y')],
  ['friendNear','Most trusted yip proximity',Q.FRIEND,(a,e)=>pro(a,e.friend)],
  ['mateScent','Mating scent here',0,a=>Math.min(1,mateSc[cellIdx(a.x,a.y)]*a.ph.smell/3)],
  ['mateScentX','Mating scent gradient X',0,a=>smellGrad(mateSc,a,1,1)],
  ['mateScentY','Mating scent gradient Y',0,a=>smellGrad(mateSc,a,0,1)],
  ['disease','Smell of disease here',0,a=>Math.min(1,miasma[cellIdx(a.x,a.y)]*a.ph.smell/2)],
  ['diseaseX','Smell of disease gradient X',0,a=>smellGrad(miasma,a,1,1.5)],
  ['diseaseY','Smell of disease gradient Y',0,a=>smellGrad(miasma,a,0,1.5)],
  ['hurtBy','Nearest yip hurt me recently',Q.OTHER,(a,e)=>e.other.obj&&e.other.obj.id===a.lastHurtBy&&ticks-a.lastHurtAt<600?1:0],
  ['gratitude','Gratitude owed to nearest yip',Q.OTHER,(a,e)=>e.other.obj?Math.min(1,a.owed.get(e.other.obj.id)||0):0],
  ['coldDrive','Feeling cold or hot',0,a=>a.drv.cold],
  ['fatigue','Fatigue',0,a=>a.drv.fatigue],
  ['lonely','Loneliness',0,a=>a.drv.lonely],
  ['insecure','Insecurity (few supplies)',0,a=>a.drv.insecure],
  ['disliked','Yips nearby who dislike me',0,a=>Math.min(1,(a.hostileN||0)/3)],
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
  ['signal','Nearest yip\'s voice',Q.OTHER,(a,e)=>e.other.obj&&e.other.dist<=a.ph.hearing?e.other.obj.signal:0],
  ['chorus','Average voice nearby',Q.CROWD,(a,e)=>a.ph.hearing>=40?e.crowd.sig:0],
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
  ['gut','Food in stomach',0,a=>Math.min(1,a.gut/gutCap(a))],
  ['fat','Body fat',0,a=>Math.min(1,a.fat/150)],
  ['muscle','Muscle condition',0,a=>(a.muscle-.45)/.7],
  ['pregnant','Carrying young',0,a=>a.preg?Math.min(1,a.preg.e/a.preg.need):0],
  ['sick','Feeling sick',0,a=>a.sick],
  ['ownSex','Own body: carries (+) or sires (-) young',0,a=>clamp(a.ph.womb-a.ph.seed,-1,1)],
  ['meatStock','Carried meat',0,a=>a.inv.meat/6],
  ['seedStock','Carried seeds',0,a=>(a.inv.seeds||0)/5],
  ['carcassX','Carcass direction X',Q.MEAT,(a,e)=>dir(a,e.meat,'x')],
  ['carcassY','Carcass direction Y',Q.MEAT,(a,e)=>dir(a,e.meat,'y')],
  ['carcassNear','Carcass proximity',Q.MEAT,(a,e)=>pro(a,e.meat)],
  ['carcassRot','Nearest carcass is rotting',Q.MEAT,(a,e)=>e.meat.obj&&e.meat.obj.age>ROT_AT?1:0],
  ['agentSick','Nearest yip looks sick',Q.OTHER,(a,e)=>e.other.obj?e.other.obj.sick:0],
  ['agentPregnant','Nearest yip is carrying young',Q.OTHER,(a,e)=>e.other.obj&&e.other.obj.preg?1:0],
  ['agentSex','Nearest yip carries (+) or sires (-) young',Q.OTHER,(a,e)=>e.other.obj?clamp(e.other.obj.ph.womb-e.other.obj.ph.seed,-1,1):0],
  ['agentFat','Nearest yip fatness',Q.OTHER,(a,e)=>e.other.obj?Math.min(1,e.other.obj.fat/150):0],
  ['soundNear','Nearest sound proximity',Q.SOUND,(a,e)=>e.hear.n?1-e.hear.d/Math.max(1,a.ph.hearing):0],
  ['soundX','Nearest sound direction X',Q.SOUND,(a,e)=>e.hear.n?e.hear.dx/Math.max(1,e.hear.d):0],
  ['soundY','Nearest sound direction Y',Q.SOUND,(a,e)=>e.hear.n?e.hear.dy/Math.max(1,e.hear.d):0],
  ['heardTalk','Talking heard',Q.SOUND,(a,e)=>Math.min(1,e.hear.k[0]/4)],
  ['heardFight','Fighting heard',Q.SOUND,(a,e)=>Math.min(1,e.hear.k[1]/3)],
  ['heardBeast','Beast heard',Q.SOUND,(a,e)=>Math.min(1,e.hear.k[2]/2)],
  ['heardCry','Death cry heard',Q.SOUND,(a,e)=>Math.min(1,e.hear.k[3])],
  ['heardWork','Work heard',Q.SOUND,(a,e)=>Math.min(1,e.hear.k[4]/4)],
  ...SYMS.map((c,i)=>['hear'+i,'Heard '+c,Q.VOICE,a=>a.heard[i]]),
  ['heardShout','Heard a shout',Q.VOICE,a=>a.heardShout],
  ['voiceX','Last voice direction X',Q.VOICE,a=>a.voiceDx*Math.max(...a.heard)],
  ['voiceY','Last voice direction Y',Q.VOICE,a=>a.voiceDy*Math.max(...a.heard)],
  ['voiceTrust','Trust in last speaker',Q.VOICE,a=>a.voiceTrust*Math.max(...a.heard)],
  ['ownWord','Symbols said in current word',0,a=>a.utter.length/4],
  ['wantsMe','Nearest yip wants to mate with me',Q.OTHER,(a,e)=>e.other.obj&&e.other.obj.mateWant===a.id&&ticks-e.other.obj.mateAt<30?1:0],
  ['agentReady','Nearest yip is ready to mate',Q.OTHER,(a,e)=>e.other.obj&&ready(e.other.obj)?1:0],
  ['agentSimilar','Nearest yip\'s genetic similarity',Q.OTHER,(a,e)=>e.other.obj?similarity(a,e.other.obj):0],
  ['random','Noise',0,()=>rnd(-1,1)],
];
// which way a smell is stronger: a keener nose compares points farther apart, so it can follow fainter, wider trails
function smellGrad(f,a,xAxis,k){ const sm=a.ph.smell; if (sm<=.02) return 0; const o=FC*(1+Math.round(sm*1.5)); const d=xAxis?f[cellIdx(a.x+o,a.y)]-f[cellIdx(a.x-o,a.y)]:f[cellIdx(a.x,a.y+o)]-f[cellIdx(a.x,a.y-o)]; return clamp(d*sm/k,-1,1); }
const SENSES = Object.fromEntries(SENSOR_DEFS.map(d=>[d[0],d[1]]));
const KEYS = SENSOR_DEFS.map(d=>d[0]);
const KEYIDX = Object.fromEntries(KEYS.map((k,i)=>[k,i]));
const SMASK = SENSOR_DEFS.map(d=>d[2]);
const SFN = SENSOR_DEFS.map(d=>d[3]);
KEYIDX.memory = KEYIDX.trend;   // pre-1.1 saves

// ---------- brains ----------
function randArr(n, s=.6){ const f=new Float32Array(n); for (let i=0;i<n;i++) f[i]=rnd(-s,s); return f; }
const DEFAULT_INPUTS = ['bias','energy','health','pain','thirst','waterX','waterY','coldDrive','lonely','foodX','foodY','foodNear','agentX','agentY','agentNear','trust','kin','gratitude','hurtBy','agentStrength','friendX','friendY','mateScentX','mateScentY','predX','predY','predNear','foodStock','memA','memB','signal'];
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
const ex = new Float64Array(O), gradA = new Float64Array(96), gradB = new Float64Array(96);
function forward(a){
  const b=a.brain, acts=a.acts, L=b.w.length;
  for (let l=0;l<L;l++){
    const p=acts[l], out=acts[l+1], w=a.eff[l], cols=b.sizes[l], rows=b.sizes[l+1];
    const last=l===L-1;
    // hidden layers and continuous outputs use tanh; action preferences are linear so a brain can become decisive
    for (let j=0;j<rows;j++){ let s=0, base=j*cols; for (let i=0;i<cols;i++) s+=w[base+i]*p[i]; out[j]=last&&(j<O||(j>=SYM0&&j<VOL))?(s>8?8:s<-8?-8:s):ftanh(s); }
  }
  const z=acts[L], temp=.22+a.traits.explore; let m=-1e9;
  for (let i=0;i<O;i++) if (z[i]>m) m=z[i];
  let sum=0; for (let i=0;i<O;i++){ ex[i]=Math.exp((z[i]-m)/temp); sum+=ex[i]; }
  let r=Math.random(), choice=O-1;
  for (let i=0;i<O;i++) a.probs[i]=ex[i]/sum;
  for (let i=0;i<O;i++){ if ((r-=a.probs[i])<=0){ choice=i; break; } }
  // which symbol it would say, if it speaks this tick
  let sm=-1e9; for (let i=0;i<NSYM;i++) if (z[SYM0+i]>sm) sm=z[SYM0+i];
  let ss=0; for (let i=0;i<NSYM;i++){ const e=Math.exp((z[SYM0+i]-sm)/temp); a.sprobs[i]=e; ss+=e; }
  let rs=Math.random()*ss, sym=NSYM-1; for (let i=0;i<NSYM;i++){ if ((rs-=a.sprobs[i])<=0){ sym=i; break; } }
  for (let i=0;i<NSYM;i++) a.sprobs[i]/=ss;
  a.lastSym=sym; a.volume=z[VOL];
  a.signal=z[O]; a.memA=.7*a.memA+.3*z[O+1]; a.memB=.7*a.memB+.3*z[O+2]; if (z[O+3]>0) pher[cellIdx(a.x,a.y)]+=z[O+3]*.5;
  a.lastChoice=choice; return temp;
}
// Lifetime learning: policy gradient with eligibility traces. Each tick the gradient of the chosen action's
// log-probability is added to a fading trace (lambda); every reward then updates the weights along that trace,
// so relief that arrives later (eating) also credits the steps that led to it (walking to food, harvesting).
const LEARN_EVERY=3, LAMBDA=Math.pow(.93,LEARN_EVERY);   // learn every 3rd tick; the trace fades by three ticks' worth each time
function learn(a, reward, temp){
  spend(a,.4*a.traits.lr);   // rewiring the brain costs energy
  const adv=clamp(reward-a.baseline,-4,4); a.baseline=.985*a.baseline+.015*reward;
  const b=a.brain, acts=a.acts, step=a.traits.lr*adv, L=b.w.length; let grad=gradA, back=gradB;
  for (let i=0;i<O;i++) grad[i]=((i===a.lastChoice?1:0)-a.probs[i])/temp;
  for (let i=O;i<NOUT;i++) grad[i]=0;
  if (a.lastChoice===A_.SPEAK) for (let i=0;i<NSYM;i++) grad[SYM0+i]=((i===a.lastSym?1:0)-a.sprobs[i])/temp;   // learn which symbol, when speaking paid off
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
const DRIVES = ['hunger','thirst','cold','injury','fatigue','lonely','insecure','grief','urge'];
function updateDrives(a,lt,moved,exertion,restBoost){
  const ph=a.ph, d=a.drv;
  d.hunger=clamp(1-(a.energy+.75*a.gut+.35*a.fat)/(ph.maxE*.7),0,1);   // a full stomach satisfies before its energy arrives
  d.thirst=clamp(d.thirst+.0005*(1+Math.max(0,lt-24)/12),0,1);   // grows faster in the heat; only drinking lowers it
  const disc=clamp((Math.max(0,ph.coldT-lt)+Math.max(0,lt-ph.hotT))/12,0,1);
  d.cold+=(disc-d.cold)*(disc>d.cold?.015:.12);                     // chill builds slowly, warmth relieves fast
  d.injury=clamp((1-a.health/ph.maxH)*.8+a.pain*.4,0,1);
  d.fatigue=clamp(d.fatigue+.0002+(moved?.00025:0)+exertion-restBoost,0,1);
  d.insecure=clamp(1-(a.inv.food+.4*a.inv.wood+.4*a.inv.stone+.8*a.stash+3*(ownVal.get(a.id)||0))/6,0,1);
  d.grief=Math.max(0,d.grief-.0015);
  // the urge to reproduce grows in adults, much faster when no other yip is within sensing range,
  // and slowly eases in a crowd; a birth satisfies it
  if (a.age>150){ const alone=!env.other.obj||env.other.dist>=a._r, crowd=a.crowdN||0; d.urge=clamp(d.urge+(alone?.0025:.0005)-(crowd>5?.0004*(crowd-5):0),0,1); }   // grief fades slowly; witnessing a death raises it (see onDeath)
  // loneliness is updated where yips meet (socialTick) and relieved by thanks
}
function wellbeing(a){
  const d=a.drv, t=a.traits;
  return -(d.hunger*d.hunger + d.thirst*d.thirst + d.cold*d.cold + t.caution*d.injury*d.injury + .6*d.fatigue*d.fatigue + 1.6*t.social*d.lonely*d.lonely + (.5+t.greed)*d.insecure*d.insecure + d.grief*d.grief + 1.6*d.urge*d.urge);
}
const MATV={wood:.12,stone:.15}; let ownVal=new Map();
const buildValue=b=>{ const s=SPECS[b.type]; return (s.wood*MATV.wood+s.stone*MATV.stone)*Math.max(0,b.hp/b.max); };
const REWARD_SCALE=8;   // one wellbeing unit = one energy-100; scaled so learning moves at a useful pace
const actFreq=new Float64Array(O).fill(1/O), okTick=new Float64Array(O);
function updateActFreq(){ let s=0; for (let i=0;i<O;i++) s+=okTick[i]; if (s>0) for (let i=0;i<O;i++){ actFreq[i]=.995*actFreq[i]+.005*okTick[i]/s; okTick[i]=0; } }

// ---------- energy physics ----------
// The world holds a fixed amount of energy. It is only ever moved, never made or destroyed:
//   wild reserve (heat, decay and anything unclaimed) -> plants and beasts -> yips' guts -> usable energy and fat
//   -> work, body heat and waste -> back to the reserve or into the soil where it was lost.
// Every transfer loses some to the reserve. Soil nutrients (from waste, rot and planting) regrow food where they lie;
// the rest of the reserve regrows plants on fertile ground and, when it is large, spawns beasts.
// Every so often everything is added up and the reserve absorbs any rounding, so the total stays exact.
const FOOD_E=40, WOOD_E=12, MEAT_E=35, BEAST_E=150;
const FAT_EFF=.9, GESTATE_EFF=.7, ROT_AT=700;
let reserve=0, worldE=0, ledgerLast=null, auditDrift=0;
let gardens=[], wildF=.5;
const lose = e => { if (e>0) reserve+=e; };                                   // heat and work: straight back to the wild
const toSoil = (e,x,y) => { if (e>0) nut[cellIdx(x,y)]+=e; };                 // waste and rot: nutrients where they fall
function spend(a,e){ a.energy-=e; reserve+=e; a.spent+=e; }
function burnAvg(a){ a.burn=(a.burn||0)*.97+a.spent*.03; a.spent=0; }                   // every action costs energy, and it all ends up as heat
function takeReserve(e){ if (reserve<e) return false; reserve-=e; return true; }
function itemE(it){ return it.t===0?FOOD_E:it.t===1?WOOD_E:it.t===3?it.e:0; }
const invE = v => (v.food||0)*FOOD_E+(v.wood||0)*WOOD_E+(v.meat||0)*MEAT_E;
const yipE = a => a.energy+a.gut+a.fat+a.body+(a.preg?a.preg.e:0)+invE(a.inv);
function ledger(){
  const L={yips:0,plants:0,meat:0,beasts:0,built:0,soil:0,reserve};
  for (const a of agents) if (!a.dead) L.yips+=yipE(a);
  for (const it of items){ if (it.dead) continue; if (it.t===3) L.meat+=it.e; else L.plants+=itemE(it); }
  for (const z of beasts) L.beasts+=Math.max(0,z.energy)+z.body;
  for (const b of buildings) L.built+=(b.e||0)+invE(b.stock);
  for (let i=0;i<nut.length;i++) L.soil+=nut[i];
  return L;
}
// add everything up; the reserve takes up any difference so the world's total never drifts
function audit(){
  const L=ledger(), held=L.yips+L.plants+L.meat+L.beasts+L.built+L.soil;
  const want=worldE-held; auditDrift=want-reserve; reserve=Math.max(0,want);
  if (want<0) worldE=held;   // only possible after a manual edit; accept the new total
  L.reserve=reserve; L.total=worldE; L.drift=auditDrift; ledgerLast=L; return L;
}
// plants regrow from the reserve on fertile ground and around gardens; soil nutrients regrow food where they lie
function grow(){
  const k=.0008*settings.food/7.5*(1+.45*seasonS);
  let budget=reserve*k;
  while (budget>=FOOD_E){ budget-=FOOD_E; if (!takeReserve(FOOD_E)) break; if (!addItem('food',undefined,undefined,true)) reserve+=FOOD_E; }
  if (Math.random()<budget/FOOD_E&&takeReserve(FOOD_E)&&!addItem('food',undefined,undefined,true)) reserve+=FOOD_E;
  if (Math.random()<settings.trees&&takeReserve(WOOD_E)&&!addItem('tree',undefined,undefined,true)) reserve+=WOOD_E;
  if (Math.random()<settings.stone) addItem('stone');
  // nutrient-rich soil sprouts food on the spot (a few random cells per tick)
  for (let n=0;n<48;n++){ const i=(Math.random()*nut.length)|0; if (water[i]!==0) continue; let k=0; while (nut[i]>=FOOD_E&&k<3&&Math.random()<.35+fert[i]){ const x=((i%FW)+Math.random())*FC, y=(((i/FW)|0)+Math.random())*FC; if (!addItem('food',x,y,true)) break; nut[i]-=FOOD_E; k++; } }
  // gardens: planted food draws extra growth from the wild reserve onto that spot, like sunlight on a field
  for (let i=gardens.length-1;i>=0;i--){ const g=gardens[i]; g.life--; if (g.life<=0){ gardens.splice(i,1); continue; }
    if ((ticks+g.id)%45===0&&takeReserve(FOOD_E)&&!addItem('food',g.x+rnd(-12,12),g.y+rnd(-12,12),true)) reserve+=FOOD_E; }
  // soil slowly leaches back into the wild reserve
  if (ticks%50===0){ let back=0; for (let i=0;i<nut.length;i++){ const d=nut[i]*.04; nut[i]-=d; back+=d; } reserve+=back; }
  // a large reserve feeds the wilderness: beasts appear when there is energy to spare
  // energy lying idle in the wild (reserve and soil) feeds the wilderness: beasts appear while there is energy to spare
  if (ticks%20===0){ let soil=0; for (let i=0;i<nut.length;i+=7) soil+=nut[i]; soil*=7; wildF=(reserve+soil)/Math.max(1,worldE); }
  if (wildF>.2&&Math.random()<(wildF-.15)/150*Math.max(0,1-beasts.length/(settings.beasts*2.5))&&takeReserve(BEAST_E)) spawnBeast();
}

// ---------- bodies ----------
// Everything a body is built from has mass and upkeep; metabolism is not a trait but the sum of those costs.
const effStr = a => a.traits.strength*a.muscle;
const effSpd = a => a.traits.speed*(.55+.45*a.muscle);
function massOf(a){ const ph=a.ph; return 1+Math.max(0,ph.gut)/90+Math.max(0,ph.maxH-100)/220+.22*effStr(a)+.1*effSpd(a)+.5*Math.max(0,1-ph.armor)+.04*Math.max(0,ph.carry)+ph.maxE/700+a.fat/150+load(a)*.04+(a.preg?a.preg.e/120:0); }
const gutCap = a => Math.max(15,45+18*a.mass+a.ph.gut);
// organ upkeep per tick: eyes, nose, ears, immune system, healing, insulation, reproductive organs, brain and genes
function upkeepOf(a){
  const t=a.traits, ph=a.ph;
  return .00022*ph.sense+.006*ph.smell+.0001*ph.hearing+.008*ph.immune+.006*t.regen+.004*t.thermal+.005*ph.womb+.0025*ph.seed+.4*a.brainCost+a.geneUpkeep;
}
function bodyTick(a,resting,shelter){
  const ph=a.ph; a.mass=massOf(a);
  // digestion turns gut contents into usable energy over time; the gut's efficiency decides how much is kept
  if (a.gut>0){ const dg=Math.min(a.gut,Math.max(.1,.35+.25*a.mass+.008*a.ph.gut)), eff=clamp(.85*ph.food,.3,.95); a.gut-=dg; a.energy+=dg*eff; toSoil(dg*(1-eff),a.x,a.y); }
  // a full store spills into fat; a low one draws fat back out, each with a loss
  const hi=ph.maxE*.85, low=ph.maxE*.3;
  if (a.energy>hi){ const x=Math.min(a.energy-hi,.6); a.energy-=x; a.fat+=x*FAT_EFF; lose(x*(1-FAT_EFF)); }
  else if (a.energy<low&&a.fat>0){ const y=Math.min(a.fat,.6); a.fat-=y; a.energy+=y*FAT_EFF; lose(y*(1-FAT_EFF)); }
  // resting with a body at ease burns less
  const restF=resting?1-.3*Math.min(1.5,a.traits.rest)/1.5*(shelter?1.2:1):1;
  spend(a,(.035*Math.pow(a.mass,.75)*restF+upkeepOf(a))*settings.drain);
  // muscles grow with use (which costs energy) and slowly waste away when idle
  if ((a.id+ticks)%50===0){
    const use=a.muscleUse; a.muscleUse=0;
    if (use>6&&a.muscle<1.15&&a.energy>40){ a.muscle=Math.min(1.15,a.muscle+.02); spend(a,1.5); }
    else if (use<2) a.muscle=Math.max(.45,a.muscle-.004);
  }
}
// holding body temperature: below comfort a yip shivers (more if lean and large), above it sweats (more if fat) and gets thirsty
function thermoCost(a,lt){
  const ph=a.ph, cold=Math.max(0,ph.coldT-lt), hot=Math.max(0,lt-ph.hotT), ins=(1+a.fat/120)*a.traits.thermal;
  const c=cold*.0025*Math.pow(a.mass,.67)/ins, h=hot*.002*(1+a.fat/160)/a.traits.thermal;
  if (h>0) a.drv.thirst=Math.min(1,a.drv.thirst+h*.01);
  return c+h;
}

// ---------- disease ----------
// Rotting carcasses (and the sick) carry disease. It spreads only at close range, but its smell drifts much farther,
// so a yip with a good nose can learn to keep away. A strong immune system fights it off; fighting costs energy.
function infect(a,p){ if (a.sick>0||!settings.disease) return; if (Math.random()<p*settings.disease/Math.max(.15,a.ph.immune)){ a.sick=.35+.4*Math.random(); tally.infections++; } }
function sicknessTick(a){
  if (a.sick<=0) return;
  const s=a.sick;
  spend(a,.05*s+.02*a.ph.immune); a.health-=.03*s; a.drv.fatigue=Math.min(1,a.drv.fatigue+.0008*s); a.harm='disease';
  a.sick=s+.0005-.0022*a.ph.immune*(a.energy>30?1:.4); if (a.sick<=0) a.sick=0; else if (a.sick>1) a.sick=1;
  miasma[cellIdx(a.x,a.y)]+=.12*s;
}

// ---------- sounds ----------
// No sound propagation: an action that makes noise registers as a point that any yip within hearing range can pick up.
// Kinds: 0 talk, 1 fight, 2 beast, 3 death cry, 4 work.
let sounds=[], soundsPrev=[];
function noise(x,y,k){ if (sounds.length<1500) sounds.push({x,y,k}); }
const _hear={n:0,dx:0,dy:0,d:0,k:[0,0,0,0,0,0]};
function hear(a){
  const r=a.ph.hearing, h=_hear; h.n=0; h.d=r; h.dx=h.dy=0; h.k[0]=h.k[1]=h.k[2]=h.k[3]=h.k[4]=h.k[5]=0; let bd=1e18;
  if (r<=0) return h;
  forBins(gSound,a.x,a.y,r*1.7,s=>{ const L=s.k===5?(s.shout?SHOUT_L:SPEAK_L):NOISE_L[s.k], R=r*L, dx=wd(s.x-a.x,W), dy=wd(s.y-a.y,H), dd=dx*dx+dy*dy; if (dd>R*R||dd<1) return; h.n++; h.k[s.k]++; if (dd<bd){ bd=dd; h.dx=dx; h.dy=dy; } });
  h.d=h.n?Math.min(r,Math.sqrt(bd)):r; return h;
}

// ---------- voices ----------
// What a yip hears of others' speech: each symbol leaves a fading trace (so the order of a word survives as how faded
// each part is), plus whether it was shouted, where it came from and how much it trusts the speaker.
// Speech carries SPEAK_R, a shout SHOUT_R, and either only as far as the listener can hear.
function listen(a){
  const f=Math.pow(.8,ticks-a.heardAt); a.heardAt=ticks;
  for (let i=0;i<NSYM;i++) a.heard[i]*=f; a.heardShout*=f;
  const R=a.ph.hearing*SHOUT_L; if (R<=0) return;
  let bd=1e9;
  forBins(gSound,a.x,a.y,R,s=>{
    if (s.k!==5||s.id===a.id) return;
    const dx=wd(s.x-a.x,W), dy=wd(s.y-a.y,H), d=Math.sqrt(dx*dx+dy*dy);
    if (d>a.ph.hearing*(s.shout?SHOUT_L:SPEAK_L)) return;
    a.heard[s.sym]=1; if (s.shout) a.heardShout=1;
    if (d<bd){ bd=d; a.voiceDx=dx/Math.max(1,d); a.voiceDy=dy/Math.max(1,d); a.voiceTrust=a.trust.get(s.id)||0; }
  });
}
// The dictionary: nobody tells us what a symbol means, so we record the situation each time one is used
// and compare it with how often that situation happens anyway. A symbol used 8x more often than chance when
// a beast is in sight is probably about beasts, whatever the yips "intend".
const CTX = ['beast','food','hungry','hurt','kin','stranger','mate','fight','alone','young','sick'];
const NCTX = CTX.length;
let symStats=[], wordStats=new Map(), ctxBase=new Float64Array(NCTX), ctxBaseN=0;
function resetLang(){ symStats=SYMS.map(()=>({n:0,shout:0,ctx:new Float64Array(NCTX)})); wordStats=new Map(); ctxBase=new Float64Array(NCTX); ctxBaseN=0; }
resetLang();
const _ctx=new Uint8Array(NCTX);
function contextOf(a,e){
  const o=e.other.obj, near=o&&e.other.dist<40;
  _ctx[0]=e.pred&&e.pred.obj?1:0; _ctx[1]=e.food&&e.food.obj&&e.food.dist<40?1:0; _ctx[2]=a.drv.hunger>.5?1:0; _ctx[3]=a.drv.injury>.35?1:0;
  _ctx[4]=near&&kinship(a,o)>.4?1:0; _ctx[5]=near&&(a.trust.get(o.id)||0)<.1&&kinship(a,o)<.2?1:0; _ctx[6]=ready(a)?1:0;
  _ctx[7]=ticks-a.lastHurtAt<30||a.lastChoice===A_.ATTACK||a.lastChoice===A_.HUNT?1:0; _ctx[8]=!o||e.other.dist>=a._r?1:0; _ctx[9]=a.preg?1:0; _ctx[10]=a.sick>.05?1:0;
  return _ctx;
}
function noteSymbol(a,sym,shout){ const c=contextOf(a,env), st=symStats[sym]; st.n++; if (shout) st.shout++; for (let i=0;i<NCTX;i++) st.ctx[i]+=c[i]; }
function sampleContext(a){ const c=contextOf(a,env); for (let i=0;i<NCTX;i++) ctxBase[i]+=c[i]; ctxBaseN++; }
// a word is finished when the speaker pauses or reaches four symbols
function endWord(a){
  if (!a.utter.length) return;
  const w=(a.utterShout?'!':'')+a.utter.map(i=>SYMS[i]).join('');
  a.saidLog.push([ticks,w]); if (a.saidLog.length>10) a.saidLog.shift();
  const key=a.utter.join(','); let ws=wordStats.get(key);
  if (!ws){ if (wordStats.size>=400){ let mk=null, mn=1e9; for (const [k,v] of wordStats) if (v.n<mn){ mn=v.n; mk=k; } wordStats.delete(mk); } ws={n:0,shout:0,ctx:new Float64Array(NCTX),speakers:new Set()}; wordStats.set(key,ws); }
  ws.n++; if (a.utterShout) ws.shout++; const c=contextOf(a,env); for (let i=0;i<NCTX;i++) ws.ctx[i]+=c[i]; if (ws.speakers.size<50) ws.speakers.add(a.id);
  tally.words++; a.utter=[]; a.utterShout=false;
}
// what each symbol or word seems to be about: situations it shows up in far more often than chance
function meaning(st){
  if (st.n<15||!ctxBaseN) return [];
  const out=[]; for (let i=0;i<NCTX;i++){ const base=(ctxBase[i]+1)/(ctxBaseN+2), p=st.ctx[i]/st.n, lift=p/base; if (p>.25&&lift>1.6) out.push([CTX[i],+lift.toFixed(1),+p.toFixed(2)]); }
  return out.sort((x,y)=>y[1]-x[1]).slice(0,3);
}
function langReport(){
  const words=[...wordStats.entries()].sort((x,y)=>y[1].n-x[1].n).slice(0,16).map(([k,v])=>({w:k.split(',').map(i=>SYMS[+i]).join(''),n:v.n,shout:v.shout/v.n,speakers:v.speakers.size,means:meaning(v)}));
  return {syms:SYMS,symbols:symStats.map((v,i)=>({s:SYMS[i],n:v.n,shout:v.n?v.shout/v.n:0,means:meaning(v)})),words,vocab:wordStats.size};
}

// ---------- agents ----------
// ---------- genetics ----------
// Physical traits change slowly between generations and are paid for in energy: muscle adds mass that must be
// carried and fed, organs need upkeep. Mental traits (temperament and motivations) mutate fast and cost nothing.
const PHYS = ['strength','speed','thermal','sense','smell','hearing','immune','rest','regen'];
const MENT = ['lr','explore','curiosity','aggression','social','trustful','despTrust','dread','altruism','greed','caution'];
const TRAIT_INFO = {
  strength:['Strength','Muscle for damage, carrying and fights. Muscle is mass: it costs energy to carry and keep, and wastes away if unused'],
  speed:['Speed','Leg muscle for movement per step; also adds mass'],
  thermal:['Insulation','How little energy it spends staying warm in the cold and cool in the heat'],
  sense:['Sight range','How far it can see and recognise food, yips, beasts, carcasses and shelter. Eyes cost upkeep'],
  smell:['Smell','How strongly it picks up scents: trails, mating scent and the smell of disease. Also how far away it can tell which way a smell is coming from'],
  hearing:['Hearing range','How far away it hears talk, fights, beasts, death cries and work'],
  immune:['Immunity','How well it resists and fights off disease. Costs upkeep'],
  rest:['Rest','How much resting lowers its energy burn and eases fatigue'],
  regen:['Healing','How fast it heals while fed; healing costs energy'],
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
const TB = {strength:[.2,3],speed:[.2,3],thermal:[.2,2.5],sense:[0,260],smell:[0,3],hearing:[0,300],immune:[.05,3],rest:[.1,3],regen:[.1,3],
  lr:[.0001,.15],explore:[.02,2.8],curiosity:[0,3],aggression:[.05,3],social:[.2,2.5],trustful:[.1,2],despTrust:[-1,1],dread:[0,2],altruism:[0,2],greed:[0,1.5],caution:[.1,3]};
function freshTraits(){ return {strength:rnd(.5,1.7),speed:rnd(.5,1.8),thermal:rnd(.4,1.6),sense:Math.random()<.15?rnd(0,25):rnd(25,160),smell:Math.random()<.2?rnd(0,.15):rnd(.15,1.6),hearing:Math.random()<.2?rnd(0,20):rnd(20,170),immune:rnd(.3,1.5),rest:rnd(.4,1.5),regen:rnd(.4,1.5),
  lr:rnd(.004,.03),explore:rnd(.12,1.2),curiosity:rnd(.2,1.2),aggression:rnd(.2,1),social:rnd(.3,1.4),trustful:rnd(.5,1.2),despTrust:rnd(-.3,.3),dread:rnd(.3,1),altruism:rnd(0,.6),greed:rnd(0,.6),caution:rnd(.5,1.5),hue:rnd(0,360)}; }

// ---------- genes ----------
// A genome is a list of genes. Each gene nudges a few body dials, optionally only under one condition
// (cold, night, young, starving, swimming...). Genes duplicate, mutate, gain and lose effects, change condition,
// appear from nothing and disappear, all by chance. Nothing here says which genes are good: physics prices every
// dial, so an improvement costs body budget and an impairment gives some of it back, and selection does the rest.
const DIALS = {
  speed:   {kind:'mul',lo:-.4, hi:.6, cost:3,   good:1,  label:'speed'},
  dmg:     {kind:'mul',lo:-.4, hi:.8, cost:2,   good:1,  label:'hit power'},
  armor:   {kind:'mul',lo:-.5, hi:.5, cost:2.5, good:-1, label:'damage taken'},
  carry:   {kind:'add',lo:-3,  hi:4,  cost:.3,  good:1,  label:'carry capacity'},
  sense:   {kind:'add',lo:-40, hi:60, cost:.02, good:1,  label:'sight range'},
  smell:   {kind:'add',lo:-.6, hi:.8, cost:1,   good:1,  label:'sense of smell'},
  hearing: {kind:'add',lo:-50, hi:70, cost:.017,good:1,  label:'hearing range'},
  immune:  {kind:'add',lo:-.5, hi:.8, cost:1.3, good:1,  label:'immunity'},
  gut:     {kind:'add',lo:-25, hi:40, cost:.035,good:1,  label:'stomach size'},
  birth:   {kind:'mul',lo:-.4, hi:.6, cost:.8,  good:1,  label:'offspring size'},
  maxE:    {kind:'add',lo:-60, hi:80, cost:.008,good:1,  label:'max energy'},
  maxH:    {kind:'add',lo:-40, hi:50, cost:.015,good:1,  label:'max health'},
  regen:   {kind:'add',lo:-.004,hi:.03,cost:40, good:1,  label:'healing'},
  rest:    {kind:'mul',lo:-.5, hi:1,  cost:1,   good:1,  label:'rest recovery'},
  swim:    {kind:'mul',lo:-.3, hi:1.2,cost:.8,  good:1,  label:'swimming'},
  chill:   {kind:'mul',lo:-.8, hi:1,  cost:.8,  good:-1, label:'chill in water'},
  coldT:   {kind:'add',lo:-12, hi:8,  cost:.08, good:-1, label:'feels cold below (°C)'},
  hotT:    {kind:'add',lo:-8,  hi:12, cost:.08, good:1,  label:'overheats above (°C)'},
  food:    {kind:'mul',lo:-.2, hi:.4, cost:3,   good:1,  label:'digestion efficiency'},
  predMul: {kind:'mul',lo:-.3, hi:1,  cost:.8,  good:1,  label:'beast detection'},
  fertility:{kind:'mul',lo:-.5,hi:.8, cost:1.2, good:1,  label:'fertility'},
  lifespan:{kind:'mul',lo:-.3, hi:.3, cost:4,   good:1,  label:'lifespan'},
  womb:    {kind:'add',lo:-1,  hi:.6, cost:1,   good:1,  label:'ability to carry young'},
  seed:    {kind:'add',lo:-1,  hi:.6, cost:.6,  good:1,  label:'ability to sire young'},
};
const DIAL_KEYS = Object.keys(DIALS);
// a conditional gene is only switched on part of the time, so it costs proportionally less
const CONDS = {always:1, cold:.5, hot:.5, night:.5, day:.5, young:.3, old:.3, starving:.3, fed:.6, swimming:.3, hurt:.3};
const COND_KEYS = Object.keys(CONDS);
const condOn = (a,c) => c==='always'||(c==='cold'&&a._t<12)||(c==='hot'&&a._t>28)||(c==='night'&&dayS<-.15)||(c==='day'&&dayS>.15)||(c==='young'&&a.age<600)||(c==='old'&&a.age>a.lifespan*.7)||(c==='starving'&&a.energy<40)||(c==='fed'&&a.energy>100)||(c==='swimming'&&a.inWater)||(c==='hurt'&&a.health<a.phBase.maxH*.5);
// A gene's price is energy per tick while it is switched on: whatever it builds needs feeding.
// Impairments save some upkeep (a smaller organ is cheaper), but less than an improvement costs.
function geneUpkeep(g){
  let c=.0004;
  for (const [d,v] of Object.entries(g.fx)){ const D=DIALS[d]; if (!D) continue; const benefit=v*D.good*D.cost; c+=(benefit>0?benefit:benefit*.5)*.006; }
  return Math.max(0,c);
}
const geneCost = g => geneUpkeep(g)*CONDS[g.cond];   // average upkeep, for display
let nextGene=1;
const geneName = () => { const n=makeName(); return n.length<3?n+VOW[Math.floor(Math.random()*5)]+CON[Math.floor(Math.random()*CON.length)]:n; };
function newGene(fx,cond='always',name){ return {id:nextGene++,name:name||geneName(),cond,fx}; }
function randomEffect(g){ const free=DIAL_KEYS.filter(d=>!(d in g.fx)); if (!free.length) return; const d=pick(free), D=DIALS[d]; g.fx[d]=+(rnd(D.lo,D.hi)*.35).toFixed(4); }
// the old upgrades survive as a starting library of ordinary genes
const GENE_LIBRARY = [
  ['Dense muscle','always',{dmg:.25}], ['Thick hide','always',{armor:-.3,speed:-.1}], ['Long legs','always',{speed:.15,carry:-1}],
  ['Lean frame','always',{maxH:-20,carry:-1}], ['Deep sleeper','always',{rest:.6,sense:-10}], ['Fast healer','always',{regen:.025}],
  ['Hibernator','cold',{speed:-.3,rest:.5}], ['Keen eyes','always',{sense:30}], ['Night vision','night',{sense:30,hotT:-4}],
  ['Tremor sense','always',{predMul:.6,speed:-.05}], ['Fur coat','always',{coldT:-10,hotT:-5}], ['Sweat glands','always',{hotT:8,coldT:3}],
  ['Webbed feet','always',{swim:.7,speed:-.06}], ['Blubber','always',{chill:-.8,hotT:-4}], ['Efficient gut','always',{food:.25,maxE:-25}],
  ['Fat reserves','always',{maxE:60,speed:-.08}], ['Sprinter','fed',{speed:.2}], ['Juggernaut','always',{carry:3,armor:-.2,speed:-.15}],
];
const PERK_TO_GENE = {muscle:0,hide:1,legs:2,lean:3,sleeper:4,healer:5,hibernate:6,eyes:7,night:8,tremor:9,fur:10,sweat:11,webbed:12,blubber:13,gut:14,fat:15,sprint:16,jugg:17};
const libGene = i => { const [n,c,fx]=GENE_LIBRARY[i]; return newGene({...fx},c,n); };
function founderGenes(){ const g=[]; const k=Math.floor(Math.random()*3); for (let i=0;i<k;i++) g.push(libGene(Math.floor(Math.random()*GENE_LIBRARY.length))); if (Math.random()<.5){ const x=newGene({},Math.random()<.7?'always':pick(COND_KEYS)); randomEffect(x); g.push(x); } return g; }
// genes from older saves may touch dials that no longer exist (metabolism, brain upkeep are now emergent); drop those effects
function cleanGenes(gs){ const out=[]; for (const g of gs||[]){ const fx={}; for (const k in g.fx) if (DIALS[k]) fx[k]=g.fx[k]; if (Object.keys(fx).length) out.push({...g,fx,cond:CONDS[g.cond]?g.cond:'always'}); } return out; }
function mutateGenes(src){
  const mu=settings.mutation, out=[];
  for (const s0 of src){
    const g={id:s0.id,name:s0.name,cond:s0.cond,fx:{...s0.fx}}, keys=Object.keys(g.fx);
    if (keys.length&&Math.random()<.25*mu){ const d=pick(keys), D=DIALS[d], span=D.hi-D.lo; g.fx[d]=+clamp(g.fx[d]+rnd(-1,1)*span*.08,D.lo,D.hi).toFixed(4); }
    if (Math.random()<.04*mu) randomEffect(g);
    if (keys.length>1&&Math.random()<.04*mu) delete g.fx[pick(keys)];
    if (Math.random()<.02*mu) g.cond=Math.random()<.5?'always':pick(COND_KEYS);
    if (Object.keys(g.fx).length) out.push(g);
  }
  if (out.length&&Math.random()<.05*mu&&out.length<60){ const p=pick(out), d={...newGene({...p.fx},p.cond)}; const k=pick(Object.keys(d.fx)), D=DIALS[k]; d.fx[k]=+clamp(d.fx[k]+rnd(-1,1)*(D.hi-D.lo)*.1,D.lo,D.hi).toFixed(4); out.push(d); }   // duplication
  if (out.length&&Math.random()<.03*mu) out.splice(Math.floor(Math.random()*out.length),1);   // loss
  if (Math.random()<.04*mu&&out.length<60){ const g=newGene({},Math.random()<.7?'always':pick(COND_KEYS)); randomEffect(g); if (Math.random()<.4) randomEffect(g); out.push(g); }   // a new gene from nothing
  return out;
}
function mixGenes(x,y){
  // shared genes (same lineage) come from either parent; a gene only one parent carries is inherited half the time
  const byId=new Map(); for (const g of x) byId.set(g.id,[g]); for (const g of y){ const e=byId.get(g.id); if (e) e.push(g); else byId.set(g.id,[g]); }
  const out=[]; for (const v of byId.values()){ if (v.length===2) out.push(pick(v)); else if (Math.random()<.5) out.push(v[0]); }
  return out.slice(0,60);
}
function applyFx(ph,fx){ for (const d in fx){ const D=DIALS[d]; if (!D) continue; if (D.kind==='mul') ph[d]*=1+fx[d]; else ph[d]+=fx[d]; } }
function clampPh(ph){ ph.speed=Math.max(.3,ph.speed); ph.dmg=Math.max(.3,ph.dmg); ph.armor=Math.max(.3,ph.armor); ph.womb=Math.max(0,ph.womb); ph.seed=Math.max(0,ph.seed); ph.lifespan=clamp(ph.lifespan,.5,2.5); ph.maxE=Math.max(80,ph.maxE); ph.maxH=Math.max(40,ph.maxH); ph.regen=Math.max(0,ph.regen); ph.rest=Math.max(.2,ph.rest); ph.swim=Math.max(.3,ph.swim); ph.chill=Math.max(0,ph.chill); ph.food=Math.max(.5,ph.food); ph.predMul=Math.max(.5,ph.predMul); ph.sense=Math.max(0,ph.sense); ph.smell=Math.max(0,ph.smell); ph.hearing=Math.max(0,ph.hearing); ph.immune=Math.max(.05,ph.immune); ph.birth=Math.max(.3,ph.birth); ph.fertility=Math.max(.2,ph.fertility); }
// derived physiology: traits plus always-on genes are fixed at birth; conditional genes are layered on each tick
function derive(a){
  const t=a.traits;
  const ph={speed:1,dmg:1,armor:1,beastArmor:1,carry:0,coldT:15,hotT:31,food:1,maxE:200,maxH:100,rest:t.rest,regen:.004*t.regen,predMul:1,swim:1,chill:1,sense:t.sense,smell:t.smell,hearing:t.hearing,immune:t.immune,gut:0,birth:1,fertility:1,lifespan:1,womb:1,seed:1};
  a.condGenes=[]; let up=0;
  for (const g of a.genes){ if (g.cond==='always'){ applyFx(ph,g.fx); up+=geneUpkeep(g); } else a.condGenes.push(g); }
  clampPh(ph);
  a.baseUpkeep=up; a.geneUpkeep=up;
  a.phBase=ph; a.ph=ph; a.health=Math.min(a.health,ph.maxH);
}
function expressGenes(a){
  a.geneUpkeep=a.baseUpkeep;
  if (!a.condGenes.length) { a.ph=a.phBase; return; }
  let ph=null;
  for (const g of a.condGenes) if (condOn(a,g.cond)){ if (!ph) ph={...a.phBase}; applyFx(ph,g.fx); a.geneUpkeep+=geneUpkeep(g); }
  if (ph){ clampPh(ph); a.ph=ph; } else a.ph=a.phBase;
}
function mutateTraits(src){
  const t={}, mu=Math.sqrt(settings.mutation), sP=.07*mu, sM=.2*mu;
  for (const k in src){
    const v=src[k];
    if (k==='hue'){ t[k]=(v+rnd(-20,20)+360)%360; continue; }
    const [lo,hi]=TB[k]||[.2,2.5], phys=PHYS.includes(k), span=hi-lo, LO=k==='despTrust'?-3:Math.max(0,lo-span*.5), HI=hi+span*1.5;
    // beyond the usual range a mutation is more likely to pull back than push further: a soft limit, not a wall
    const over=v>hi?(v-hi)/span:v<lo?(lo-v)/span:0, bias=over?-Math.sign(v-hi>0?1:-1)*Math.min(.9,over*1.5):0;
    const step=rnd(-1,1)+bias;
    t[k]=phys&&Math.random()>.4 ? v : k==='despTrust' ? clamp(v+step*.12*mu,LO,HI) : clamp(v*Math.exp(step*(phys?sP:sM))+(k==='altruism'||k==='greed'||k==='dread'?rnd(-.03,.03):0),LO,HI);
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
function makeAgent(x,y,brain=freshBrain(),gen=0,parent=null,traits=freshTraits(),energy=90,lineage=[],genes=null){
  const a={id:nextId++,name:makeName(),x,y,vx:0,vy:0,hd:rnd(0,6.283),brain,gen,parent,lineage,traits,energy,health:100,prevHealth:100,lastBirth:-1e9,lastHurtBy:0,lastHurtAt:-1e9,clan:null,history:[],age:0,lifespan:rnd(3600,5100),
    inv:{food:0,wood:0,stone:0,meat:0,meatE:0,mY:0,mR:0,seeds:0},tool:0,gut:0,fat:0,body:40,muscle:1,muscleUse:0,mass:1.5,preg:null,sick:0,spent:0,memory:0,memA:0,memB:0,signal:0,pain:0,trust:new Map(),lastChoice:O-1,probs:new Float32Array(O),
    builds:0,success:0,kids:0,shared:0,stolen:0,attacks:0,kills:0,hunts:0,beastKills:0,crafts:0,deposits:0,
    genes:[],condGenes:[],actionCounts:new Uint32Array(O),okCounts:new Uint32Array(O),stash:0,shareHeat:0,phi:0,baseline:0,
    geneUpkeep:0,baseUpkeep:0,drv:{urge:0,grief:0,hunger:0,thirst:.2,cold:0,injury:0,fatigue:.1,lonely:.2,insecure:.8},owed:new Map(),utter:[],utterAt:-1e9,utterShout:false,saidLog:[],heard:new Float32Array(NSYM),heardShout:0,heardAt:0,voiceDx:0,voiceDy:0,voiceTrust:0,sprobs:new Float32Array(NSYM),lastSym:0,volume:0,affectionGot:0,inWater:false,thanked:new Map(),coparent:null,partners:0,sheltered:false,harm:'hunger',fx:0,_t:20};
  for (const k of [...PHYS,...MENT]) if (a.traits[k]==null) a.traits[k]=freshTraits()[k];
  a.genes=genes||founderGenes(); derive(a); a.lifespan*=a.phBase.lifespan; updateDrives(a,20,false,0,0); a.phi=wellbeing(a);
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
  let friends=0, crowd=0, hostile=0; const r=40;
  forBins(gAgent,a.x,a.y,r,o=>{
    if (o===a||o.dead||wdist(a,o)>=r) return;
    const t=a.trust.get(o.id)||0;
    if (t>-.1) gainTrust(a,o.id,.025);        // familiarity: time spent near a yip that hasn't hurt you builds a little trust on its own
    if (t>.25||kinship(a,o)>.4) friends++;
    if ((o.trust.get(a.id)||0)<-.2) hostile++;   // yips can tell when those around them dislike them
    crowd++;
  });
  a.crowdN=crowd; a.hostileN=hostile;
  const d=a.drv; d.lonely=clamp(d.lonely+(friends?-.015*Math.min(3,friends):.01*a.traits.social)+.012*hostile,0,1);
}
// Each partner's own standard falls as its urge rises: a yip that has met no one for a long time will pair
// with a stranger, and one that is crowded stays choosy. Both must accept the other.
const standard = y => .15-.3*y.drv.urge;
function findMate(a,bonus){   // unused since mating became a choice; kept for reference
  // a yip with a strong urge also notices partners farther away (it follows their scent to them)
  let best=null, bt=-1e9, crowd=0; const reach=50+80*a.drv.urge;
  forBins(gAgent,a.x,a.y,reach,o=>{
    if (o===a||o.dead) return; const d=wdist(a,o); if (d>reach) return; if (d<40) crowd++;
    if (!ready(o)||kinship(a,o)>=1) return;
    const ta=a.trust.get(o.id)||0, to=o.trust.get(a.id)||0;
    if (ta<standard(a)-bonus||to<standard(o)) return;
    const m=Math.min(ta,to); if (m>bt){ bt=m; best=o; }
  });
  a.crowdN=crowd;
  return best;
}
function blendTraits(x,y){ const t={}; for (const k in x){ if (k==='hue'){ let d=((y.hue-x.hue+540)%360)-180; t.hue=(x.hue+d*Math.random()+360)%360; continue; } const w=Math.random(); t[k]=y[k]==null?x[k]:x[k]*w+y[k]*(1-w); } return t; }
function child(a,mate){
  if (!mate) return soloChild(a);
  const lineage=[{id:a.id,name:a.name,gen:a.gen,hue:a.traits.hue},...a.lineage].slice(0,12);
  // traits blend, compatible upgrades can come from either parent, and the brain comes from one of them
  const traits=blendTraits(a.traits,mate.traits), genes=mixGenes(a.genes,mate.genes);
  mate.drv.lonely=Math.max(0,mate.drv.lonely-.25); a.drv.lonely=Math.max(0,a.drv.lonely-.25);
  a.partners++; mate.partners++; tally.pairings++;
  const brain=Math.random()<.5?a.brain:mate.brain;
  const c=makeAgent(wrapX((a.x+wd(mate.x-a.x,W)/2)+rnd(-6,6)),wrapY((a.y+wd(mate.y-a.y,H)/2)+rnd(-6,6)),mutateBrain(brain),Math.max(a.gen,mate.gen)+1,a.id,mutateTraits(traits),80,lineage,mutateGenes(genes));
  c.coparent=mate.id; c.clan=a.clan||mate.clan||a.name;
  inbreedingDefects(c,kinship(a,mate));   // close family by descent; distant relatives are fine
  setTrust(c,a.id,.5); setTrust(a,c.id,.5); setTrust(c,mate.id,.5); setTrust(mate,c.id,.5);
  a.kids++; mate.kids++; return c;
}
// how alike two genomes are: shared genes (by lineage) and close traits; 1 = identical
function similarity(a,b){
  let sh=0; const ids=new Set(a.genes.map(g=>g.id)); for (const g of b.genes) if (ids.has(g.id)) sh++;
  const gs=(a.genes.length+b.genes.length)?2*sh/(a.genes.length+b.genes.length):1;
  let td=0; for (const k of PHYS){ const [lo,hi]=TB[k]; td+=Math.abs(a.traits[k]-b.traits[k])/(hi-lo); }
  return clamp(.6*gs+.4*(1-td/PHYS.length*3),0,1);
}
// Inbreeding is never forbidden, only costly: the young carries harmful defects (never better than its parents),
// a weaker immune system, a shorter life and frailer health. Defects are ordinary genes, so they are inherited.
function inbreedingDefects(c,inbred){
  if (inbred<=0) return;
  c.lifespan*=1-.35*inbred; c.inbred=inbred;
  c.traits.immune*=1-.45*inbred;
  const n=Math.floor(inbred*3+Math.random()*inbred*2);
  for (let i=0;i<n;i++){
    const d=pick(DIAL_KEYS), D=DIALS[d], v=+(D.good>0?D.lo*rnd(.3,.8):D.hi*rnd(.3,.8)).toFixed(4);
    c.genes.push(newGene({[d]:v},'always','Defect '+geneName()));
  }
  derive(c); c.health=c.ph.maxH*(1-.3*inbred);
}
// how much is new in a child's genome compared with its parents (mutated, gained or de novo genes)
function novelty(c,a,b){
  const known=new Map(); for (const g of [...a.genes,...b.genes]) known.set(g.id+JSON.stringify(g.fx),1);
  let n=0; for (const g of c.genes) if (!known.has(g.id+JSON.stringify(g.fx))) n++;
  return n;
}
// ---------- reproduction ----------
// Yips start sexless: every body can both carry young (womb) and sire them (seed). Both organs cost upkeep, and genes
// can shrink either to nothing, so separate sexes, hermaphrodites or anything in between can evolve on their own.
// mature and not already carrying; nothing else is required (a hungry carrier simply risks losing the young)
const ready = y => y.age>150&&!y.preg&&y.energy>15;
function conceive(a,b){
  const ca=a.ph.womb>.05, cb=b.ph.womb>.05;
  let carrier; if (ca&&cb) carrier=Math.random()<a.ph.womb/(a.ph.womb+b.ph.womb)?a:b; else carrier=ca?a:cb?b:null;
  if (!carrier) return false; const sire=carrier===a?b:a;
  if (sire.ph.seed<=.05||Math.random()>Math.min(1,sire.ph.seed)*Math.min(1.2,carrier.ph.fertility)*.85){ spend(a,1); spend(b,1); return false; }
  a.drv.urge=0; b.drv.urge=0; a.lastBirth=b.lastBirth=ticks;
  const c=child(carrier,sire), nov=novelty(c,a,b); c.energy=0; c.body=0; c.fat=0; c.gut=0;
  spend(a,2+.4*nov); spend(b,2+.4*nov);
  carrier.preg={e:0,need:rnd(40,60)*carrier.ph.birth*(1+.04*nov),t:0,starve:0,sire:sire.id,child:c}; tally.conceptions++;
  noise(a.x,a.y,0); return true;
}
// the carrier feeds the young from its own energy, losing some on the way; the young is born with what it received
function pregTick(a,newborn){
  const p=a.preg; p.t++;
  if (a.energy>22){ const x=Math.min(.3*Math.sqrt(a.ph.birth),a.energy-22); a.energy-=x; p.e+=x*GESTATE_EFF; lose(x*(1-GESTATE_EFF)); p.starve=Math.max(0,p.starve-1); }
  else p.starve++;
  if (p.starve>260){ a.energy+=p.e*.5; lose(p.e*.5); a.preg=null; tally.miscarriages++; a.drv.grief=Math.min(1,a.drv.grief+.4*a.traits.dread); return; }
  if (p.e>=p.need){
    const c=p.child; a.preg=null;
    c.x=wrapX(a.x+rnd(-5,5)); c.y=wrapY(a.y+rnd(-5,5)); c.energy=p.e*.6; c.body=p.e*.4; c.age=0;
    newborn.push(c); births++;
    if (c.gen>=lastMilestone+10){ lastMilestone=c.gen-c.gen%10; toast(`Generation ${lastMilestone} reached`,'birth'); log(`Generation ${lastMilestone} reached`,'birth'); }
  }
}
function soloChild(a){   // only used when reseeding from the archive
  const c=makeAgent(wrapX(a.x+rnd(-13,13)),wrapY(a.y+rnd(-13,13)),mutateBrain(a.brain),a.gen+1,a.id,mutateTraits(a.traits),80,[{id:a.id,name:a.name,gen:a.gen,hue:a.traits.hue},...a.lineage].slice(0,12),mutateGenes(a.genes));
  a.kids++; return c;
}
const load = a => a.inv.food+a.inv.wood*1.4+a.inv.stone*2+(a.inv.meat||0)*1.2;
const capacity = a => Math.max(1,2+effStr(a)*4+a.ph.carry);
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
// What affection does: the other yip feels cared for (loneliness eases, scaled by its altruism) and trusts the giver a little.
// Repeating it to the same yip soon means less; from a yip that trusts it a lot it lands harder. It also settles gratitude owed.
function thank(g,b){
  const last=g.thanked.get(b.id), fresh=last===undefined?1:Math.min(1,(ticks-last)/300);
  g.thanked.set(b.id,ticks); if (g.thanked.size>24) g.thanked.delete(g.thanked.keys().next().value);
  const tr=Math.max(0,g.trust.get(b.id)||0), warmth=fresh*(.5+tr);
  b.drv.lonely=Math.max(0,b.drv.lonely-.08*warmth*(.5+b.traits.altruism));
  gainTrust(b,g.id,.05*warmth);
  g.owed.set(b.id,Math.max(0,(g.owed.get(b.id)||0)-1));
  b.affectionGot++; tally.affection++; g.fx|=128;
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

// Items hold energy (food and wood). Callers that create one are responsible for where its energy came from:
// growth takes it from the reserve, drops and spills move it from whatever held it. Returns null if it couldn't be placed.
function addItem(type,x,y){
  const t=ITYPES.indexOf(type);
  if (t!==3&&items.length>7000) return null;
  if (x===undefined){ [x,y]=spawnPoint(t===0?fert:t===1?forest:rock,t===0?1.6:2.2); }
  const life=t===0?rnd(400,1100):t===1?rnd(1600,3600):rnd(2500,6000);
  x=wrapX(x); y=wrapY(y); if (isWater(x,y)) return null;
  const it={t,type,x,y,life,max:life,dead:false}; items.push(it); return it;
}
// a body left behind: its energy stays in it, slowly returning to the soil as it decomposes
function addCarcass(x,y,e,src,rot=0){
  if (e<1){ toSoil(e,x,y); return; }
  if (isWater(x,y)){ lose(e); return; }
  items.push({t:3,type:'carcass',x:wrapX(x),y:wrapY(y),e,max:e,src,age:rot,life:1e9,dead:false});
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
  // the wood in a structure keeps its energy until the structure falls; a fire burns its wood as fuel
  const b={id:nextBid++,type,x,y,r:s.r,hp:s.hp,max:s.hp,owner,stock:{food:0,wood:0,stone:0,meat:0,meatE:0,mY:0,mR:0},e:s.wood*WOOD_E,life:10000,max_life:10000,ang,c:Math.cos(ang),s:Math.sin(ang)};
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
  spend(a,{house:2.5,store:3.5,wall:1.4,fire:.8}[type]); a.muscleUse+=2; noise(a.x,a.y,4);
  if (buildings.length%20===0) log(`${buildings.length} structures standing`,'build');
  return true;
}
function log(s,kind='info'){ events.unshift({t:ticks,s,kind}); if (events.length>80) events.length=80; }
function toast(s,kind,important=false){ self.postMessage({type:'toast',s,kind,important}); }
function dropInventory(a){ dropStock(a.inv,a.x,a.y,6); }
// spill a set of goods on the ground; whatever can't be placed goes into the soil, so no energy is lost
function dropStock(v,x,y,spread){
  for (const k of ['food','wood','stone']) for (let i=0;i<(v[k]||0);i++){ const it=addItem(k==='wood'?'tree':k,x+rnd(-spread,spread),y+rnd(-spread,spread)); if (!it) toSoil(k==='food'?FOOD_E:k==='wood'?WOOD_E:0,x,y); }
  if (v.meat>0) addCarcass(x+rnd(-3,3),y+rnd(-3,3),v.meatE,v.mY>0?0:1,v.mR>0?ROT_AT+1:0);
  v.food=v.wood=v.stone=0; v.meat=0; v.meatE=0; v.mY=0; v.mR=0;
}
// move n pieces of meat (with their energy and history) from one holder to another
function moveMeat(from,to,n){
  n=Math.min(n,from.meat); if (n<=0) return 0;
  const e=from.meatE*n/from.meat, y=Math.min(from.mY,Math.round(from.mY*n/from.meat)), rr=Math.min(from.mR,Math.round(from.mR*n/from.meat));
  from.meat-=n; from.meatE-=e; from.mY-=y; from.mR-=rr; to.meat=(to.meat||0)+n; to.meatE=(to.meatE||0)+e; to.mY=(to.mY||0)+y; to.mR=(to.mR||0)+rr;
  if (from.meat<=0){ from.meatE=0; from.mY=0; from.mR=0; }
  return n;
}

// ---------- beasts ----------
let nextBeast=1;
function spawnBeast(x,y){
  if (x===undefined){ [x,y]=spawnPoint(rock,.5); }
  beasts.push({id:nextBeast++,x,y,vx:0,vy:0,hd:0,hp:80,max:80,cd:0,energy:100,body:BEAST_E-100,sick:0,age:0,target:null,wander:rnd(0,6.28)});
}
function beastDies(z){ addCarcass(z.x,z.y,Math.max(0,z.energy)+z.body,1,z.sick>.3?ROT_AT+1:0); z.energy=0; z.body=0; }
const _bq={}, _bf={}, _bm={};
function tickBeasts(){
  while (beasts.length>80){ const z=beasts.shift(); beastDies(z); }   // technical ceiling only
  const pw=settings.beastPower;
  for (const z of beasts){
    z.age++; z.cd--; z.energy-=.03; lose(.03);
    if (z.sick>0){ z.energy-=.04*z.sick; lose(.04*z.sick); z.hp-=.02*z.sick; z.sick=Math.max(0,z.sick-.0008); }
    const hungry=z.energy<115;
    // a hungry beast eats what it finds: carcasses first, then plant food
    let meal=null; if (hungry){ const q=nearestIn(gMeat,z,110,_bm); meal=q.obj; if (!meal&&z.energy<70){ const q2=nearestIn(gFood,z,50,_bm); meal=q2.obj; } }
    if (meal&&wdist(z,meal)<6&&!meal.dead){
      const x=meal.t===3?Math.min(meal.e,25):FOOD_E;
      if (meal.t===3){ meal.e-=x; if (meal.age>ROT_AT&&Math.random()<.3*settings.disease) z.sick=Math.max(z.sick,.6); if (meal.e<1){ toSoil(meal.e,meal.x,meal.y); meal.e=0; meal.dead=true; } } else meal.dead=true;
      z.energy+=x*.75; toSoil(x*.25,z.x,z.y); continue;
    }
    let tgt=hungry&&z.target&&!z.target.dead&&!z.target.sheltered&&!z.target.inWater&&wdist(z,z.target)<160?z.target:null;
    if (!tgt&&hungry&&!meal){ const q=nearestIn(gAgent,z,110,_bq); tgt=q.obj&&!q.obj.sheltered&&!q.obj.inWater?q.obj:null; }
    z.target=tgt;
    let ax, ay, sp;
    const f=nearestList(fires,z,48,_bf);
    if (f.obj){ ax=-f.dx; ay=-f.dy; sp=1.9; }
    else if (meal){ ax=ddx(z,meal); ay=ddy(z,meal); sp=1.3; }
    else if (tgt){ ax=ddx(z,tgt); ay=ddy(z,tgt); sp=1.55*(.8+.2*pw); if ((z.id+ticks)%20===0) noise(z.x,z.y,2); }
    else { z.wander+=rnd(-.3,.3); ax=Math.cos(z.wander); ay=Math.sin(z.wander); sp=.6; }
    const n=Math.hypot(ax,ay)||1; z.vx=z.vx*.7+ax/n*sp*.3; z.vy=z.vy*.7+ay/n*sp*.3;
    const nx=wrapX(z.x+z.vx), ny=wrapY(z.y+z.vy);
    // beasts cannot swim: water stops them like a wall
    if (wallBlocks(nx,ny,4.5)||isWater(nx,ny)){ z.vx*=-.5; z.vy*=-.5; z.wander+=Math.PI/2; } else { z.x=nx; z.y=ny; }
    if (z.vx*z.vx+z.vy*z.vy>.01) z.hd=Math.atan2(z.vy,z.vx);
    const run=(sp*sp)*.004; z.energy-=run; lose(run);
    if (tgt&&z.cd<=0&&wdist(z,tgt)<7){ const dmg=10*pw*(.6+.4*Math.random()); tgt.health-=dmg*tgt.ph.armor*tgt.ph.beastArmor; tgt.pain=1; tgt.harm='beast'; tgt.fx|=32; z.cd=18; z.energy-=.5; lose(.5); noise(z.x,z.y,2); }
  }
  for (let i=beasts.length-1;i>=0;i--){ const z=beasts[i]; if (z.hp<=0||z.energy<=0||z.age>12000){ beastDies(z); beasts.splice(i,1); } }
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
  if (isWater(a.x,a.y)) t=Math.min(t,baseTemp*.8)-(isSea(a.x,a.y)?9:6)*a.ph.chill;      // water is colder than the air and steals body heat
  return t;
}
const env = {friend:{},food:{},tree:{},stone:{},meat:{},shelter:{},fire:{},storm:{},other:{},pred:{},crowd:{n:0,sig:0},wall:30,hear:_hear};
function sense(a){
  expressGenes(a);
  const r=a.ph.sense*(dayS<-.15?.75:1), m=a.qmask; a._r=r;
  if (m&Q.FOOD) nearestIn(gFood,a,r,env.food);
  if (m&Q.TREE) nearestIn(gTree,a,r,env.tree);
  if (m&Q.STONE) nearestIn(gStone,a,r,env.stone);
  if (m&Q.MEAT) nearestIn(gMeat,a,r,env.meat);
  if (m&Q.SOUND) env.hear=hear(a);
  if (m&Q.VOICE) listen(a);
  if (m&Q.SHELTER) nearestList(shelters,a,r,env.shelter,isShelter);
  if (m&Q.FIRE) nearestList(fires,a,r,env.fire);
  if (m&Q.STORM) nearestList(storms,a,r,env.storm);
  if (m&Q.PRED) nearestList(beasts,a,r*a.ph.predMul,env.pred);
  if (m&Q.CROWD) crowdAt(a,40,env.crowd);
  if (m&Q.WALL) env.wall=nearestWall(a,30);
  if (m&Q.FRIEND){ if (!a._fr||(a.id+ticks)%4===0) a._fr=bestFriend(a,r,a._fr||{}); env.friend=a._fr; }   // refreshed every 4 ticks
  nearestIn(gAgent,a,r,env.other,a);
  const inp=a.acts[0], codes=a.codes;
  for (let i=0;i<codes.length;i++) inp[i]=SFN[codes[i]](a,env);
}
const _h={}, _h2={}, _r={}, _z={}, _f2={}, _fw={}, _wv={}, _cq={};
let byId=new Map(), pendingBirths=[];
const graveNames=new Map();   // recent deaths, so the inspector can still name a yip that just died
function act(a,choice,e){
  let bonus=0, ok=false, moved=false; const insideNow=inside(a); a.actionCounts[choice]++;
  const o=e.other.obj, od=e.other.dist, preRel=o?{t:a.trust.get(o.id)||0,r:relOf(a,o)}:null;
  switch (choice){
    case 0: case 1: case 2: case 3: {
      const swim=a.inWater?.45*a.ph.swim:1;
      const sp=(.7+effSpd(a)*1.7)*a.ph.speed*swim/(1+load(a)/(capacity(a)*1.2))/Math.sqrt(a.mass/1.5);
      a.vx=a.vx*.35+DX[choice]*sp*.65; a.vy=a.vy*.35+DY[choice]*sp*.65; spend(a,.0032*a.mass*sp*sp*(a.inWater?2.5/a.ph.swim:1)); moved=true;
      if (load(a)>capacity(a)*.5||a.inWater) a.muscleUse+=.15; break;
    }
    case A_.HARVEST: {
      let best=null, bd=16;
      for (let t=0;t<4;t++){ const q=nearestIn(GRIDS[t],a,16,_h); if (q.obj&&q.dist<bd){ bd=q.dist; best=q.obj; } }
      if (best&&best.t===3){
        // cutting a piece off a carcass to carry like any other supply
        if (load(a)+1.2<=capacity(a)){ const x=Math.min(best.e,MEAT_E); best.e-=x; const v=a.inv; v.meat++; v.meatE+=x; if (best.src===0) v.mY++; if (best.age>ROT_AT) v.mR++; if (best.e<1){ toSoil(best.e,best.x,best.y); best.e=0; best.dead=true; } ok=true; a.success++; spend(a,.3); a.muscleUse+=1; if (best.age>ROT_AT) infect(a,.05); }
      } else if (best && load(a)+1<=capacity(a)){
        const k=best.t===1?'wood':best.type; a.inv[k]++;
        // a tool brings in a second piece; the extra must still exist, so it takes another nearby item of the same kind
        if (best.t>0&&a.tool>0&&load(a)+1.5<=capacity(a)){ const q=nearestIn(GRIDS[best.t],a,22,_h2); if (q.obj&&q.obj!==best){ q.obj.dead=true; a.inv[k]++; } a.tool--; }
        best.dead=true; ok=true; a.success++; spend(a,best.t===0?.15:.35*(a.tool>0?.7:1)); a.muscleUse+=best.t?1:.3; if (best.t) noise(a.x,a.y,4);
      }
      break;
    }
    case A_.EAT: {
      const room=a.gut+FOOD_E<=gutCap(a)+8;
      if (room&&a.inv.food>0){ a.inv.food--; a.inv.seeds=Math.min(5,(a.inv.seeds||0)+1); a.gut+=FOOD_E; a.drv.thirst=Math.max(0,a.drv.thirst-.12); ok=true; spend(a,.02); tally.meals++; }
      else if (room&&insideNow&&insideNow.stock.food>0){ insideNow.stock.food--; if (insideNow.owner===a.id) a.stash=Math.max(0,a.stash-1); else hostGrace(a,insideNow,.5+a.drv.hunger); a.gut+=FOOD_E; a.drv.thirst=Math.max(0,a.drv.thirst-.12); ok=true; spend(a,.02); tally.meals++; }
      break;
    }
    case A_.EATMEAT: {
      // meat from a rotting carcass, or from another yip, can make the eater sick
      let v=a.inv.meat>0?a.inv:insideNow&&insideNow.stock.meat>0?insideNow.stock:null;
      if (v&&a.gut+v.meatE/v.meat<=gutCap(a)+8){
        const e=v.meatE/v.meat, isY=Math.random()<v.mY/v.meat, isR=Math.random()<v.mR/v.meat;
        v.meat--; v.meatE-=e; if (isY) v.mY--; if (isR) v.mR--; if (v.meat<=0){ v.meatE=0; v.mY=0; v.mR=0; }
        a.gut+=e; ok=true; spend(a,.03); tally.meals++;
        if (isR) infect(a,.45); if (isY){ infect(a,.2); tally.cannibal++; }
        if (v!==a.inv&&insideNow.owner!==a.id) hostGrace(a,insideNow,.5+a.drv.hunger);
      }
      break;
    }
    case A_.PLANT:
      // eating food leaves its seeds; planting one makes this spot a garden that draws extra growth from the wild for a long time
      if (a.inv.seeds>0&&!a.inWater&&!isWater(a.x,a.y)){
        a.inv.seeds--; spend(a,.25);
        const g=gardens.find(g=>wdistXY(g.x,g.y,a.x,a.y)<20); if (g) g.life=Math.min(6000,g.life+1500); else if (gardens.length<160) gardens.push({id:nextBid++,x:a.x,y:a.y,life:3000,owner:a.id});
        ok=true; tally.plantings++; noise(a.x,a.y,4);
      }
      break;
    case A_.DEPOSIT:
      if (insideNow){ let n=0; for (const k of ['food','wood','stone']) if (a.inv[k]>0){ insideNow.stock[k]+=a.inv[k]; n+=a.inv[k]; a.inv[k]=0; } n+=moveMeat(a.inv,insideNow.stock,a.inv.meat); if (n){ spend(a,.05); ok=true; a.stash+=insideNow.owner===a.id?n:0; a.deposits+=n; tally.deposits+=n; a.fx|=64; if (insideNow.owner&&insideNow.owner!==a.id){ const ow=byId.get(insideNow.owner); if (ow){ gainTrust(ow,a.id,.04*n); owe(ow,a,.3+.1*n); } } } }
      break;
    case A_.WITHDRAW:
      if (insideNow){ let n=0; for (const k of ['wood','stone','food']) while (insideNow.stock[k]>0&&load(a)+(k==='stone'?2:k==='wood'?1.4:1)<=capacity(a)&&n<4){ insideNow.stock[k]--; a.inv[k]++; n++; } if (n<4&&insideNow.stock.meat>0&&load(a)+1.2<=capacity(a)) n+=moveMeat(insideNow.stock,a.inv,1); if (n){ spend(a,.05); ok=true; if (insideNow.owner===a.id) a.stash=Math.max(0,a.stash-n); tally.withdraws+=n; if (insideNow.owner&&insideNow.owner!==a.id){ const ow=byId.get(insideNow.owner); if (ow){ if ((ow.trust.get(a.id)||0)>.3) hostGrace(a,insideNow,.4+.5*a.drv.insecure); else loseTrust(ow,a.id,.2*n/2); } } } }
      break;
    case A_.HOUSE: case A_.STORE: case A_.WALL: case A_.FIRE:
      ok=build(BTYPES[choice-A_.HOUSE],a); break;
    case A_.REPAIR: {
      const b=nearestList(buildings,a,17,_r,isDamaged).obj;
      if (b&&a.inv.wood>=1&&(b.type==='fire'||a.inv.stone>=1)){ a.inv.wood--; if (b.type!=='fire') a.inv.stone--; b.e+=WOOD_E; b.hp=Math.min(b.max,b.hp+110); ok=true; spend(a,.6); a.muscleUse+=1; noise(a.x,a.y,4); if (b.owner&&b.owner!==a.id){ const ow=byId.get(b.owner); if (ow){ gainTrust(ow,a.id,.06); owe(ow,a,.5); } } }
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
          gainTrust(o,a.id,.15*value+.05); gainTrust(a,o.id,.03); owe(o,a,value); witnessGood(a,o,.02); spend(a,.05); noise(a.x,a.y,0);
          ok=true; a.shared++; tally.shares++; if (k!=='food') tally.gifts++; a.fx|=1;
        }
      }
      break;
    case A_.ATTACK:
      if (o&&od<14){
        const dmg=3*effStr(a)*a.ph.dmg*o.ph.armor*(a.tool>0?2.2:1)*(o.sheltered?.3:1)*(.6+.4*a.traits.aggression);
        o.health-=dmg; o.pain=1; o.harm='attack'; o.lastHurtBy=a.id; o.lastHurtAt=ticks;
        // fights hurt both sides: the target strikes back in proportion to its own strength
        const recoil=2.5*effStr(o)*o.ph.dmg*a.ph.armor*(o.tool>0?1.5:1)*(.5+Math.random()); a.health-=recoil; a.pain=Math.max(a.pain,.6); if (a.health<=0) a.harm='attack'; spend(a,.6+.4*effStr(a)*(.5+.5*a.traits.aggression)); spend(o,.3*effStr(o)); a.muscleUse+=2; o.muscleUse+=1; noise(a.x,a.y,1); a.attacks++; tally.attacks++; a.fx|=2; o.fx|=32;
        if (a.tool>0) a.tool--;
        loseTrust(o,a.id,.6); loseTrust(a,o.id,.15); witness(a,o,.15);
        if (o.inv.food>0&&effStr(a)>effStr(o)*.8&&load(a)+1<=capacity(a)){ o.inv.food--; a.inv.food++; a.stolen++; tally.thefts++; loseTrust(o,a.id,.3); witness(a,o,.1); }
        ok=true;
        if (o.health<=0) a.kills++;
      }
      break;
    case A_.HUNT: {
      const z=nearestList(beasts,a,16,_z).obj;
      if (z){
        const dmg=5*effStr(a)*a.ph.dmg*(a.tool>0?2.2:1)*(.7+.3*a.traits.aggression);
        const prey=z.target&&z.target!==a&&!z.target.dead?z.target:null;
        if (prey){ gainTrust(prey,a.id,.1); owe(prey,a,.6+prey.drv.injury); }
        witnessGood(a,prey,.015);
        z.hp-=dmg; z.target=a; spend(a,.8+.4*effStr(a)); a.muscleUse+=2; noise(a.x,a.y,1); a.hunts++; tally.hunts++; a.fx|=4; if (a.tool>0) a.tool--;
        ok=true;
        if (z.hp<=0){ a.beastKills++; tally.beastKills++; log(`${a.name} slew a beast`,'beast'); }
      }
      break;
    }
    case A_.CRAFT:
      if (a.tool<=0&&a.inv.wood>=1&&a.inv.stone>=1){ a.inv.wood--; a.inv.stone--; lose(WOOD_E); spend(a,.5); noise(a.x,a.y,4); a.tool=40; a.crafts++; tally.crafts++; ok=true; a.fx|=8; }
      break;
    case A_.DRINK: {
      // drinking works in the water or right at its edge
      const v=waterVec(a.x,a.y,_wv);
      if ((a.inWater&&!isSea(a.x,a.y))||v.d<FC*.9){ a.drv.thirst=Math.max(0,a.drv.thirst-.35); ok=true; spend(a,.02); }
      break;
    }
    case A_.THANK:
      if (o&&od<22){ thank(a,o); ok=true; spend(a,.03); noise(a.x,a.y,0); }
      break;
    case A_.SPEAK: {
      // a symbol said soon after the last one continues the same word (up to four); a pause starts a new one
      const shout=a.volume>.5;
      if (a.utter.length>=4||ticks-a.utterAt>8) endWord(a);
      a.utter.push(a.lastSym); a.utterAt=ticks; if (shout) a.utterShout=true;
      spend(a,shout?.05:.012); if (shout) tally.shouts++;
      if (sounds.length<1500) sounds.push({x:a.x,y:a.y,k:5,sym:a.lastSym,shout,id:a.id});
      noteSymbol(a,a.lastSym,shout);
      ok=true; break;
    }
    case A_.MATE:
      // both must want it: a yip that chooses this signals the nearest yip; if that yip chose it toward this one recently, they mate.
      // Nothing forbids relatives or strangers; the consequences (weak young, illness) are what teach them.
      // the other's answer is its own brain's inclination right now (how strongly it leans toward mating), or a yes if it asked first
      if (o&&od<30&&ready(a)&&ready(o)){
        spend(a,.05); a.mateWant=o.id; a.mateAt=ticks; ok=true;
        const yes=(o.mateWant===a.id&&ticks-o.mateAt<30)||Math.random()<Math.min(1,o.probs[A_.MATE]*O*.6);
        if (yes&&agents.length<settings.popCap){ if (conceive(a,o)){ a.mateWant=o.mateWant=0; } }
        else if (!yes) a.drv.lonely=Math.min(1,a.drv.lonely+.03);   // being turned down stings a little
      }
      break;
    case A_.BEFRIEND:
      // a deliberate choice to trust the nearest yip a little more; steps shrink as trust grows
      if (o&&od<30){ gainTrust(a,o.id,.06); ok=true; tally.befriends++; spend(a,.008); }
      break;
    default:
      if (insideNow&&a.energy>15){ const yip=insideNow.type==='house', h=Math.min(a.ph.maxH-a.health,(yip?.1:.04)*a.traits.regen); if (h>0){ a.health+=h; spend(a,h*1.2); } ok=yip; }
  }
  if (!moved){ a.vx*=.5; a.vy*=.5; }
  if (a.vx*a.vx+a.vy*a.vy>.0004){
    const nx=wrapX(a.x+a.vx), ny=wrapY(a.y+a.vy);
    if (wallBlocks(nx,ny,3.5)){ a.vx=a.vy=0; } else { a.x=nx; a.y=ny; }
    if (moved) a.hd=Math.atan2(a.vy,a.vx);
  }
  if (ok&&choice>3){ const kind=RACT[choice], tgt=kind?o:null; if (tgt&&preRel){ relTally[kind][preRel.r]++; relWin[kind][preRel.r]++; } a.history.push([ticks,choice,tgt?tgt.id:0,tgt?tgt.name:'',tgt?+preRel.t.toFixed(2):0]); if (a.history.length>24) a.history.shift(); }
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
    elite.push({score,gen:a.gen,id:a.id,name:a.name,traits:{...a.traits},genes:a.genes.map(g=>({...g,fx:{...g.fx}})),brain:copyBrain(a.brain)});
    elite.sort((x,y)=>y.score-x.score); if (elite.length>24) elite.length=24;
  }
}
function reseed(){
  const n=150;
  let band=[], bx=0, by=0;
  for (let i=0;i<n;i++){
    if (i%5===0){ for (const p of band) for (const q of band) if (p!==q) setTrust(p,q.id,.3); band=[]; [bx,by]=spawnPoint(fert,1); }
    const src=elite.length?pick(elite):null, x=wrapX(bx+rnd(-25,25)), y=wrapY(by+rnd(-25,25));
    const nb=src?makeAgent(x,y,mutateBrain(src.brain),src.gen+1,null,mutateTraits(src.traits),90,[{id:src.id,name:src.name,gen:src.gen,hue:src.traits.hue}],mutateGenes(src.genes||[])):makeAgent(x,y); agents.push(nb); band.push(nb); if (band.length===1) band.clanName=nb.name; nb.clan=band.clanName;
  }
  for (const p of band) for (const q of band) if (p!==q) setTrust(p,q.id,.3);
  for (const a of agents) reserve-=yipE(a); if (reserve<0) reserve=0;
  log(`Extinction. ${n} colonists reseeded from ${elite.length?elite.length+' archived genomes':'scratch'}`,'death');
  toast('Extinction: colony reseeded from the archive','death',true);
}

function tick(){
  ticks++;
  dayS=Math.sin(2*Math.PI*ticks/settings.day); seasonS=settings.season?Math.sin(2*Math.PI*ticks/settings.season):0; baseTemp=temperature();
  grow();
  // plants rot back into the soil; carcasses decompose into it and, once rotten, give off the smell of disease
  let w=0; for (let i=0;i<items.length;i++){ const it=items[i]; if (it.dead) continue;
    if (it.t===3){ it.age++; const d=Math.min(it.e,.012*settings.decay+it.e*.00015); it.e-=d; toSoil(d,it.x,it.y); if (it.age>ROT_AT) miasma[cellIdx(it.x,it.y)]+=.35; if (it.e<1){ toSoil(it.e,it.x,it.y); continue; } }
    else { it.life-=settings.decay; if (it.life<=0){ toSoil(itemE(it),it.x,it.y); continue; } }
    items[w++]=it; } items.length=w;
  for (let i=buildings.length-1;i>=0;i--){
    const b=buildings[i], prot=b.type==='store'?4:b.type==='house'?2:1;
    if (b.type==='fire'){ const burn=Math.min(b.e,.06*settings.decay); b.e-=burn; lose(burn); b.hp=b.max*Math.min(1,b.e/(2*WOOD_E)); }
    else { b.hp-=settings.decay*(b.type==='wall'?.09:.045); b.life-=settings.decay; }
    const st=b.stock;
    if (st.food&&Math.random()<.0004*st.food*settings.decay/prot){ st.food--; toSoil(FOOD_E,b.x,b.y); }
    if (st.meat>st.mR&&Math.random()<.0006*(st.meat-st.mR)*settings.decay/prot) st.mR++;
    if (b.hp<=0||b.life<=0||(b.type==='fire'&&b.e<=0)){ buildings.splice(i,1); toSoil(b.e,b.x,b.y); b.e=0; dropStock(st,b.x,b.y,10); }
  }
  for (let i=storms.length-1;i>=0;i--){ const s=storms[i]; s.x=wrapX(s.x+s.vx); s.y=wrapY(s.y+s.vy); s.life--; if (s.life<=0) storms.splice(i,1); }
  if (ticks%1500===0&&Math.random()<.7) sendStorm();

  clearGrid(gFood); clearGrid(gTree); clearGrid(gStone); clearGrid(gMeat); clearGrid(gAgent); clearGrid(gSound);
  for (const it of items) GRIDS[it.t][cellOf(it.x,it.y)].push(it);
  soundsPrev=sounds; sounds=[]; for (const sd of soundsPrev) gSound[cellOf(sd.x,sd.y)].push(sd);   // last tick's sounds are what yips hear now
  for (const a of agents) gAgent[cellOf(a.x,a.y)].push(a);
  fires=[]; shelters=[]; walls=[];
  for (const b of buildings){ if (b.type==='fire') fires.push(b); else if (b.type==='wall') walls.push(b); else shelters.push(b); }
  ownVal=new Map(); for (const b of buildings) if (b.owner) ownVal.set(b.owner,(ownVal.get(b.owner)||0)+buildValue(b));
  byId=new Map(); for (const a of agents){ a.fx=0; byId.set(a.id,a); }
  tickBeasts();

  const newborn=[], cap=settings.popCap; let dead=0;
  for (const a of agents){
    if (a.dead) continue;
    a.age++; a.pain*=.9;
    sense(a);   // uses a._t from the end of the previous tick
    const temp=forward(a);
    const preDrv=a.drv.cold, choice=a.lastChoice, bonus=act(a,choice,env);
    const sheltered=inside(a), storm=stormAt(a), lt=tempAt(a), ph=a.ph; a._t=lt;
    a.sheltered=!!sheltered; a.inWater=isWater(a.x,a.y);
    const resting=choice===A_.REST;
    // the body's running costs: resting burn, organs, genes, digestion, fat, muscle, then holding body temperature
    bodyTick(a,resting,sheltered); spend(a,thermoCost(a,lt));
    if (a.preg) pregTick(a,newborn);
    burnAvg(a);
    // healing is paid for in energy
    // with age the body can't be kept in as good repair: in the last third of life the most health it can hold falls to 40%
    const lifeF=a.age/a.lifespan, frail=lifeF>.67?1-.6*(lifeF-.67)/.33:1, hMax=ph.maxH*frail; if (a.health>hMax) a.health=hMax;
    if (a.health<hMax&&(a.energy>40||ph.regen>.02)){ const h=Math.min(hMax-a.health,ph.regen); a.health+=h; spend(a,h*1.2); }
    if (storm&&!sheltered){ const wb=nearestWall(a,12)<12?.4:1; a.health-=.15*settings.storm*wb; spend(a,.12*settings.storm*wb); a.harm='storm'; }
    for (const b of fires){ const dx=wd(a.x-b.x,W), dy=wd(a.y-b.y,H); if (dx*dx+dy*dy<(b.r+2)*(b.r+2)){ a.health-=.4; spend(a,.1); a.harm='fire'; } }
    if (a.inWater){ spend(a,.015/a.ph.swim); if (a.energy<6){ a.health-=.8; a.harm="drowning"; } }
    if (a.drv.thirst>=1){ a.health-=.08; a.harm='thirst'; }
    // disease: catching it takes close contact with a rotting carcass or a sick yip; it then runs its course
    if ((a.id+ticks)%4===0&&settings.disease){
      const q=nearestIn(gMeat,a,9,_cq); if (q.obj&&q.obj.age>ROT_AT) infect(a,.02);
      const o=env.other.obj; if (o&&o.sick>0&&env.other.dist<9) infect(a,.004*o.sick);
    }
    sicknessTick(a);
    // starving: with no energy left the body consumes itself
    if (a.energy<0){ a.body+=a.energy; a.health+=a.energy*.08; a.energy=0; if (a.body<0){ a.health+=a.body*.2; a.body=0; } if (a.harm!=='disease') a.harm='hunger'; }
    if (a.energy>ph.maxE){ const x=a.energy-ph.maxE; a.energy=ph.maxE; a.fat+=x*FAT_EFF; lose(x*(1-FAT_EFF)); }
    if (a.inv.food&&Math.random()<.0012*a.inv.food){ a.inv.food--; toSoil(FOOD_E,a.x,a.y); }   // carried food spoils; stores keep it better
    if (a.inv.meat>a.inv.mR&&Math.random()<.001*(a.inv.meat-a.inv.mR)) a.inv.mR++;            // carried meat goes off
    a.memory=clamp(.96*a.memory+.04*(a.energy/100-1),-1,1);
    a.prevHealth=a.health; a.shareHeat*=.99;
    const exert=(choice===A_.ATTACK||choice===A_.HUNT)?.003:0;
    if (a.utter.length&&ticks-a.utterAt>8) endWord(a);
    if ((a.id+ticks)%10===0) sampleContext(a);
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
    a.racc=(a.racc||0)+reward;
    if (settings.learning&&(a.id+ticks)%LEARN_EVERY===0){ learn(a,a.racc,temp); a.racc=0; }
    if (ready(a)) mateSc[cellIdx(a.x,a.y)]+=.4+a.drv.urge;   // ready to breed: gives off mating scent, stronger with urge
    if (a.health<=0||a.age>a.lifespan){
      onDeath(a); a.dead=true; dead++; deaths++; const cause=a.age>a.lifespan?'age':a.harm; deathsBy[cause]=(deathsBy[cause]||0)+1;
      noise(a.x,a.y,3); dropInventory(a); archive(a);
      // the body stays behind with all the energy it held (an unborn young dies with it)
      addCarcass(a.x,a.y,Math.max(0,a.energy)+a.gut+a.fat+a.body+(a.preg?a.preg.e:0),0,a.sick>.3?ROT_AT+1:0);
      a.energy=a.gut=a.fat=a.body=0; a.preg=null;
    }
  }
  updateActFreq();
  if (dead) agents=agents.filter(a=>!a.dead);
  for (const c of newborn) agents.push(c);
  for (const c of pendingBirths) agents.push(c); pendingBirths=[];
  if (agents.length>peakPop) peakPop=agents.length;
  if (!agents.length&&settings.autoReseed) reseed();
  // scent fades every tick and spreads to neighbouring cells every 8 ticks (wrapping)
  for (let i=0;i<pher.length;i++){ pher[i]*=.993; mateSc[i]*=.985; miasma[i]*=.985; }
  if (ticks%6===0){ for (let y=0;y<FH;y++) for (let x=0;x<FW;x++){ const i=x+y*FW, l=((x+FW-1)%FW)+y*FW, r=((x+1)%FW)+y*FW, u=x+((y+FH-1)%FH)*FW, d=x+((y+1)%FH)*FW; miaTmp[i]=miasma[i]*.4+(miasma[l]+miasma[r]+miasma[u]+miasma[d])*.15; } const t=miasma; miasma=miaTmp; miaTmp=t; }
  if (ticks%200===0) audit();
  if (ticks%4===0){ for (let y=0;y<FH;y++) for (let x=0;x<FW;x++){ const i=x+y*FW, l=((x+FW-1)%FW)+y*FW, r=((x+1)%FW)+y*FW, u=x+((y+FH-1)%FH)*FW, d=x+((y+1)%FH)*FW; mateTmp[i]=mateSc[i]*.5+(mateSc[l]+mateSc[r]+mateSc[u]+mateSc[d])*.125; } const t=mateSc; mateSc=mateTmp; mateTmp=t; }
  if (ticks%8===0){ for (let y=0;y<FH;y++) for (let x=0;x<FW;x++){ const i=x+y*FW, l=((x+FW-1)%FW)+y*FW, r=((x+1)%FW)+y*FW, u=x+((y+FH-1)%FH)*FW, d=x+((y+1)%FH)*FW; pherTmp[i]=pher[i]*.6+(pher[l]+pher[r]+pher[u]+pher[d])*.1; } const t=pher; pher=pherTmp; pherTmp=t; }
  if (ticks%25===0) pushHistory();
  if (settings.migrateEvery>0&&ticks%settings.migrateEvery===0) exportMigrants();
}
function avg(f){ if (!agents.length) return 0; let s=0; for (const a of agents) s+=f(a); return s/agents.length; }
let lastTally={...tally};
function pushHistory(){
  let food=0; for (const it of items) if (!it.dead&&it.t===0) food++;
  let stocked=0; for (const b of buildings) stocked+=b.stock.food;
  const d={}; for (const k in tally){ d[k]=tally[k]-(lastTally[k]||0); } lastTally={...tally};
  const rel={}; for (const k in relWin){ const v=relWin[k], sm=v[0]+v[1]+v[2]+v[3]; rel[k]=sm?v.map(x=>x/sm):null; } relWin={share:[0,0,0,0],attack:[0,0,0,0],thank:[0,0,0,0],befriend:[0,0,0,0]};
  let both=0, carry=0, sire=0, sick=0; for (const a of agents){ const c=a.ph.womb>.05, si=a.ph.seed>.05; if (c&&si) both++; else if (c) carry++; else if (si) sire++; if (a.sick>.05) sick++; }
  history.push({t:ticks,reserveF:worldE?reserve/worldE:0,both,carry,sire,sick,fat:avg(a=>a.fat),mass:avg(a=>a.mass),burn:avg(a=>a.burn||0),rel,pop:agents.length,rep:avg(a=>Math.max(0,repOf(a.id))),lonely:avg(a=>a.drv.lonely),food,build:buildings.length,beasts:beasts.length,stocked,gen:avg(a=>a.gen),str:avg(a=>a.traits.strength),spd:avg(a=>a.traits.speed),sense:avg(a=>a.traits.sense),agg:avg(a=>a.traits.aggression),
    neurons:avg(a=>a.brain.sizes.reduce((s,n)=>s+n,0)),tools:avg(a=>a.tool>0?1:0),births,deaths,...d});
  if (history.length>600){ // keep long runs readable: thin the older half
    const half=history.length>>1, old=history.slice(0,half).filter((_,i)=>i%2===0); history=old.concat(history.slice(half));
  }
}

// ---------- yip library: genomes kept between runs ----------
const yipScore=a=>a.age+a.kids*350+a.builds*60+a.success*2+a.beastKills*200+a.shared*20;
// a genome is what a yip passes on plus what it learned: its effective brain (inherited + learned weights folded together)
function genomeOf(a){
  const b=a.brain, w=b.w.map((f,l)=>{ const d=a.learned[l], o=new Array(f.length); for (let i=0;i<f.length;i++) o[i]=r4(f[i]+d[i]); return o; });
  return {name:a.name,gen:a.gen,clan:a.clan,score:Math.round(yipScore(a)),kids:a.kids,age:a.age|0,island,tick:ticks,traits:{...a.traits},genes:a.genes.map(g=>({...g,fx:{...g.fx}})),brain:{inputs:b.inputs,sizes:b.sizes,w}};
}
function libraryPack(m){
  if (m.id){ const a=agents.find(x=>x.id===m.id); return a?[genomeOf(a)]:[]; }
  return agents.filter(a=>a.age>200).sort((x,y)=>yipScore(y)-yipScore(x)).slice(0,m.n||10).map(genomeOf);
}
function reset(newShape,seeds){
  if (newShape) setSize(newShape);
  seed=(Math.random()*2**31)|0; makeFields(seed);
  agents=[]; items=[]; buildings=[]; storms=[]; beasts=[]; events=[]; history=[]; elite=[]; repMap.clear();
  ticks=0; nextId=1; nextBid=1; births=0; deaths=0; maxGen=0; peakPop=0; lastMilestone=0;
  deathsBy={age:0,hunger:0,thirst:0,drowning:0,storm:0,fire:0,beast:0,attack:0,disease:0}; for (const k in tally) tally[k]=0; nut.fill(0); miasma.fill(0); gardens=[]; sounds=[]; soundsPrev=[]; resetLang(); lastTally={...tally}; for (const k in relTally) relTally[k]=[0,0,0,0];
  // founders arrive in bands of five who already trust each other a little
  // with library seeds: one exact copy of each, the rest are mutated offspring of them
  const lib=(seeds||[]).map(g=>({...g,genes:cleanGenes(g.genes),brain:deBrain(g.brain)})); let k=0;
  const founder=(x,y)=>{
    if (!lib.length) return makeAgent(x,y);
    const src=lib[k%lib.length], exact=k<lib.length; k++;
    const lin=[{id:0,name:src.name,gen:src.gen,hue:src.traits.hue}];
    const a=exact?makeAgent(x,y,copyBrain(src.brain),src.gen,null,{...src.traits},90,lin,src.genes.map(g=>({...g,fx:{...g.fx}})))
                 :makeAgent(x,y,mutateBrain(src.brain),src.gen+1,null,mutateTraits(src.traits),90,lin,mutateGenes(src.genes||[]));
    if (exact) a.name=src.name;
    return a;
  };
  for (let b=0;b<60;b++){ const [bx,by]=spawnPoint(fert,1), band=[];
    for (let i=0;i<5;i++){ let x=wrapX(bx+rnd(-25,25)), y=wrapY(by+rnd(-25,25)); if (isWater(x,y)){ x=bx; y=by; } const a=founder(x,y); a.energy=120; a.fat=30; band.push(a); agents.push(a); }
    for (const a of band) a.clan=band[0].name;
    for (const a of band) for (const o of band) if (a!==o) setTrust(a,o.id,.3); }
  for (let i=0;i<1100;i++) addItem('food'); for (let i=0;i<420;i++) addItem('tree'); for (let i=0;i<320;i++) addItem('stone');
  // the world's energy is fixed from here on: whatever the founders, plants and beasts don't hold is the wild reserve
  worldE=settings.worldEnergy; reserve=0; audit(); auditDrift=0; ledgerLast.drift=0;
  for (let i=0;i<settings.beasts;i++) spawnBeast();
  selected=0; if (lib.length) log(`Island ${'ABCD'[island]||island+1}: 300 founders bred from ${lib.length} library yip${lib.length>1?'s':''}: ${lib.slice(0,8).map(g=>g.name).join(', ')}${lib.length>8?'…':''}`,'birth'); else log(`Island ${'ABCD'[island]||island+1}: 300 founders released in 60 bands. Fertile valleys, forests and rocky ground are spread across the map.`,'birth');
  if (viewing) postMeta();
}

// ---------- serialization ----------
const r4 = v => Math.round(v*1e4)/1e4, r2 = v => Math.round(v*100)/100;
const serBrain = b => ({inputs:b.inputs,sizes:b.sizes,w:b.w.map(f=>Array.from(f,r4))});
const AGENT_KEYS=['inbred','affectionGot','saidLog','gut','fat','body','muscle','sick','clan','history','lastHurtBy','lastHurtAt','name','gen','parent','lineage','traits','genes','stash','thanksGot','lovesGot','coparent','partners','age','lifespan','inv','tool','builds','success','kids','shared','stolen','attacks','kills','hunts','beastKills','crafts','deposits'];
function serAgent(a){
  const o={drv:a.drv,owed:[...a.owed],id:a.id,x:r2(a.x),y:r2(a.y),hd:r2(a.hd),energy:r2(a.energy),health:r2(a.health),memory:r4(a.memory),memA:r4(a.memA),memB:r4(a.memB),baseline:r4(a.baseline),
    trust:[...a.trust].map(([k,v])=>[k,r4(v)]),actionCounts:Array.from(a.actionCounts),brain:serBrain(a.brain),learned:a.learned.map(f=>Array.from(f,r4)),
    preg:a.preg?{e:r2(a.preg.e),need:r2(a.preg.need),t:a.preg.t,starve:a.preg.starve,sire:a.preg.sire,child:serAgent(a.preg.child)}:null};
  for (const k of AGENT_KEYS) o[k]=a[k]; return o;
}
function serialize(){
  return {version:13,reserve:Math.round(reserve),worldE:Math.round(worldE),nut:Array.from(nut,v=>Math.round(v*10)/10),gardens,shape,seed,ticks,nextId,nextBid,births,deaths,deathsBy,tally,maxGen,peakPop,selected,settings:{...settings},
    agents:agents.map(serAgent),
    items:items.filter(i=>!i.dead).map(i=>i.t===3?[3,r2(i.x),r2(i.y),0,0,r2(i.e),i.src,i.age]:[i.t,r2(i.x),r2(i.y),i.life|0,i.max|0]),
    buildings:buildings.map(b=>({...b,hp:r2(b.hp)})),storms,beasts:beasts.map(z=>({...z,target:null})),events,history,elite:elite.map(e=>({...e,brain:serBrain(e.brain)}))};
}
// Older brains had fewer outputs. Map each old discrete action and continuous output onto its new row; new rows start small.
const OLD_LAYOUTS={40:{disc:[...Array(24).keys()],cont:4,syms:12},27:{disc:[...Array(23).keys()],cont:4},14:{disc:[0,1,2,3,4,5,6,8,9,10,11,12,13,17],cont:0},21:{disc:[...Array(18).keys()],cont:3},24:{disc:[...Array(20).keys()],cont:4},25:{disc:[...Array(21).keys()],cont:4}};
function upgradeBrain(b){
  const L=b.sizes.length-1, cols=b.sizes[L-1], old=b.w[L-1], rowsOld=b.sizes[L];
  b.inputs=b.inputs.map(k=>k==='memory'?'trend':k);
  if (rowsOld===NOUT) return b;
  const f=randArr(NOUT*cols,.3), lay=OLD_LAYOUTS[rowsOld];
  if (lay){ lay.disc.forEach((to,j)=>f.set(old.subarray(j*cols,(j+1)*cols),to*cols)); for (let c=0;c<lay.cont;c++){ const j=lay.disc.length+c; f.set(old.subarray(j*cols,(j+1)*cols),(O+c)*cols); }
    for (let c=0;c<(lay.syms||0);c++){ const j=lay.disc.length+lay.cont+c; f.set(old.subarray(j*cols,(j+1)*cols),(SYM0+c)*cols); }
    // brains from before mating was a choice: mating used to follow from affection, so the new row starts as a copy of that one
    if (Math.max(...lay.disc)<A_.MATE&&lay.disc.includes(A_.THANK)) for (let i=0;i<cols;i++) f[A_.MATE*cols+i]=f[A_.THANK*cols+i]+rnd(-.05,.05); }
  b.w[L-1]=f; b.sizes[L]=NOUT; return b;
}
const deBrain = b => upgradeBrain(b.weights ? fromNested(b) : {inputs:b.inputs,sizes:b.sizes,w:b.w.map(x=>Float32Array.from(x))});
function deserialize(s){
  if (!s||!Array.isArray(s.agents)||![6,10,11,12,13].includes(s.version)) throw Error('Not an ALife Lab save (expected version 0.6 to 1.6)');
  const legacy=s.version<11, old=s.version<12; setSize();
  const ow=s.version===6||s.version===10?840:s.shape==='tall'?600:s.shape==='square'?780:960, oh=s.version===6||s.version===10?520:s.shape==='tall'?960:s.shape==='square'?780:600;
  const sx=old?W/ow:1, sy=old?H/oh:1, reg=s.registry||{};
  seed=s.seed||12345; makeFields(seed);
  const A=s.agents.map(o=>deAgent(o,sx,sy,old,reg));
  agents=A; repMap.clear(); for (const a of A) for (const [k,v] of a.trust) repMap.set(k,repOf(k)+v);
  restOfDeserialize(s,A,sx,sy,old);
}
function deAgent(o,sx=1,sy=1,old=false,reg={}){
    const brain=deBrain(o.brain);
    const genes=cleanGenes(o.genes||(o.perks||[]).filter(p=>p in PERK_TO_GENE).map(p=>libGene(PERK_TO_GENE[p])));
    for (const g of genes) if (g.id>=nextGene) nextGene=g.id+1;
    const a=makeAgent(o.x*sx,o.y*sy,brain,o.gen||0,o.parent??null,{...freshTraits(),...o.traits},o.energy,[],genes);
    a.id=o.id;
    for (const k of AGENT_KEYS) if (o[k]!==undefined&&k!=='traits'&&k!=='gen'&&k!=='parent'&&k!=='genes') a[k]=o[k];
    Object.assign(a,{health:o.health,prevHealth:o.health,memory:o.memory||0,memA:o.memA||0,memB:o.memB||0,baseline:o.baseline||0,hd:o.hd||0,lifespan:o.lifespan||rnd(3600,5100),inv:{food:0,wood:0,stone:0,meat:0,meatE:0,mY:0,mR:0,...(o.inv||{})}});
    if (o.body===undefined){ a.body=40; const old=a.lifespan; a.lifespan=Math.min(old,rnd(3600,5100)*a.phBase.lifespan); a.age=Math.round(a.age*a.lifespan/old); }   // bodies from before the energy physics keep their relative age
    delete a.traits.budget;
    if (o.affectionGot===undefined) a.affectionGot=(o.thanksGot||0)+(o.lovesGot||0);
    a.gut=a.gut||0; a.fat=a.fat||0; a.muscle=a.muscle||1; a.sick=a.sick||0;
    if (o.preg&&o.preg.child){ a.preg={...o.preg,child:deAgent(o.preg.child,sx,sy,old,reg)}; }
    a.trust=new Map(Array.isArray(o.trust)?o.trust:Object.entries(o.trust||{}).map(([k,v])=>[+k,v])); a.owed=new Map(o.owed||[]);
    if (o.actionCounts&&o.actionCounts.length===O) a.actionCounts=Uint32Array.from(o.actionCounts);
    // learned weights must match the (possibly upgraded) brain layer by layer; where a layer grew, the new part starts unlearned
    if (o.learned&&!old&&o.learned.length===a.brain.w.length){ a.learned=a.brain.w.map((w,l)=>{
        const f=new Float32Array(w.length), src=o.learned[l]; if (src.length===w.length){ f.set(src); return f; }
        // an output layer that gained rows: keep what was learned for the actions that kept their place, the rest starts fresh
        const cols=a.brain.sizes[l], lay=OLD_LAYOUTS[src.length/cols];
        if (lay&&l===w.length-1) lay.disc.forEach((to,jj)=>{ if (to===jj) f.set(src.subarray(jj*cols,(jj+1)*cols),to*cols); });
        return f; }); a.eff=a.brain.w.map((w,l)=>{ const e=new Float32Array(w.length), d=a.learned[l]; for (let i=0;i<w.length;i++) e[i]=w[i]+(d[i]||0); return e; }); }
    derive(a); if (o.drv) Object.assign(a.drv,o.drv); a.inWater=isWater(a.x,a.y); a.phi=wellbeing(a);
    if (!o.lineage){ const ch=[]; let id=o.parent; for (let i=0;i<12&&id&&reg[id];i++){ ch.push({id,gen:reg[id].gen,hue:0}); id=reg[id].parent; } a.lineage=ch; }
    return a;
}
function restOfDeserialize(s,A,sx,sy,old){
  ticks=s.ticks||0; nextId=Math.max(s.nextId||1,...A.map(a=>a.id+1)); births=s.births||0; deaths=s.deaths||0;
  deathsBy={age:0,hunger:0,storm:0,fire:0,beast:0,attack:0,...(s.deathsBy||{})}; Object.assign(tally,s.tally||{}); lastTally={...tally};
  maxGen=s.maxGen||Math.max(0,...A.map(a=>a.gen)); peakPop=s.peakPop||A.length;
  items=(s.items||[]).map(i=>Array.isArray(i)?(i[0]===3?{t:3,type:'carcass',x:i[1]*sx,y:i[2]*sy,e:i[5],max:i[5],src:i[6],age:i[7],life:1e9,dead:false}:{t:i[0],type:ITYPES[i[0]],x:i[1]*sx,y:i[2]*sy,life:i[3],max:i[4]||i[3],dead:false}):{t:ITYPES.indexOf(i.type),type:i.type,x:i.x*sx,y:i.y*sy,life:i.life,max:i.life,dead:false});
  nextBid=1;
  buildings=(s.buildings||[]).filter(b=>!isWater(b.x*sx,b.y*sy)).map(b=>{ const ang=b.ang||0; return {...b,x:b.x*sx,y:b.y*sy,r:b.type==='wall'?SPECS.wall.r:b.r,id:b.id||nextBid++,ang,c:Math.cos(ang),s:Math.sin(ang),max_life:b.max_life||(b.type==='fire'?600:10000)}; });
  nextBid=Math.max(nextBid,...buildings.map(b=>b.id+1),1);
  storms=(s.storms||[]).map(x=>({max:650,...x})); beasts=(s.beasts||[]).map(z=>({body:BEAST_E-100,sick:0,...z,target:null}));
  for (const b of buildings){ b.stock={food:0,wood:0,stone:0,meat:0,meatE:0,mY:0,mR:0,...(b.stock||{})}; if (b.e===undefined) b.e=SPECS[b.type].wood*WOOD_E*(b.type==='fire'?Math.max(.2,b.hp/b.max):1); }
  events=(s.events||[]).map(e=>typeof e==='string'?{t:0,s:e,kind:'info'}:e); history=Array.isArray(s.history)&&!old?s.history:[];
  elite=(s.elite||[]).map(e=>({...e,genes:cleanGenes(e.genes),brain:deBrain(e.brain)}));
  Object.assign(settings,s.settings||{}); if (settings.popCap===450) settings.popCap=1200; selected=s.selected||0; lastMilestone=maxGen-maxGen%10;
  // the energy ledger: restored as saved, or, for a save from before the physics, wrapped round what the save holds
  nut.fill(0); miasma.fill(0); gardens=Array.isArray(s.gardens)?s.gardens:[]; sounds=[]; soundsPrev=[];
  if (s.worldE){ if (Array.isArray(s.nut)&&s.nut.length===nut.length) nut.set(s.nut); worldE=s.worldE; reserve=s.reserve||0; audit(); }
  else { worldE=0; const L=ledger(), held=L.yips+L.plants+L.meat+L.beasts+L.built+L.soil; worldE=held+Math.max(settings.worldEnergy-held,held*.6); audit(); }
  log(old?'Older snapshot loaded and moved onto the new 1.5 world':'Snapshot loaded','info');
  if (viewing) postMeta();
}

// ---------- reporting ----------
let lastPulse=0, sendPher=false, started=false, running=true, speed=3, maxMode=false, last=performance.now(), acc=0, stepsWin=0, tps=0, lastMetrics=last, lastFrame=0, lastStats=0, lastInspect=0, inspecting=false;
function postMeta(){ self.postMessage({type:'meta',syms:SYMS,ctx:CTX,water,drives:DRIVES,bounds:TB,dials:DIALS,conds:CONDS,phys:PHYS,ment:MENT,traitInfo:TRAIT_INFO,senses:SENSES,actions:ACTIONS,short:SHORT,cont:CONT,W,H,FW,FH,FC,shape,settings,fert,forest,rock,seed}); }
function postFrame(){
  const na=agents.length, A=new Float32Array(na*10);
  for (let i=0,o=0;i<na;i++,o+=10){ const a=agents[i]; A[o]=a.id; A[o+1]=a.x; A[o+2]=a.y; A[o+3]=a.traits.hue; A[o+4]=a.hd; A[o+5]=a.energy/200; A[o+6]=a.health/100;
    A[o+7]=(a.sheltered?1:0)|(a.inv.food+a.inv.wood+a.inv.stone+a.inv.meat>0?2:0)|(a.tool>0?4:0)|(repOf(a.id)>3?8:0)|(a.inWater?16:0)|(a.sick>.05?32:0)|(a.preg?64:0); A[o+8]=a._r||a.ph.sense; let wc=0; if (a.utter.length&&ticks-a.utterAt<40){ for (const q of a.utter) wc=wc*12+q+1; wc=wc*2+(a.utterShout?1:0); } A[o+9]=(a.fx&255)+256*wc; }
  let ni=0; for (const it of items) if (!it.dead) ni++;
  const I=new Float32Array(ni*4); let o=0;
  for (const it of items){ if (it.dead) continue; I[o]=it.t===3&&it.age>ROT_AT?4:it.t; I[o+1]=it.x; I[o+2]=it.y; I[o+3]=it.t===3?Math.min(1,it.e/150):it.life/it.max; o+=4; }
  const nb=buildings.length, B=new Float32Array(nb*9);
  for (let i=0,p=0;i<nb;i++,p+=9){ const b=buildings[i]; B[p]=BTYPES.indexOf(b.type); B[p+1]=b.x; B[p+2]=b.y; B[p+3]=b.r; B[p+4]=b.hp/b.max; B[p+5]=b.id; B[p+6]=b.stock.food+b.stock.wood+b.stock.stone; B[p+7]=b.life/(b.max_life||10000); B[p+8]=b.ang||0; }
  const S=new Float32Array(storms.length*5);
  storms.forEach((s,i)=>{ S[i*5]=s.x; S[i*5+1]=s.y; S[i*5+2]=s.w; S[i*5+3]=s.h; S[i*5+4]=s.life/(s.max||650); });
  const Z=new Float32Array(beasts.length*6);
  beasts.forEach((z,i)=>{ Z[i*6]=z.id; Z[i*6+1]=z.x; Z[i*6+2]=z.y; Z[i*6+3]=z.hd; Z[i*6+4]=z.hp/z.max; Z[i*6+5]=z.target?1:0; });
  const P=sendPher?Uint8Array.from(pher,v=>Math.min(255,v*40)):null; sendPher=false;
  self.postMessage({type:'frame',P,ticks,tps,running,maxMode,temp:baseTemp,day:settings.day,season:settings.season,A,I,B,S,Z},[A.buffer,I.buffer,B.buffer,S.buffer,Z.buffer]);
}
function topGenes(){
  const m=new Map();
  for (const a of agents) for (const g of a.genes){ const e=m.get(g.id); if (e) e.n++; else m.set(g.id,{n:1,g}); }
  return [...m.values()].sort((x,y)=>y.n-x.n).slice(0,12).map(({n,g})=>({id:g.id,name:g.name,cond:g.cond,fx:g.fx,share:n/Math.max(1,agents.length)}));
}
function postStats(withHistory){
  const n=agents.length||1, sensUse={}, act=new Float64Array(O), byType={house:0,store:0,wall:0,fire:0};
  let layers=0, neurons=0, inputs=0, tools=0, stocked=0;
  for (const a of agents){ for (const k of a.brain.inputs) sensUse[k]=(sensUse[k]||0)+1; let tot=0; for (let i=0;i<O;i++) tot+=a.actionCounts[i]; if (tot) for (let i=0;i<O;i++) act[i]+=a.actionCounts[i]/tot; layers+=a.brain.sizes.length-2; for (let l=1;l<a.brain.sizes.length-1;l++) neurons+=a.brain.sizes[l]; inputs+=a.brain.inputs.length; if (a.tool>0) tools++; }
  for (const b of buildings){ byType[b.type]++; stocked+=b.stock.food; }
  const counts=[0,0,0,0]; for (const it of items) if (!it.dead) counts[it.t]++;
  let sexC=0, sexS=0, both=0, sick=0, preg=0; for (const a of agents){ const c=a.ph.womb>.05, si=a.ph.seed>.05; if (c&&si) both++; else if (c) sexC++; else if (si) sexS++; if (a.sick>.05) sick++; if (a.preg) preg++; }
  const t=k=>avg(a=>a.traits[k]);
  const names={}; for (const a of agents) names[a.id]=a.name;
  const fam=new Map();
  for (const a of agents){ const k=a.clan||a.name; let f=fam.get(k); if (!f){ f={clan:k,n:0,gen:0,act:new Float64Array(O),hue:0}; fam.set(k,f); } f.n++; f.gen=Math.max(f.gen,a.gen); f.hue+=a.traits.hue; let tot=0; for (let i=0;i<O;i++) tot+=a.actionCounts[i]; if (tot) for (let i=0;i<O;i++) f.act[i]+=a.actionCounts[i]/tot; }
  const families=[...fam.values()].sort((x,y)=>y.n-x.n).slice(0,10).map(f=>({clan:f.clan,n:f.n,gen:f.gen,hue:f.hue/f.n,mix:Array.from(f.act,v=>v/f.n)}));
  self.postMessage({type:'stats',families,relTally,names,ticks,pop:agents.length,peakPop,births,deaths,deathsBy,tally,maxGen,avgGen:avg(a=>a.gen),byType,counts,temp:baseTemp,beasts:beasts.length,tools,stocked,
    traits:Object.fromEntries([...PHYS,...MENT].map(k=>[k,t(k)])),lang:langReport(),geneUse:topGenes(),ledger:{...ledger(),total:worldE,drift:auditDrift},gardens:gardens.length,carcasses:counts[3],bodies:{both,carry:sexC,sire:sexS,neither:agents.length-both-sexC-sexS,sick,preg},avgFat:avg(a=>a.fat),avgMass:avg(a=>a.mass),avgBurn:avg(a=>a.burn||0),
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
  self.postMessage({type:'inspect',clan:a.clan,timeline:a.history.slice().reverse(),name:a.name,coparentName:nm(a.coparent),parentName:nm(a.parent),id:a.id,gen:a.gen,age:a.age,lifespan:a.lifespan,energy:a.energy,health:a.health,x:a.x,y:a.y,traits:a.traits,inv:a.inv,tool:a.tool,load:load(a),cap:capacity(a),
    builds:a.builds,success:a.success,kids:a.kids,livingKids:kids,sheltered:a.sheltered,temp:a._t,lastChoice:a.lastChoice,probs:Array.from(a.probs),inputs:b.inputs,sizes:b.sizes,ws,
    acts:a.acts.map(x=>Array.from(x)),trust:[...a.trust].sort((x,y)=>Math.abs(y[1])-Math.abs(x[1])).slice(0,10).map(([id,v])=>({id,v,name:nm(id),alive:alive.has(id)})),
    trustedBy:agents.filter(x=>(x.trust.get(a.id)||0)>.3).map(x=>({id:x.id,name:x.name,v:x.trust.get(a.id),hue:x.traits.hue})).sort((p,q)=>q.v-p.v).slice(0,12),coparentAlive:alive.has(a.coparent),
    lineage:a.lineage.map(l=>({...l,alive:alive.has(l.id)})),lastBirth:a.lastBirth,parent:a.parent,genes:a.genes.map(g=>({...g,cost:+geneUpkeep(g).toFixed(4),on:condOn(a,g.cond)})),
    ph:{maxE:a.ph.maxE,maxH:a.ph.maxH,speed:a.ph.speed,dmg:a.ph.dmg,armor:a.ph.armor,coldT:a.ph.coldT,hotT:a.ph.hotT,sense:a.ph.sense,smell:a.ph.smell,hearing:a.ph.hearing,immune:a.ph.immune,womb:a.ph.womb,seed:a.ph.seed,food:a.ph.food,lifespan:a.ph.lifespan},
    body:{inbred:a.inbred||0,defects:a.genes.filter(g=>g.name.startsWith('Defect')).length,frail:(()=>{ const f=a.age/a.lifespan; return f>.67?1-.6*(f-.67)/.33:1; })(),gut:a.gut,gutCap:gutCap(a),fat:a.fat,body:a.body,muscle:a.muscle,mass:a.mass,sick:a.sick,str:effStr(a),preg:a.preg?{e:a.preg.e,need:a.preg.need,t:a.preg.t}:null,burn:a.burn||0,
      upkeep:{base:.035*Math.pow(a.mass,.75),eyes:.00022*a.ph.sense,nose:.006*a.ph.smell,ears:.0001*a.ph.hearing,immune:.008*a.ph.immune,healing:.006*a.traits.regen,insulation:.004*a.traits.thermal,repro:.005*a.ph.womb+.0025*a.ph.seed,brain:.4*a.brainCost,genes:a.geneUpkeep}},
    deeds:{shared:a.shared,stolen:a.stolen,attacks:a.attacks,kills:a.kills,hunts:a.hunts,beastKills:a.beastKills,crafts:a.crafts,deposits:a.deposits,builds:a.builds},
    actionCounts:Array.from(a.actionCounts),owed:[...a.owed].sort((x,y)=>y[1]-x[1]).slice(0,6).map(([id,v])=>[nm(id)||('#'+id),v]),inWater:a.inWater,drv:a.drv,rep:repOf(a.id),admirers:agents.filter(x=>(x.trust.get(a.id)||0)>.5).length,affectionGot:a.affectionGot,said:a.saidLog.slice().reverse(),speaking:a.utter.length?(a.utterShout?'!':'')+a.utter.map(i=>SYMS[i]).join(''):'',heardNow:SYMS.filter((c,i)=>a.heard[i]>.3).join(''),coparent:a.coparent,partners:a.partners,wellbeing:a.phi,rewardAvg:a.lastReward||0,curiosityGain:a.lastBonus||0,memory:a.memory,memA:a.memA,memB:a.memB,signal:a.signal,pain:a.pain});
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
  if (viewing){
    if (now-lastFrame>=frameGap){ postFrame(); lastFrame=now; }
    if (inspecting&&selected&&now-lastInspect>=(maxMode?300:140)){ postInspect(); lastInspect=now; }
    if (now-lastStats>=700){ postStats(true); lastStats=now; sendPher=true; }
  }
  if (now-lastPulse>=1000){ postPulse(); lastPulse=now; }
  schedule(!busy);
}
// ---------- insights ----------
// Who each social act was aimed at, from the actor's point of view just before acting.
const REL=['kin','friend','stranger','enemy'], RACT={13:'share',14:'attack',19:'thank',20:'befriend'};
const relTally={share:[0,0,0,0],attack:[0,0,0,0],thank:[0,0,0,0],befriend:[0,0,0,0]};
let relWin={share:[0,0,0,0],attack:[0,0,0,0],thank:[0,0,0,0],befriend:[0,0,0,0]};
function relOf(a,o){ if (kinship(a,o)>=.5) return 0; const t=a.trust.get(o.id)||0; return t>.25?1:t<-.2?3:2; }

// ---------- islands ----------
// Several worlds run in parallel workers. Every so often an island sends a few of its most successful yips
// (children raised plus age) to another island, where they arrive together as a band.
let island=0, viewing=true;
function exportMigrants(){
  const n=Math.min(settings.migrants|0,Math.floor(agents.length/10)); if (n<1) return;
  const ranked=agents.filter(a=>a.age>300).sort((x,y)=>(y.kids*400+y.age)-(x.kids*400+x.age)).slice(0,n);
  if (!ranked.length) return;
  const pack=ranked.map(serAgent);
  for (const a of ranked) worldE-=yipE(a);   // their energy leaves with them
  for (const a of ranked){ onDeath(a); a.dead=true; }   // they leave this island
  agents=agents.filter(a=>!a.dead);
  log(`${ranked.length} yips left for another island`,'info');
  self.postMessage({type:'emigrants',from:island,pack});
}
function importMigrants(pack,from){
  if (!pack.length||agents.length>=settings.popCap) return;
  const [bx,by]=spawnPoint(fert,1), band=[];
  for (const o of pack){
    o.id=nextId++; o.trust=[]; o.owed=[]; o.parent=null; o.coparent=null;
    const a=deAgent(o); a.x=wrapX(bx+rnd(-25,25)); a.y=wrapY(by+rnd(-25,25)); if (isWater(a.x,a.y)){ a.x=bx; a.y=by; }
    a.lastBirth=ticks-150; a.origin=from; a.history=[]; band.push(a); agents.push(a); worldE+=yipE(a);
  }
  for (const p of band) for (const q of band) if (p!==q) setTrust(p,q.id,.35);
  log(`${band.length} yips arrived from island ${'ABCD'[from]||from+1}: ${band.map(a=>a.name).join(', ')}`,'birth');
  if (viewing) toast(`${band.length} migrants arrived from island ${'ABCD'[from]||from+1}`,'birth');
}
function postPulse(){
  self.postMessage({type:'pulse',island,ticks,tps,pop:agents.length,maxGen,avgGen:avg(a=>a.gen),births,deaths,running});
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
    case 'init': if (!started){ island=m.island||0; nextGene=island*10000000+1; viewing=m.view!==false; if (m.settings) Object.assign(settings,m.settings); started=true; reset(m.shape); if (viewing){ postFrame(); postStats(true); } } break;
    case 'view': viewing=m.on; if (viewing){ postMeta(); postFrame(); postStats(true); if (selected) postInspect(); } break;
    case 'immigrants': importMigrants(m.pack,m.from); break;
    case 'library': self.postMessage({type:'libraryPack',pack:libraryPack(m),req:m.req}); break;
    case 'reset': reset(m.shape||shape,m.seeds); started=true; if (viewing){ postFrame(); postStats(true); self.postMessage({type:'selected',id:0}); } break;
    case 'storm': sendStorm(); break;
    case 'cold': settings.temperature=clamp(settings.temperature-12,-20,50); log('Cold snap: average temperature down 12°C','cold'); postStats(false); break;
    case 'heat': settings.temperature=clamp(settings.temperature+12,-20,50); log('Heatwave: average temperature up 12°C','heat'); postStats(false); break;
    case 'bloom': { let n=0; for (let i=0;i<220&&takeReserve(FOOD_E);i++){ if (addItem('food')) n++; else reserve+=FOOD_E; } log(`Food bloom: ${n} food grown from the wild reserve`,'food'); break; }
    case 'select': selected=m.id||0; if (selected) postInspect(); break;
    case 'inspect': inspecting=m.on; break;
    case 'pick': pickAgent(m.how); break;
    case 'paint': {
      const {x,y,k,r=20,n=1}=m;
      if (k==='erase'){ for (const it of items) if (wdistXY(it.x,it.y,x,y)<=r){ it.dead=true; lose(itemE(it)); } buildings=buildings.filter(b=>wdistXY(b.x,b.y,x,y)>r); beasts=beasts.filter(z=>wdistXY(z.x,z.y,x,y)>r); }
      else if (k==='fire'){ if (!occupied(x,y,12,'fire')) placeBuilding('fire',x,y,null); }
      else if (k==='beast'){ if (beasts.length<40&&takeReserve(BEAST_E)) spawnBeast(x,y); }
      else if (k==='wall'){ const ang=m.ang||0; if (!occupied(x,y,15,'wall')) placeBuilding('wall',x,y,null,ang); }
      else { const cnt=Math.round((k==='food'?12:4)*n*(r/20)), ie=k==='food'?FOOD_E:k==='tree'?WOOD_E:0; for (let i=0;i<cnt;i++){ if (ie&&!takeReserve(ie)) break; const t=rnd(0,6.283), d=Math.sqrt(Math.random())*r; if (!addItem(k,x+Math.cos(t)*d,y+Math.sin(t)*d)) reserve+=ie; } }
      break;
    }
    case 'save': self.postMessage({type:'saved',state:JSON.stringify(serialize()),ticks,purpose:m.purpose}); break;
    case 'load': try { started=true; deserialize(typeof m.state==='string'?JSON.parse(m.state):m.state); postFrame(); postStats(true); self.postMessage({type:'loaded',ok:true,settings}); } catch(err){ self.postMessage({type:'loaded',ok:false,error:err.message}); } break;
  }
};
self.postMessage({type:'ready'}); work();
