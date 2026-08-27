#!/usr/bin/env node
/* logserver.js — local dev server: serves the game, logs API calls, and
   persists saves.

   Combines these three jobs in one process deliberately: it serves the
   game over http (required anyway, since the API providers reject
   file:// origins), and having log/save posts land on that same origin
   avoids any CORS configuration.

       node tools/logserver.js          then open http://localhost:8787

   Logs every game event to logs/session-<when>.jsonl (one JSON object per
   line): each API call's prompt, raw reply, and reasoning trace, plus
   villager decisions and memory updates. If this server isn't running,
   the game runs fine but produces no log.

   Also persists saves. The game writes to this browser's localStorage
   every few seconds and POSTs the same bytes here, written to
   saves/village.json as plain JSON — readable, copyable to another
   machine, or loadable into a browser that's never seen it. The server
   has no independent model of what a village is: it just stores
   whatever the game posts (after checking it looks like a save) and
   returns it unchanged. */
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');
const SAVES = path.join(ROOT, 'saves');
const SAVEFILE = path.join(SAVES, 'village.json');
const ENVFILE = path.join(ROOT, '.env');

/* ---------------------------------------------------------------- .env

   A browser can't read files off disk, so without this server the game
   would have to ask the user to paste API keys manually. This server
   reads .env and serves the keys to the page over the loopback interface
   it's already serving from — saving a paste, not adding a new place the
   keys are exposed to (they still end up in the browser either way). The
   /env route only answers local connections, so nothing else on the
   network can request them.

   .env is loaded once at startup, dotenv-style: values already present
   in process.env take priority, so `ANTHROPIC_API_KEY=… node
   tools/logserver.js` overrides the file without editing it. Changes to
   .env require a restart to take effect. */
function loadEnvFile() {
  let text = '';
  try { text = fs.readFileSync(ENVFILE, 'utf8'); } catch (e) { return 0; }
  let n = 0;
  text.split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t[0] === '#') return;
    const eq = t.indexOf('=');
    if (eq < 1) return;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v[0] === '"' && v.slice(-1) === '"') || (v[0] === "'" && v.slice(-1) === "'")) {
      v = v.slice(1, -1);
    }
    if (v && process.env[k] === undefined) { process.env[k] = v; n++; }
  });
  return n;
}
const ENV_LOADED = loadEnvFile();

// read after .env, so PORT and LOGSERVER_FAKE can be set there like anything else
const PORT = Number(process.env.PORT || 8787);
const FAKE = process.env.LOGSERVER_FAKE === '1';


/* Returns only the env values the game actually uses; served only over
   the loopback interface (see isLocal()). */
