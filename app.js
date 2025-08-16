// WeerFOMO – client JS
const qs = s => document.querySelector(s);
const qsa = s => [...document.querySelectorAll(s)];

const state = {
  lat: null, lon: null, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  daily: null, climate: null, place: null
};

// Install prompt
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault(); deferredPrompt = e;
  const btn = qs('#install');
  btn.style.display = 'inline-flex';
  btn.onclick = async () => { if(!deferredPrompt) return; deferredPrompt.prompt(); };
});

// Register SW
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js');
}

qs('#use-gps').addEventListener('click', () => {
  if(!navigator.geolocation){ alert('Geen geolocatie beschikbaar.'); return; }
  navigator.geolocation.getCurrentPosition(async pos => {
    state.lat = pos.coords.latitude; state.lon = pos.coords.longitude;
    await loadAll();
  }, err => alert('Locatie geweigerd of mislukt. Je kunt ook een adres delen via WhatsApp.'));
});

qs('#share-btn').addEventListener('click', async () => {
  const url = location.href;
  const text = `Check jouw WeerFOMO plannen met WeerFOMO: ${state.place?state.place+' – ':''}${url}`;
  if(navigator.share){
    try{ await navigator.share({title:'WeerFOMO', text, url}); } catch(e){}
  }else{
    const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
    location.href = wa;
  }
});

async function loadAll(){
  qs('#headline').textContent = 'Data ophalen…';
  const revGeo = await reverseGeocode(state.lat, state.lon).catch(()=>null);
  state.place = revGeo?.city || revGeo?.name || revGeo?.county || revGeo?.country || 'jouw locatie';

  const daily = await fetchDaily(state.lat, state.lon, state.tz);
  state.daily = daily;
  const month = (new Date()).getMonth()+1;
  state.climate = await fetchClimate(state.lat, state.lon, month).catch(()=>null);

  render();
}

function fmtDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday:'short', day:'2-digit', month:'2-digit'});
}

function weekend(d){
  const dt = new Date(d);
  const w = dt.getDay(); // 0=Sun, 6=Sat
  return w===0 || w===6;
}

function eveningHour(tsIso){
  const d = new Date(tsIso);
  const h = d.getHours();
  return h>=18 && h<=23;
}

// Heuristics for scores [0..100]
function computeScores(day, idx){
  const tmax = day.temperature_2m_max;
  const tmin = day.temperature_2m_min;
  const rain = day.precipitation_sum;
  const rainHours = day.precipitation_hours ?? (rain>0 ? 3 : 0);
  const wind = day.wind_speed_10m_max ?? 10;
  const uv = day.uv_index_max ?? 4;
  const isWeekend = weekend(day.time);
  const dow = (new Date(day.time)).getDay();

  // BBQ: likes warm, sunny, low wind, weekend
  let bbq = 0;
  bbq += scale(tmax, 18, 30)*40;
  bbq += (1-scale(rain, 0, 4))*25;
  bbq += (1-scale(wind, 0, 8))*15;
  bbq += scale(uv, 3, 7)*10;
  bbq += isWeekend ? 10 : 0;

  // Fiets: dry, moderate wind, 10–25°C, focus Mon–Fri (1..5)
  let fiets = 0;
  fiets += (1-scale(rain, 0, 2))*35;
  fiets +=  (1-Math.abs(norm(tmax, 10, 25)))*35; // peak at ~18°C
  fiets += (1-Math.abs(norm(wind, 5, 20)))*20;   // ok until ~20 km/h
  fiets += (dow>=1 && dow<=5) ? 10 : 0;

  // LAN: higher when outside is poor
  let lan = 0;
  lan += scale(rain, 0, 10)*35;
  lan += scale(rainHours, 0, 8)*20;
  lan += scale(wind, 12, 25)*15;
  lan += (tmax<12 ? 15 : 0);
  lan += isWeekend ? 15 : 0;

  // Poker: meh weather, evenings indoors; weekend bias
  let poker = 0;
  poker += clamp( (scale(rain, 0, 3)*20) + ((tmax>=12 && tmax<=20)?20:10), 0, 40);
  poker += (wind>18 ? 10 : 0);
  poker += isWeekend ? 20 : 10;
  poker += 10; // social bias

  const scores = { bbq:Math.round(bbq), fiets:Math.round(fiets), lan:Math.round(lan), poker:Math.round(poker) };
  // Decide stamp: only if a clear winner above threshold
  const entries = Object.entries(scores).sort((a,b)=>b[1]-a[1]);
  const [winner, wscore] = entries[0];
  const second = entries[1][1];
  const margin = wscore-second;
  const threshold = isWeekend ? 55 : 50;
  const stamp = (wscore>=threshold && margin>=8) ? winner : null;
  return {scores, stamp};
}

function scale(x, a, b){ // 0..1
  const v = (x-a)/(b-a); return clamp(v, 0, 1);
}
function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }
function norm(x, mid, spread){ // returns -1..1
  const v = (x-mid)/spread;
  return clamp(v, -1, 1);
}

function detailLines(day){
  return [
    ['Max', `${Math.round(day.temperature_2m_max)}°C`],
    ['Neerslag', `${(day.precipitation_sum||0).toFixed(1)} mm`],
    ['Wind', `${Math.round(day.wind_speed_10m_max||0)} km/u`],
    ['UV max', `${Math.round(day.uv_index_max||0)}`]
  ];
}

