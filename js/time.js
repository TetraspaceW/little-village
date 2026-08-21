/* time.js — the village calendar: hours, days, seasons and weather.

   A monsoon climate on a 120-day year, thirty days to a season. The calendar is
   rolled with the village — a village is a fresh arrival on a random day of the
   year, so you are as likely to turn up in a blizzard as in high summer — and
   then kept with it: `start`, `setWeather` and `setSnow` take the day, the hour,
   the sky and the snow lying back off a save, so coming back to a village is
   coming back to the afternoon you left it in rather than to a new one. */
window.LG = window.LG || {};

LG.time = (function () {
  const SEASON_DAYS = 30;
  const YEAR_DAYS = SEASON_DAYS * 4;
  let dayMs = 6 * 60 * 1000;          // real milliseconds per village day

  /* Seasons do not tint the screen. A wash that is always on is a wash you stop
     seeing, and it costs you the actual colours of the village all day long —
     the hour is allowed to colour the world because it changes; the season is
     told, not shown. `tone` is only the colour weather gloom takes on. */
  const SEASONS = [
    { id: 'winter', name: 'Winter', tone: '#b9c8de', warmth: 'cold and dry',
      note: 'The cold is dry and hard, and the blizzards come without much warning.' },
    { id: 'spring', name: 'Spring', tone: '#c9a86a', warmth: 'mild',
      note: 'Spring is over almost before it starts, and the wind carries sand off the flats.' },
    { id: 'summer', name: 'Summer', tone: '#5d6472', warmth: 'hot and humid',
      note: 'The heat is heavy and wet; the rains come in earnest and stay for days.' },
    { id: 'autumn', name: 'Autumn', tone: '#5d6472', warmth: 'cooling',
      note: 'Autumn is brief and cools steadily, a little more each morning.' }
  ];

  /* Weather the villagers can actually feel. `talk` is what goes into their
     prompt, so it reads as description rather than a label. */
  /* `dim` is a grey laid over the whole screen, so it is kept for the four kinds
     of weather that genuinely take the light away. Everything else is legible
     from its particles alone — you can see that it is snowing without the
     village being greyed out to tell you. `indoors` is what actually drives the
     villagers under a roof, and is deliberately a separate knob: drizzle is
     miserable to stand in without darkening the sky. */
  const WEATHER = {
    clear:     { name: 'clear',      talk: 'a clear sky', particles: null },
    cloud:     { name: 'overcast',   talk: 'a low grey overcast', particles: null },
    fog:       { name: 'fog',        talk: 'thick fog that swallows the far side of the village',
                 particles: 'fog', dim: 0.14 },
    drizzle:   { name: 'drizzle',    talk: 'a thin cold drizzle', particles: 'rain', rate: 0.4, indoors: true },
    rain:      { name: 'rain',       talk: 'steady rain', particles: 'rain', rate: 1, indoors: true },
    monsoon:   { name: 'monsoon rain', talk: 'monsoon rain coming down in sheets',
                 particles: 'rain', dim: 0.26, rate: 2.2, indoors: true },
    storm:     { name: 'thunderstorm', talk: 'a thunderstorm, with rain and lightning',
                 particles: 'rain', dim: 0.30, rate: 1.8, lightning: true, indoors: true },
    humid:     { name: 'heavy air',  talk: 'still, heavy, humid air', particles: 'haze' },
    blizzard:  { name: 'blizzard',   talk: 'a blizzard — driving snow and no visibility',
                 particles: 'snow', dim: 0.34, rate: 3.2, wind: 2.2, whiteout: true, indoors: true },
    snow:      { name: 'snow',       talk: 'quiet falling snow', particles: 'snow', rate: 0.8, indoors: true },
    frost:     { name: 'hard frost', talk: 'a hard dry frost', particles: null },
    sandstorm: { name: 'sandstorm',  talk: 'a sandstorm blowing in off the flats',
                 particles: 'sand', dim: 0.26, rate: 2, wind: 2.4, indoors: true },
    wind:      { name: 'high wind',  talk: 'a hard dry wind', particles: 'sand', rate: 0.5, wind: 1.8 }
  };

  // what each season is likely to throw at you
  const CLIMATE = {
    winter: [['clear', 6], ['frost', 4], ['cloud', 3], ['snow', 3], ['blizzard', 2], ['fog', 1]],
    spring: [['clear', 6], ['wind', 3], ['sandstorm', 2], ['cloud', 2], ['drizzle', 2]],
    summer: [['humid', 5], ['clear', 4], ['monsoon', 3], ['storm', 2], ['cloud', 2], ['rain', 3]],
    autumn: [['cloud', 4], ['clear', 5], ['drizzle', 3], ['fog', 2], ['rain', 2], ['wind', 2]]
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

  /* How much snow is lying, 0..1. The weather is what is falling; this is what
     is left on the ground afterwards, and it is the half you can still see an
     hour after the sky clears. It builds while snow falls and melts at a rate
     the season sets — in a hard frost it does not melt at all, which is why a
     winter can stay white through several changes of weather. */
  let lying = 0;
  const MELT = { winter: 0.5, spring: 2.5, summer: 8, autumn: 3 };   // per village day

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
    const days = (dt * 1000) / dayMs;             // how much of a village day passed
    frac += days;
    while (frac >= 1) { frac -= 1; day++; }
    weatherLeft -= days;
    if (weatherLeft <= 0) setWeather(pickWeather());
    const w = WEATHER[weather];
    if (w.particles === 'snow') lying = Math.min(1, lying + days * 4 * (w.rate || 1));
    else if (weather !== 'frost') lying = Math.max(0, lying - days * (MELT[season().id] || 3));
    return day !== before;                        // a new day began
  }

  function start(d, f) {
    day = (typeof d === 'number' && isFinite(d)) ? d : Math.floor(Math.random() * YEAR_DAYS);
    frac = (typeof f === 'number' && isFinite(f)) ? f : 0.35;
    setWeather(pickWeather());
    /* Arrive in winter and the ground is already white — snow that fell before
       you got here. Waiting the two minutes it takes to settle would make every
       winter arrival look like autumn. */
    lying = season().id === 'winter'
      ? (WEATHER[weather].particles === 'snow' ? 0.9 : 0.45) : 0;
  }

  /* Where and when they are, for their prompt. Just the situation — the season's
     standing note is only worth adding when the weather is not already saying it,
     or you get "a blizzard" followed by a sentence about blizzards. */
  function describe() {
    const s = season(), w = WEATHER[weather];
    const line = 'It is ' + phase().name + ' of day ' + dayOfSeason() + ' of ' + s.name +
                 ', ' + s.warmth + '. Outside: ' + w.talk + '.';
    /* What is lying is not what is falling: a clear winter morning over a white
       village should not have them talking as though the snow had gone. The
       depth, and nothing read into it — "over everything" is a flourish and
       "old snow" dates it, and both are the sort of thing a villager should be
       arriving at rather than being handed. */
    const under = lying > 0.5 ? ' There is snow lying on the ground.'
                : lying > 0.12 ? ' There is snow lying in patches on the ground.' : '';
    const dull = !w.particles;                 // nothing falling, so nothing to remark on
    return (dull ? line + ' ' + s.note : line) + under;
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
    // how much of a village day this weather has left to run — part of the
    // calendar, so a save can put the sky back where it found it
    get weatherLeft() { return weatherLeft; },
    get snow() { return lying; },
    setSnow(v) { lying = Math.max(0, Math.min(1, Number(v) || 0)); },
    get info() { return WEATHER[weather]; },
    WEATHER, CLIMATE,
    set dayLength(ms) { if (ms > 1000) dayMs = ms; },
    get dayLength() { return dayMs; }
  };
})();
