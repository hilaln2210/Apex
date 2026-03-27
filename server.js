// server.js — APEX v3 Proxy (Fixed for real Finviz data)
// npm install express cors ws
// node server.js --finviz=TOKEN --polygon=TOKEN --finnhub=TOKEN
const express=require('express'),cors=require('cors'),http=require('http'),{WebSocketServer}=require('ws');
const app=express(),server=http.createServer(app),wss=new WebSocketServer({server}),PORT=4000;
const arg=n=>process.env[n.toUpperCase()]||(process.argv.find(a=>a.startsWith(`--${n}=`))||'').split('=')[1]||'';
const FV=arg('finviz'),PO=arg('polygon'),FH=arg('finnhub');
app.use(cors());app.use(express.json());app.use(express.static(__dirname));
const CACHE=new Map();
function cache(k,ttl,fn){const h=CACHE.get(k);if(h&&Date.now()-h.ts<ttl)return Promise.resolve(h.data);return fn().then(d=>{if(d&&(Array.isArray(d)?d.length>0:true))CACHE.set(k,{ts:Date.now(),data:d});return d;}).catch(e=>{if(h)return h.data;throw e;});}
function parseCSV(t){const ls=t.trim().split('\n');if(ls.length<2)return[];const hs=ls[0].split(',').map(h=>h.replace(/"/g,'').trim());return ls.slice(1).map(l=>{const vs=[];let c='',q=false;for(const ch of l){if(ch==='"'){q=!q;continue;}if(ch===','&&!q){vs.push(c.trim());c='';continue;}c+=ch;}vs.push(c.trim());const o={};hs.forEach((h,i)=>o[h]=vs[i]??'');return o;});}

// Finviz returns different columns per view. We fetch v=111 (overview) + v=171 (technical) + v=141 (performance) and merge by ticker
function fvBase(f,v){const p=new URLSearchParams({v:String(v),f});if(FV)p.append('auth',FV);return`https://elite.finviz.com/export.ashx?${p}`;}
const FILTERS={
  momentum:'sh_avgvol_o200,ta_change_u,ta_rsi_nos60',
  value:'fa_pb_u1,fa_peg_u1,sh_avgvol_o100',
  rsi:'ta_rsi_nos30,sh_avgvol_o200',
  breakout:'ta_highlow52w_nh,sh_avgvol_o200'
};

async function fetchMerged(filter){
  const hdr={headers:{'User-Agent':'Mozilla/5.0'}};
  // v=111: Ticker,Company,Sector,Industry,Country,Market Cap,P/E,Price,Change,Volume
  // v=171: Ticker,Beta,ATR,SMA20,SMA50,SMA200,52W High,52W Low,RSI(14),Price,Change,Change from Open,Gap,Volume
  // v=141: Ticker,Perf Week...,Volatility Week/Month,Average Volume,Relative Volume,Price,Change,Volume
  const [r1,r2,r3]=await Promise.all([
    fetch(fvBase(filter,'111'),hdr).then(r=>r.text()),
    fetch(fvBase(filter,'171'),hdr).then(r=>r.text()),
    fetch(fvBase(filter,'141'),hdr).then(r=>r.text()),
  ]);
  const d1=parseCSV(r1), d2=parseCSV(r2), d3=parseCSV(r3);
  // Index by ticker
  const m2=new Map(), m3=new Map();
  d2.forEach(r=>m2.set(r['Ticker'],r));
  d3.forEach(r=>m3.set(r['Ticker'],r));
  return d1.map(r=>{
    const sym=r['Ticker'];
    const tech=m2.get(sym)||{};
    const perf=m3.get(sym)||{};
    return normMerged(r,tech,perf);
  }).filter(s=>s.sym);
}

function normMerged(ov,tech,perf){
  const sym=ov['Ticker']||'';
  const ch=parseFloat((ov['Change']||'0').replace('%',''))||0;
  const px=parseFloat(ov['Price']||'0')||0;
  const vol=parseInt((ov['Volume']||'0').replace(/,/g,''))||0;
  const avgVol=parseFloat((perf['Average Volume']||'0').replace(/,/g,''))*1000||1;
  const relVol=parseFloat(perf['Relative Volume']||'0')||0;
  const rsi=parseFloat(tech['Relative Strength Index (14)']||'0')||0;
  const beta=tech['Beta']||'—';
  const high52=tech['52-Week High']||tech['52W High']||'—';
  const low52=tech['52-Week Low']||tech['52W Low']||'—';
  const gap=parseFloat((tech['Gap']||'0').replace('%',''))||0;
  const volRatio=relVol>0?relVol:(avgVol>0?(vol/avgVol):1);

  let sc=50;
  if(ch>0)sc+=Math.min(ch*3,20);
  if(volRatio>1)sc+=Math.min((volRatio-1)*5,15);
  if(rsi>50&&rsi<70)sc+=10;
  if(rsi<35)sc+=8;
  sc=Math.min(Math.round(sc),99);

  return {
    sym, name:ov['Company']||'', px, ch, rsi, score:sc,
    vol: relVol>0?relVol.toFixed(1)+'x':(avgVol>0?(vol/avgVol).toFixed(1)+'x':'1.0x'),
    sector:ov['Sector']||'', industry:ov['Industry']||'',
    cap:ov['Market Cap']||'', pe:ov['P/E']||'—',
    eps:'—', beta, high52, low52, gap,
    macd:ch>1?'positive':ch<-1?'negative':'neutral',
    note:ov['Industry']||ov['Sector']||''
  };
}

app.get('/api/screener/:p',async(req,res)=>{
  const p=req.params.p;
  if(!FV)return res.status(401).json({ok:false,error:'No Finviz token'});
  if(!FILTERS[p])return res.status(400).json({ok:false,error:'Unknown preset'});
  try{
    const d=await cache(p,60000,()=>fetchMerged(FILTERS[p]));
    res.json({ok:true,data:d,count:d.length});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post('/api/extended/batch',async(req,res)=>{if(!PO)return res.status(401).json({ok:false,error:'No Polygon token'});const{symbols}=req.body;if(!symbols?.length)return res.json({ok:true,data:{}});try{const d=await cache('poly-'+symbols.join(','),30000,async()=>{const r=await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${symbols.join(',')}&apiKey=${PO}`).then(r=>r.json());const out={};for(const t of(r.tickers||[])){const day=t.day||{};out[t.ticker]={preMarket:t.prevDay?.o||0,afterHours:t.lastTrade?.p||day.c||0,bid:t.lastQuote?.p||0,ask:t.lastQuote?.P||0,vwap:day.vw||0};}return out;});res.json({ok:true,data:d});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.get('/api/news/market',async(req,res)=>{if(!FH)return res.status(401).json({ok:false,error:'No Finnhub token'});try{const d=await cache('fh-news',120000,async()=>{const r=await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FH}`).then(r=>r.json());return(r||[]).slice(0,20).map(n=>({id:n.id,headline:n.headline,summary:n.summary,source:n.source,url:n.url,ts:n.datetime*1000,related:n.related||''}));});res.json({ok:true,data:d});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.get('/api/news/:sym',async(req,res)=>{if(!FH)return res.status(401).json({ok:false,error:'No Finnhub token'});const sym=req.params.sym;const to=new Date().toISOString().split('T')[0],fr=new Date(Date.now()-7*86400000).toISOString().split('T')[0];try{const d=await cache('fh-'+sym,120000,async()=>{const r=await fetch(`https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${fr}&to=${to}&token=${FH}`).then(r=>r.json());return(r||[]).slice(0,8).map(n=>({headline:n.headline,summary:n.summary?.slice(0,200),source:n.source,url:n.url,ts:n.datetime*1000}));});res.json({ok:true,data:d});}catch(e){res.status(500).json({ok:false,error:e.message});}});
const wsClients=new Set();wss.on('connection',ws=>{wsClients.add(ws);ws.on('close',()=>wsClients.delete(ws));});
let lastIds=new Set();setInterval(async()=>{if(!FH||!wsClients.size)return;try{const r=await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FH}`).then(r=>r.json());const nw=(r||[]).filter(n=>!lastIds.has(n.id));if(nw.length){nw.forEach(n=>lastIds.add(n.id));const p=JSON.stringify({type:'news',items:nw.slice(0,5).map(n=>({id:n.id,headline:n.headline,source:n.source,ts:n.datetime*1000,related:n.related||''}))});wsClients.forEach(ws=>ws.send(p));}}catch(_){}},120000);
app.get('/api/status',(req,res)=>res.json({ok:true,apis:{finviz:!!FV,polygon:!!PO,finnhub:!!FH},time:new Date().toISOString()}));
server.listen(PORT,()=>console.log(`APEX v3 Proxy → http://localhost:${PORT}\nFinviz:${FV?'✅':'❌'} Polygon:${PO?'✅':'❌'} Finnhub:${FH?'✅':'❌'}`));