function settingsFromEnv() {
  const e = process.env;
  const pick = (...names) => { for (const n of names) if (e[n]) return e[n]; return ''; };
  return {
    provider: pick('LG_PROVIDER', 'PROVIDER'),
    anthropicKey: pick('ANTHROPIC_API_KEY'),
    openrouterKey: pick('OPENROUTER_API_KEY'),
    ttsKey: pick('ELEVENLABS_API_KEY'),
    model: pick('LG_MODEL', 'MODEL'),
    helper: pick('LG_HELPER', 'HELPER'),
    lang: pick('LG_LANG', 'LANG_CHOICE'),
    level: pick('LG_LEVEL', 'LEVEL')
  };
}

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(SAVES, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOGFILE = path.join(LOGS, 'session-' + stamp + '.jsonl');
let lines = 0;
let savedSeed = '';        // seed of the last-written village, so we only log a save once per new village

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

function serve(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
  /* Block static serving of dotfiles (.env lives in this directory —
     serving it directly would leak keys even though /env itself is
     access-controlled), logs/ (full of prompts), and saves/ (has its own
     dedicated routes below, so there should be exactly one way to reach it). */
  const parts = path.relative(ROOT, file).split(path.sep);
  if (parts.some(p => p[0] === '.') || parts[0] === 'logs' || parts[0] === 'saves' ||
      parts[0] === 'node_modules') {
    res.writeHead(404).end('not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/log') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8e6) req.destroy(); });
    req.on('end', () => {
      let batch = [];
      try { batch = JSON.parse(body); } catch (e) { res.writeHead(400).end('bad json'); return; }
      if (!Array.isArray(batch)) batch = [batch];
      const out = batch.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFile(LOGFILE, out, () => {});
      lines += batch.length;
      // print one terse line per entry, so the terminal shows the village live
      batch.forEach(e => {
        if (e.type === 'call') {
          console.log('  ' + String(e.kind).padEnd(9) + (e.who || '').padEnd(8) +
            String(e.ms + 'ms').padStart(7) +
            (e.truncated ? '  CUT OFF' : '') + (e.error ? '  FAILED: ' + e.error : ''));
        } else {
          console.log('  ' + String(e.type).padEnd(9) + (e.who || '').padEnd(8) + ' ' +
            String(e.what || '').slice(0, 90));
        }
      });
      res.writeHead(204).end();
    });
    return;
  }
  // A stand-in provider for testing the loop without a key: LOGSERVER_FAKE=1
  if (FAKE && req.method === 'POST' && req.url === '/fake') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [
        { type: 'thinking', thinking: 'Nadia keeps a shop and it is the afternoon. She never gives anything away for free, so the shop is where the money is.' },
        { type: 'text', text: '{"go":"Shop","why":"no coin comes in from sitting at home"}' }],
        stop_reason: 'end_turn', usage: { input_tokens: 812, output_tokens: 64 } }));
    });
    return;
  }
  /* POST /save — write the save file.

     Only checks that the body looks like a save (has the right `game`
     field and a village seed); the actual save shape is js/save.js's
     responsibility, and this just stores whatever it's given. Written to
     a temp file and renamed atomically, so a crash mid-write leaves the
     previous good save intact rather than a corrupted partial file. */
  if (req.method === 'POST' && req.url === '/save') {
    if (!isLocal(req)) { res.writeHead(403).end('local connections only'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8e6) req.destroy(); });
    req.on('end', () => {
      let save = null;
      try { save = JSON.parse(body); } catch (e) { res.writeHead(400).end('bad json'); return; }
      if (!save || save.game !== 'little-village' || !save.village || !save.village.seed) {
        res.writeHead(400).end('not a village');
        return;
      }
      const tmp = SAVEFILE + '.tmp';
      fs.writeFile(tmp, body, err => {
        if (err) { res.writeHead(500).end('could not write'); return; }
        fs.rename(tmp, SAVEFILE, err2 => {
          if (err2) { res.writeHead(500).end('could not write'); return; }
          if (save.village.seed !== savedSeed) {
            savedSeed = save.village.seed;
            console.log('  save      ' + savedSeed + ' \u2192 ' +
                        path.relative(process.cwd(), SAVEFILE));
          }
          res.writeHead(204).end();
        });
      });
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/save') {
    if (!isLocal(req)) { res.writeHead(403).end('local connections only'); return; }
    fs.readFile(SAVEFILE, (err, data) => {
      if (err) { res.writeHead(404).end('no save'); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'DELETE' && req.url === '/save') {
    if (!isLocal(req)) { res.writeHead(403).end('local connections only'); return; }
    fs.unlink(SAVEFILE, () => { savedSeed = ''; res.writeHead(204).end(); });
    return;
  }
  if (req.method === 'GET' && req.url === '/env') {
    if (!isLocal(req)) { res.writeHead(403).end('local connections only'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(settingsFromEnv()));
    return;
  }
  if (req.method === 'GET') return serve(req, res);
  res.writeHead(405).end();
});

/* Bind to loopback only — this process reads and serves API keys, so
   nothing else on the network should be able to reach it. */
server.listen(PORT, '127.0.0.1', () => {
  console.log('village   http://localhost:' + PORT);
  console.log('log       ' + path.relative(process.cwd(), LOGFILE));
  if (FAKE) console.log('fake      POST /fake is answering as a stand-in provider');
  const env = settingsFromEnv();
  const have = ['anthropicKey', 'openrouterKey', 'ttsKey']
    .filter(k => env[k]).map(k => k.replace('Key', ''));
  console.log('env       ' + (ENV_LOADED ? ENV_LOADED + ' values from .env' : 'no .env'));
  console.log('keys      ' + (have.length ? have.join(', ')
                                          : 'none — paste them in the game'));
  let held = null;
  try { held = JSON.parse(fs.readFileSync(SAVEFILE, 'utf8')); } catch (e) {}
  if (held && held.village) savedSeed = held.village.seed;
  console.log('save      ' + (held && held.village
    ? held.village.seed + ', saved ' + held.saved
    : 'none yet — ' + path.relative(process.cwd(), SAVEFILE) + ' when there is'));
  console.log('');
});
process.on('SIGINT', () => {
  console.log('\n' + lines + ' entries written to ' + path.relative(process.cwd(), LOGFILE));
  process.exit(0);
});
