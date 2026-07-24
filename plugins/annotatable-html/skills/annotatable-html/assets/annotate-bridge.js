#!/usr/bin/env node
/*!
 * annotate-bridge.js — OPTIONAL local helper that removes the copy-paste step
 * for annotate.js pages. Zero dependencies (Node's http + fs + child_process).
 *
 * It does three things, all on your machine:
 *   1. Serves this folder over http://127.0.0.1:<port> (so the page can talk to it).
 *   2. Accepts the page's questions and writes "<base>-questions.json".
 *   3. Runs `claude -p` (your Claude Code SUBSCRIPTION — no API key, no per-call
 *      billing) to write answers into "<base>-threads.js". The page then live-
 *      updates with no reload and no clipboard.
 *
 * USAGE:  cd into the folder that holds your .html doc, then:
 *           node annotate-bridge.js
 *         Open the printed URL (http://127.0.0.1:4317/<your>.html) — NOT file://.
 *         If the bridge isn't running, the page silently falls back to the
 *         self-contained "Copy questions for Claude" button.
 *
 * Auth note: uses whatever `claude` is logged into. If ANTHROPIC_API_KEY is set
 * in your environment it would use the API instead of the subscription, so this
 * script unsets it for the child process.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = process.cwd();
const PREFERRED = Number(process.env.ANNOT_PORT || (process.argv.find(a => /^\d+$/.test(a))) || 4317);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.woff2': 'font/woff2' };

const safeBase = b => typeof b === 'string' && /^[A-Za-z0-9._-]+$/.test(b) && !b.includes('..');
let busy = Promise.resolve(); // serialize claude runs

function send(res, code, body, type) { res.writeHead(code, { 'Content-Type': type || 'text/plain', 'Cache-Control': 'no-store' }); res.end(body); }

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) return send(res, 403, 'forbidden');           // no path traversal
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
  });
}

function buildPrompt(base) {
  const q = base + '-questions.json', t = base + '-threads.js', doc = base + '.html';
  return [
    `You are answering a reader's annotation questions for a local HTML document.`,
    `Read the questions from "${q}" (a JSON array of { id, label, anchor, questions }).`,
    `Read the document "${doc}" in this folder for context so your answers are accurate and specific.`,
    `Then edit "${t}" (create it if missing). That file assigns: window.ANNOTATE_THREADS = { <id>: {...} }.`,
    `For each question, merge into that object keyed by its "id", copying "label" and "anchor" EXACTLY.`,
    `Append to messages[]: { role:"user", text:<the question> } then { role:"claude", text:<your answer> }.`,
    `Preserve any existing messages (this may be a follow-up). Answers may use markdown (bold, lists, \`code\`, fences).`,
    `Be concise and concrete. This is a plain file edit — do NOT run git, commit, or push.`,
  ].join(' ');
}

function runClaude(base) {
  return new Promise((resolve) => {
    // Clean env: force subscription (drop API key) and strip nested-session markers so `claude`
    // runs as a normal top-level session (otherwise a parent Claude session gates its writes).
    const env = Object.assign({}, process.env);
    delete env.ANTHROPIC_API_KEY;
    for (const k of Object.keys(env)) { if (/^CLAUDE(CODE|_CODE|_PID|_EFFORT|_JOB_DIR)/.test(k) || k === 'CLAUDECODE' || k === 'AI_AGENT') delete env[k]; }
    // bypassPermissions = run unattended (acceptEdits still prompts for writes in current CLI).
    // Safe here: you launched this helper yourself, in your own doc folder, and the prompt only
    // asks Claude to edit the threads file for this doc.
    const args = ['-p', buildPrompt(base), '--model', 'sonnet', '--permission-mode', 'bypassPermissions', '--add-dir', ROOT];
    const started = Date.now();
    const proc = spawn('claude', args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stdout.on('data', d => process.stdout.write(d));
    proc.stderr.on('data', d => { err += d; process.stderr.write(d); });
    proc.on('error', e => resolve({ ok: false, error: 'spawn failed: ' + e.message + ' (is the `claude` CLI on PATH?)' }));
    proc.on('close', code => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0) { console.log(`✓ answered ${base} in ${secs}s`); resolve({ ok: true }); }
      else resolve({ ok: false, error: 'claude exited ' + code + (err ? ': ' + err.slice(0, 300) : '') });
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/__annot/ping') return send(res, 200, JSON.stringify({ ok: true, root: ROOT }), 'application/json');

  if (req.method === 'POST' && req.url === '/__annot/ask') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      let base, batch;
      try { const j = JSON.parse(body); base = j.base; batch = j.batch; } catch (e) { return send(res, 400, JSON.stringify({ ok: false, error: 'bad json' }), 'application/json'); }
      if (!safeBase(base) || !Array.isArray(batch)) return send(res, 400, JSON.stringify({ ok: false, error: 'bad request' }), 'application/json');
      try { fs.writeFileSync(path.join(ROOT, base + '-questions.json'), JSON.stringify(batch, null, 2)); }
      catch (e) { return send(res, 500, JSON.stringify({ ok: false, error: 'write failed: ' + e.message }), 'application/json'); }
      console.log(`→ ${batch.length} question(s) for ${base}; running claude…`);
      busy = busy.then(() => runClaude(base)).then(result => {
        try { fs.unlinkSync(path.join(ROOT, base + '-questions.json')); } catch (e) {}
        send(res, 200, JSON.stringify(result), 'application/json');
      });
      return;
    });
    return;
  }

  if (req.method === 'GET') {
    if ((req.url === '/' || req.url === '/index.html') && !fs.existsSync(path.join(ROOT, 'index.html'))) return send(res, 200, generateIndex(), 'text/html');
    return serveStatic(req, res);
  }
  send(res, 405, 'method not allowed');
});

/* ---------- pick the doc to open, open a browser, find a free port ---------- */
function argDoc() { // open a specific doc only if one was passed on the command line
  const a = process.argv.slice(2).find(x => /\.html?$/i.test(x));
  return (a && fs.existsSync(path.join(ROOT, path.basename(a)))) ? path.basename(a) : null;
}
function esc2(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function generateIndex() { // an auto-listing home page when the folder has no index.html
  const items = fs.readdirSync(ROOT)
    .filter(f => /\.html?$/i.test(f) && f.toLowerCase() !== 'index.html')
    .map(f => ({ f, m: fs.statSync(path.join(ROOT, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const cards = items.map(d => `<a class="c" href="/${encodeURIComponent(d.f)}"><b>${esc2(d.f.replace(/\.html?$/i, ''))}</b><span>${new Date(d.m).toLocaleString()}</span></a>`).join('');
  const body = items.length ? `<div class="g">${cards}</div>` : `<p class="e">No docs here yet — ask Claude to make one in this folder.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Annotated docs</title>
<style>body{margin:0;background:#0f1115;color:#e7e9ee;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:64px 40px}h1{font-size:30px;margin:0 0 4px;letter-spacing:-.3px}
.sub{color:#9aa3b2;margin:0 0 28px}.g{display:grid;gap:10px}
.c{display:flex;justify-content:space-between;align-items:center;gap:12px;text-decoration:none;background:#161a21;border:1px solid #252b36;border-radius:12px;padding:14px 16px;color:#e7e9ee}
.c:hover{border-color:#7c9cff}.c b{font-size:16px;font-weight:600}.c span{color:#9aa3b2;font-size:12px;white-space:nowrap}.e{color:#9aa3b2}</style></head>
<body><main><h1>Annotated docs</h1><p class="sub">Click a doc to open it — annotate, ask, get answers inline.</p>${body}</main></body></html>`;
}
function urlFor(port, doc) { return `http://127.0.0.1:${port}/` + (doc ? encodeURIComponent(doc) : ''); }
function openBrowser(url) {
  if (process.env.ANNOT_NO_OPEN) return;   // for automated/headless use
  const p = process.platform;
  const cmd = p === 'darwin' ? 'open' : p === 'win32' ? 'cmd' : 'xdg-open';
  const args = p === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
}
function probe(port, cb) { // 'free' | 'ours' | 'other'
  const req = http.get({ host: '127.0.0.1', port, path: '/__annot/ping', timeout: 700 }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const j = JSON.parse(d); cb(j.ok && j.root === ROOT ? 'ours' : 'other'); } catch (e) { cb('other'); } });
  });
  req.on('error', e => cb(e.code === 'ECONNREFUSED' ? 'free' : 'other'));
  req.on('timeout', () => { req.destroy(); cb('other'); });
}
function findPort(port, cb, tries) {
  tries = tries || 0;
  probe(port, state => {
    if (state === 'free') cb({ n: port });
    else if (state === 'ours') cb({ n: port, ours: true });    // a bridge for THIS folder is already up
    else if (tries < 12) findPort(port + 1, cb, tries + 1);
    else cb({ n: port });
  });
}
function onListen(port) {
  const link = urlFor(port, argDoc() || '');   // a specific doc if passed, else the index
  console.log(`\n  ✦ Annotate bridge is live — ${ROOT}`);
  console.log(`  Opening ${link}`);
  console.log(`  Mark + type a question → the answer appears automatically.`);
  console.log(`  Close this window to stop.\n`);
  openBrowser(link);
}
findPort(PREFERRED, sel => {
  if (sel.ours) { console.log(`Bridge already running on ${sel.n} — opening…`); openBrowser(urlFor(sel.n, argDoc() || '')); process.exit(0); }
  server.listen(sel.n, '127.0.0.1', () => onListen(sel.n));
});
