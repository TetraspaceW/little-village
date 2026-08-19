#!/usr/bin/env node
/* logserver.js — serves the game and keeps the log.

   Two jobs in one process, on purpose. It serves the village over http, which
   the API providers need anyway (they reject file:// origins), and it accepts
   the game's own log posts on the same origin, so there is no CORS to arrange
   and nothing to configure.

       node tools/logserver.js          then open http://localhost:8787

   Everything the village does lands in logs/session-<when>.jsonl, one JSON
   object per line: every API call with its prompt, its raw reply and the
   model's own reasoning, plus what the villagers decided and remembered. If the
   server is not running the game carries on and simply keeps no log. */
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');
const ENVFILE = path.join(ROOT, '.env');

/* ---------------------------------------------------------------- .env

   A browser cannot read a file off your disk, which is why the game used to
   have no choice but to ask you to paste keys. A server can, so now that one is
   here anyway, it reads .env and hands the keys to the page over the loopback
   interface it is already serving from.

   The keys do reach the browser, which is the same place they lived before —
   this saves the pasting, not the trust. It refuses to answer anything that is
   not a local connection, so nothing on your network can ask it for them. */
/* Read .env into the process at startup, the way dotenv does it: anything
   already in the environment wins, so `ANTHROPIC_API_KEY=… node tools/logserver.js`
   beats the file without having to edit it. Loaded once — restart to pick up a
   change, which is what everyone expects of a .env. */
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


/* Only what the game has a use for, and only over the loopback interface. */
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
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOGFILE = path.join(LOGS, 'session-' + stamp + '.jsonl');
let lines = 0;

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
  /* The keys live in a dotfile in the directory this is serving, so serving
     dotfiles would hand them to anyone who guessed the name — /env is careful
     about who it answers and it would have been beside the point. The logs are
     full of prompts and are nobody's business either. */
  const parts = path.relative(ROOT, file).split(path.sep);
  if (parts.some(p => p[0] === '.') || parts[0] === 'logs' || parts[0] === 'node_modules') {
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
      // one terse line per entry, so the terminal is a live view of the village
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
  if (req.method === 'GET' && req.url === '/env') {
    if (!isLocal(req)) { res.writeHead(403).end('local connections only'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(settingsFromEnv()));
    return;
  }
  if (req.method === 'GET') return serve(req, res);
  res.writeHead(405).end();
});

/* Loopback only. This process reads your keys and serves them; there is no
   reason for anything else on the network to be able to reach it. */
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
  console.log('');
});
process.on('SIGINT', () => {
  console.log('\n' + lines + ' entries written to ' + path.relative(process.cwd(), LOGFILE));
  process.exit(0);
});
