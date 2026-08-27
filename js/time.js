/* time.js — the village calendar: hours, days, seasons and weather.

   Monsoon climate, 120-day year, 30 days per season. A new village rolls a
   random day of the year (so you might arrive in a blizzard or in high
   summer), and that state persists across saves: `start`, `setWeather` and
   `setSnow` can be given the saved day/hour/weather/snow depth so a
   reloaded village resumes at the point it was left, not at a fresh roll. */
window.LG = window.LG || {};

LG.time = (function () {
  const SEASON_DAYS = 30;
  const YEAR_DAYS = SEASON_DAYS * 4;
  let dayMs = 6 * 60 * 1000;          // real milliseconds per village day

  /* Seasons do NOT tint the screen — an always-on wash becomes invisible
     with use, and it would wash out the village's actual colors all day.
     Only the hour tints the screen (it changes over the day, so it reads).
     Season is communicated in text, not visuals. `tone` here is only used
     as the color of the weather-gloom overlay (see `dim` below). */
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

  /* Weather table. `talk` is the phrase inserted into the villagers' prompt
     (a description, not a label). `dim` (0–1) is a grey overlay over the
     whole screen — only set for weather that actually reduces visibility
     (fog, heavy rain/snow, sandstorm); everything else is conveyed by its
     particles alone, so e.g. plain snow doesn't grey out the scene. `indoors`
     is a separate flag that drives villagers under a roof — kept independent
     of `dim` because e.g. drizzle should send people indoors without
     darkening the sky. */
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

  // weighted [weather, weight] pairs per season, for pickWeather()
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

  /* Snow depth on the ground, 0..1 — distinct from current weather (what's
     falling right now). Builds while snow falls, and persists/melts after it
     stops, at a per-season rate; visible for a while after the sky clears.
     Doesn't melt at all during a hard frost, so a winter can stay white
     through several weather changes. */
  let lying = 0;
  const MELT = { winter: 0.5, spring: 2.5, summer: 8, autumn: 3 };   // melt rate per village day

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

  /* Picks how long the new weather lasts, in village-day fractions.
     Defaults to roughly a quarter to two-thirds of a day, so weather
     doesn't flip too often. */
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
    // Seed snow depth on arrival in winter, rather than starting bare and
    // waiting for it to accumulate — otherwise every winter start would
    // look like autumn until enough snow had fallen in-game.
    lying = season().id === 'winter'
      ? (WEATHER[weather].particles === 'snow' ? 0.9 : 0.45) : 0;
  }

  /* Builds the situation description inserted into villagers' prompts.
     Only appends the season's standing `note` when the current weather
     isn't already descriptive (`w.particles` unset) — otherwise you'd get
     "a blizzard" immediately followed by a sentence about blizzards. */
  function describe() {
    const s = season(), w = WEATHER[weather];
    const line = 'It is ' + phase().name + ' of day ' + dayOfSeason() + ' of ' + s.name +
                 ', ' + s.warmth + '. Outside: ' + w.talk + '.';
    // Ground snow depth is reported separately from current weather (a
    // clear winter morning can still have snow on the ground). Kept as a
    // plain depth statement — no embellishment like "old snow" that would
    // imply a timeline the game doesn't track.
    const under = lying > 0.5 ? ' There is snow lying on the ground.'
                : lying > 0.12 ? ' There is snow lying in patches on the ground.' : '';
    const dull = !w.particles;                 // nothing falling — weather has nothing to add
    return (dull ? line + ' ' + s.note : line) + under;
  }

  /* Short weather/date label for the HUD. */
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
