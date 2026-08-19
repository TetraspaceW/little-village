/* time.js — the village calendar: hours, days, seasons and weather.

   A monsoon climate on a 120-day year, thirty days to a season. The calendar
   persists between sessions, and a fresh village starts on a random day, so you
   are as likely to arrive in a blizzard as in high summer. */
window.LG = window.LG || {};

LG.time = (function () {
  const SEASON_DAYS = 30;
  const YEAR_DAYS = SEASON_DAYS * 4;
  let dayMs = 6 * 60 * 1000;          // real milliseconds per village day

  const SEASONS = [
    { id: 'winter', name: 'Winter', wash: ['#cfe0f2', 0.22], warmth: 'cold and dry',
      note: 'The cold is dry and hard, and the blizzards come without much warning.' },
    { id: 'spring', name: 'Spring', wash: ['#e6ecb4', 0.10], warmth: 'mild',
      note: 'Spring is over almost before it starts, and the wind carries sand off the flats.' },
    { id: 'summer', name: 'Summer', wash: ['#ffe6a0', 0.11], warmth: 'hot and humid',
      note: 'The heat is heavy and wet; the rains come in earnest and stay for days.' },
    { id: 'autumn', name: 'Autumn', wash: ['#dfa45e', 0.16], warmth: 'cooling',
      note: 'Autumn is brief and cools steadily, a little more each morning.' }
  ];

  /* Weather the villagers can actually feel. `talk` is what goes into their
     prompt, so it reads as description rather than a label. */
  const WEATHER = {
    clear:     { name: 'clear',      talk: 'a clear sky', particles: null },
    cloud:     { name: 'overcast',   talk: 'a low grey overcast', particles: null, dim: 0.10 },
    fog:       { name: 'fog',        talk: 'thick fog that swallows the far side of the village',
                 particles: 'fog', dim: 0.16 },
    drizzle:   { name: 'drizzle',    talk: 'a thin cold drizzle', particles: 'rain', dim: 0.12, rate: 0.4 },
    rain:      { name: 'rain',       talk: 'steady rain', particles: 'rain', dim: 0.20, rate: 1 },
    monsoon:   { name: 'monsoon rain', talk: 'monsoon rain coming down in sheets',
                 particles: 'rain', dim: 0.30, rate: 2.2 },
    storm:     { name: 'thunderstorm', talk: 'a thunderstorm, with rain and lightning',
                 particles: 'rain', dim: 0.34, rate: 1.8, lightning: true },
    humid:     { name: 'heavy air',  talk: 'still, heavy, humid air', particles: 'haze', dim: 0.08 },
    blizzard:  { name: 'blizzard',   talk: 'a blizzard — driving snow and no visibility',
                 particles: 'snow', dim: 0.40, rate: 3.2, wind: 2.2, whiteout: true },
    snow:      { name: 'snow',       talk: 'quiet falling snow', particles: 'snow', dim: 0.12, rate: 0.8 },
    frost:     { name: 'hard frost', talk: 'a hard dry frost', particles: null, dim: 0.06 },
    sandstorm: { name: 'sandstorm',  talk: 'a sandstorm blowing in off the flats',
                 particles: 'sand', dim: 0.30, rate: 2, wind: 2.4 },
    wind:      { name: 'high wind',  talk: 'a hard dry wind', particles: 'sand', dim: 0.10, rate: 0.5, wind: 1.8 }
  };

  // what each season is likely to throw at you
  const CLIMATE = {
    winter: [['clear', 4], ['frost', 4], ['cloud', 3], ['snow', 3], ['blizzard', 2], ['fog', 1]],
    spring: [['clear', 5], ['wind', 3], ['sandstorm', 3], ['cloud', 2], ['drizzle', 2]],
    summer: [['humid', 5], ['monsoon', 4], ['storm', 3], ['cloud', 2], ['clear', 2], ['rain', 3]],
    autumn: [['cloud', 4], ['drizzle', 3], ['clear', 3], ['fog', 3], ['rain', 2], ['wind', 2]]
  };

  const PHASES = [
    { at: 0.00, id: 'night',     name: 'the small hours' },
    { at: 0.22, id: 'dawn',      name: 'first light' },
    { at: 0.30, id: 'morning',   name: 'the morning' },
    { at: 0.46, id: 'midday',    name: 'the middle of the day' },
    { at: 0.60, id: 'afternoon', name: 'the afternoon' },
    { at: 0.74, id: 'dusk',      name: 'dusk' },
    { at: 0.84, id: 'night',     name: 'the night' }
  ];

  let day = 0;          // days since the village was founded
  let frac = 0.35;      // where we are in the day, 0..1
  let weather = 'clear';
  let weatherLeft = 0.2;

  function seasonIndex(d) { return Math.floor((d % YEAR_DAYS) / SEASON_DAYS); }
  function season() { return SEASONS[seasonIndex(day)]; }
  function dayOfSeason() { return (day % SEASON_DAYS) + 1; }
  function phase() {
    let p = PHASES[0];
    for (const q of PHASES) if (frac >= q.at) p = q;
    return p;
  }
  function isNight() { const id = phase().id; return id === 'night'; }
  function clock() {
    const mins = Math.floor(frac * 24 * 60);
    const h = Math.floor(mins / 60), m = mins % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function pickWeather() {
    const table = CLIMATE[season().id];
    let total = 0;
    table.forEach(([, w]) => total += w);
    let r = Math.random() * total;
    for (const [id, w] of table) { r -= w; if (r <= 0) return id; }
    return table[0][0];
  }

  /* Weather sits for a good part of a day — two or three turns of the sky is
     plenty, and more than that just churns. */
  function setWeather(id, hold) {
    weather = WEATHER[id] ? id : 'clear';
    weatherLeft = (typeof hold === 'number') ? hold : 0.22 + Math.random() * 0.4;
  }

  /* dt in seconds */
  function tick(dt) {
    const before = day;
    frac += (dt * 1000) / dayMs;
    while (frac >= 1) { frac -= 1; day++; }
    weatherLeft -= (dt * 1000) / dayMs;
    if (weatherLeft <= 0) setWeather(pickWeather());
    return day !== before;                        // a new day began
  }

  function start(d, f) {
    day = (typeof d === 'number' && isFinite(d)) ? d : Math.floor(Math.random() * YEAR_DAYS);
    frac = (typeof f === 'number' && isFinite(f)) ? f : 0.35;
    setWeather(pickWeather());
  }

  /* One line for a villager's prompt, so they have something to remark on. */
  function describe() {
    const s = season(), w = WEATHER[weather];
    return 'It is ' + phase().name + ' on day ' + dayOfSeason() + ' of ' + s.name +
           '. The weather is ' + s.warmth + ': ' + w.talk + '. ' + s.note;
  }

  /* A short label for the HUD. */
  function label() {
    return season().name + ' ' + dayOfSeason() + ' · ' + clock() + ' · ' + WEATHER[weather].name;
  }

  return {
    SEASONS, WEATHER, CLIMATE, SEASON_DAYS, YEAR_DAYS, PHASES,
    start, tick, describe, label, clock, phase, isNight, season, dayOfSeason,
    setWeather, pickWeather,
    get day() { return day; },
    get frac() { return frac; },
    get weather() { return weather; },
    get info() { return WEATHER[weather]; },
    set dayLength(ms) { if (ms > 1000) dayMs = ms; },
    get dayLength() { return dayMs; }
  };
})();
