/* sky.js — renders time-of-day lighting and weather particles.

   Everything here is drawn in screen space, on top of the finished world:
   a color wash for the time of day, then particles for whatever is
   falling. Screen space keeps the particle count independent of map size. */
window.LG = window.LG || {};

LG.sky = (function () {
  let parts = [];
  let kind = null;
  let flash = 0, flashCool = 4;

  /* Color wash for a given time-of-day fraction (0–1): deep blue at
     night, warm at dawn/dusk. */
  function daylight(frac) {
    const stops = [
      [0.00, [16, 24, 54], 0.60],   // small hours
      [0.20, [30, 38, 68], 0.52],
      [0.26, [212, 132, 84], 0.26], // first light
      [0.34, [255, 236, 200], 0.05],
      [0.50, [255, 250, 235], 0.00], // midday
      [0.68, [255, 240, 210], 0.05],
      [0.76, [226, 132, 72], 0.24], // dusk
      [0.84, [46, 50, 88], 0.44],
      [1.00, [16, 24, 54], 0.60]
    ];
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (frac >= stops[i][0] && frac <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
    }
    const t = (frac - a[0]) / Math.max(0.0001, b[0] - a[0]);
    const c = [0, 1, 2].map(i => Math.round(a[1][i] + (b[1][i] - a[1][i]) * t));
    const alpha = a[2] + (b[2] - a[2]) * t;
    return { rgb: c, alpha };
  }

  function spawn(n, vw, vh, style) {
    for (let i = 0; i < n; i++) {
      parts.push({
        x: Math.random() * (vw + 200) - 100,
        y: Math.random() * vh,
        v: 0.5 + Math.random(),
        s: Math.random(),
        style: style
      });
    }
  }

  function step(dt, vw, vh) {
    if (!vw || !vh) return;
    const info = LG.time.info || {};
    const want = info.particles || null;
    if (want !== kind) { parts = []; kind = want; }
    if (!kind) return;

    const rate = info.rate || 1;
    const target = kind === 'fog' ? 26 : kind === 'haze' ? 18 : Math.round(120 * rate);
    if (parts.length < target) spawn(Math.min(24, target - parts.length), vw, vh, kind);
    if (parts.length > target) parts.length = target;

    const wind = (info.wind || 0.3);
    for (const p of parts) {
      if (kind === 'rain')      { p.x += (60 + 40 * wind) * dt * 10 * 0.1; p.y += (900 * p.v * rate) * dt; }
      else if (kind === 'snow') { p.x += (40 * wind + Math.sin(p.y / 40 + p.s * 6) * 30) * dt; p.y += (90 + 70 * p.v) * rate * dt; }
      else if (kind === 'sand') { p.x += (420 + 260 * p.v) * wind * dt; p.y += Math.sin(p.x / 60 + p.s * 6) * 24 * dt; }
      else if (kind === 'fog')  { p.x += (16 + 10 * p.v) * dt; }
      else if (kind === 'haze') { p.x += (8 + 6 * p.v) * dt; p.y -= 4 * dt; }
      if (p.y > vh + 40) { p.y = -20; p.x = Math.random() * (vw + 200) - 100; }
      if (p.x > vw + 120) { p.x = -100; p.y = Math.random() * vh; }
      if (p.y < -40) p.y = vh + 20;
    }

    if (info.lightning) {
      flashCool -= dt;
      if (flashCool <= 0) { flash = 0.5; flashCool = 3 + Math.random() * 9; }
    }
    if (flash > 0) flash = Math.max(0, flash - dt * 2.2);
  }

  /* Clips rain/snow/sand so they don't render through roofs. Roofs arrive
     as screen-space rectangles and are punched out of the particle layer
     with an even-odd clip (one path per frame). Fog and haze skip this:
     they drift around buildings rather than falling onto them, and a hard
     rectangular cutout in a soft cloud looks worse than the overlap it
     would fix. */
  function shelterClip(ctx, vw, vh, roofs) {
    if (!roofs || !roofs.length) return false;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, vw, vh);
    for (const r of roofs) ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip('evenodd');
    return true;
  }

  function draw(ctx, vw, vh, roofs) {
    const info = LG.time.info || {};
    const s = LG.time.season();

    // Darkening overlay for heavy weather only — see `dim` in time.js.
    // Off (0) by default.
    if (info.dim) {
      ctx.globalAlpha = info.dim;
      ctx.fillStyle = info.whiteout ? '#dce8f4' : (s.tone || '#5d6472');
      ctx.fillRect(0, 0, vw, vh);
      ctx.globalAlpha = 1;
    }
    // Time-of-day color wash
    const light = daylight(LG.time.frac);
    if (light.alpha > 0.005) {
      ctx.fillStyle = 'rgba(' + light.rgb.join(',') + ',' + light.alpha.toFixed(3) + ')';
      ctx.fillRect(0, 0, vw, vh);
    }

    // draw active particles
    const clipped = (kind === 'rain' || kind === 'snow' || kind === 'sand')
      && shelterClip(ctx, vw, vh, roofs);
    if (kind === 'rain') {
      ctx.strokeStyle = 'rgba(190,215,240,.55)'; ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (const p of parts) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 4, p.y + 16 + p.v * 10); }
      ctx.stroke();
    } else if (kind === 'snow') {
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      for (const p of parts) { ctx.beginPath(); ctx.arc(p.x, p.y, 1.4 + p.s * 1.8, 0, Math.PI * 2); ctx.fill(); }
    } else if (kind === 'sand') {
      ctx.strokeStyle = 'rgba(214,180,120,.5)'; ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const p of parts) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 26 - p.v * 20, p.y + 2); }
      ctx.stroke();
    } else if (kind === 'fog' || kind === 'haze') {
      for (const p of parts) {
        ctx.globalAlpha = kind === 'fog' ? 0.10 : 0.05;
        ctx.fillStyle = kind === 'fog' ? '#e8eef3' : '#f0e6cf';
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, 120 + p.s * 140, 26 + p.s * 26, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    if (clipped) ctx.restore();

    if (flash > 0) {
      ctx.fillStyle = 'rgba(226,238,255,' + (flash * 0.5).toFixed(3) + ')';
      ctx.fillRect(0, 0, vw, vh);
    }
  }

  return { step, draw, daylight, get count() { return parts.length; } };
})();
