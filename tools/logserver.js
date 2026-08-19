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
const PORT = Number(process.env.PORT || 8787);
const FAKE = process.env.LOGSERVER_FAKE === '1';

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
  if (req.method === 'GET') return serve(req, res);
  res.writeHead(405).end();
});

server.listen(PORT, () => {
  console.log('village   http://localhost:' + PORT);
  console.log('log       ' + path.relative(process.cwd(), LOGFILE));
  if (FAKE) console.log('fake      POST /fake is answering as a stand-in provider');
  console.log('');
});
process.on('SIGINT', () => {
  console.log('\n' + lines + ' entries written to ' + path.relative(process.cwd(), LOGFILE));
  process.exit(0);
});