function render(){
  qs('#headline').textContent = `Beste plannen voor ${state.place}`;
  qs('#subline').textContent = `14-daagse verwachting met activiteit-score. Niet elke dag krijgt een stempel; alleen als het duidelijk is.`;

  const host = qs('#forecast');
  host.innerHTML='';

  const days = state.daily;
  days.time.forEach((iso, i)=>{
    const day = {
      time: iso,
      temperature_2m_max: days.temperature_2m_max[i],
      temperature_2m_min: days.temperature_2m_min[i],
      precipitation_sum: days.precipitation_sum[i],
      precipitation_hours: days.precipitation_hours?.[i],
      uv_index_max: days.uv_index_max?.[i],
      wind_speed_10m_max: days.wind_speed_10m_max?.[i]
    };
    const {scores, stamp} = computeScores(day, i);

    const card = document.createElement('div');
    card.className='card';
    const dlabel = fmtDate(iso);
    const badge = stamp ? `<span class="badge ${stamp}">${labelFor(stamp)}</span>` : `<span class="badge">—</span>`;
    card.innerHTML = `
      <div class="dayhead">
        <div><strong>${dlabel}</strong></div>
        ${badge}
      </div>
      <div class="scorebar"><div style="width:${Math.max(...Object.values(scores))}%"></div></div>
      <div class="kv">${detailLines(day).map(([k,v])=>`<div>${k}</div><div>${v}</div>`).join('')}</div>
      <div class="kv" style="margin-top:8px">
        <div>BBQ 🔥</div><div>${scores.bbq}</div>
        <div>Fiets 🚴</div><div>${scores.fiets}</div>
        <div>LAN 🖥️</div><div>${scores.lan}</div>
        <div>Poker ♠️</div><div>${scores.poker}</div>
      </div>
    `;
    host.appendChild(card);
  });

  renderClimate();
  renderHolidayTip();
}

function labelFor(kind){
  switch(kind){
    case 'bbq': return 'BBQ-weer 🔥';
    case 'fiets': return 'Fietsweer 🚴';
    case 'lan': return 'LAN-party 🎮🖥️';
    case 'poker': return 'Poker-avond ♠️';
    default: return '—';
  }
}

// Open-Meteo
async function fetchDaily(lat, lon, tz){
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('timezone', tz);
  url.searchParams.set('forecast_days', 14);
  url.searchParams.set('daily', [
    'temperature_2m_max',
    'temperature_2m_min',
    'uv_index_max',
    'precipitation_sum',
    'precipitation_hours',
    'wind_speed_10m_max'
  ].join(','));
  const res = await fetch(url.toString());
  if(!res.ok) throw new Error('Weer ophalen mislukt');
  const js = await res.json();
  return js.daily;
}

async function fetchClimate(lat, lon, month){
  const url = new URL('https://climate-api.open-meteo.com/v1/climate');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('month', month); // 1..12
  url.searchParams.set('start_year', 1991);
  url.searchParams.set('end_year', 2020);
  url.searchParams.set('models','ERA5');
  url.searchParams.set('daily', ['temperature_2m_mean','precipitation_sum','wind_speed_10m_mean'].join(','));
  const res = await fetch(url.toString());
  if(!res.ok) throw new Error('Klimaatdata ophalen mislukt');
  const js = await res.json();
  // Summarize month mean
  const t = avg(js.daily.temperature_2m_mean);
  const p = avg(js.daily.precipitation_sum);
  const w = avg(js.daily.wind_speed_10m_mean);
  return { t, p, w, month };
}

function avg(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }

function renderClimate(){
  const el = qs('#climate-kv');
  if(!state.climate){ el.innerHTML = '<div>—</div><div>Geen data</div>'; return; }
  const m = state.climate.month;
  const monthName = new Date(2000, m-1, 1).toLocaleDateString(undefined, {month:'long'});
  el.innerHTML = `
    <div>Locatie</div><div>${state.place}</div>
    <div>Maand</div><div>${monthName}</div>
    <div>Gem. temp</div><div>${state.climate.t.toFixed(1)}°C</div>
    <div>Gem. neerslag/dag</div><div>${state.climate.p.toFixed(1)} mm</div>
    <div>Gem. wind</div><div>${state.climate.w.toFixed(1)} km/u</div>
  `;
}

// Simple reverse geocode via Open-Meteo geocoding (no key)
async function reverseGeocode(lat, lon){
  const url = `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${lat}&longitude=${lon}&language=nl`;
  const r = await fetch(url);
  if(!r.ok) return null;
  const j = await r.json();
  return j.results?.[0] || null;
}

// Fun extras: NL holidays + jokes
function renderHolidayTip(){
  const tip = qs('#holiday-tip');
  const today = new Date();
  const mmdd = (d)=> `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  const specials = {
    '01-01': 'Nieuwjaarsdag 🥳 – perfecte LAN reset & oliebollen leftovers.',
    '04-27': 'Koningsdag 🇳🇱 – BBQ met oranje tompouce?',
    '05-05': 'Bevrijdingsdag 🎉 – Vrijheid om te grillen!',
    '12-05': 'Sinterklaas 🎁 – LAN met pepernoten of Poker met chocoladeletters.',
    '12-24': 'Kerstavond 🎄 – gourmet is ook BBQ, toch?',
    '12-31': 'Oudjaarsavond 🎆 – high score op oliebollen-BBQ.'
  };
  const key = mmdd(today);
  tip.textContent = specials[key] || 'Tip: weekend → BBQ/LAN/Poker focus, doordeweeks → fiets. Volg de stempels.';
}

// Auto-try GPS once on first load (soft ask)
setTimeout(()=>{
  // Only if not yet set and on mobile
  if(state.lat==null && /Mobi|Android/i.test(navigator.userAgent)){
    // No auto prompt here—leave to user click for privacy UX
  }
}, 1200);
