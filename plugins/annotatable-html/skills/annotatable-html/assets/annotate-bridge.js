#!/usr/bin/env node
/*!
 * annotate-bridge.js — OPTIONAL local helper that removes the copy-paste step
 * for annotate.js pages. Zero dependencies (Node's http + fs + child_process).
 *
 * It does three things, all on your machine:
 *   1. Serves this folder over http://127.0.0.1:<port> (so the page can talk to it).
 *   2. Runs `claude -p` (your Claude Code subscription) or `codex exec` (your Codex login) to
 *      answer a question, streaming the answer text back to the page as it is written.
 *   3. Writes the finished answer into "<base>-threads.js" itself — the model only writes the
 *      answer, it never reads or edits the threads file (that used to cost most of the time).
 *
 * USAGE:  cd into the folder that holds your .html doc, then:
 *           node annotate-bridge.js
 *         Open the printed URL (http://127.0.0.1:4317/<your>.html) — NOT file://.
 *         If the bridge isn't running, the page silently falls back to the
 *         self-contained "Copy questions for Claude" button.
 *
 * Auth note: uses whatever `claude` / `codex` is logged into. If ANTHROPIC_API_KEY is set in
 * your environment `claude` would use the API instead of the subscription, so this script
 * unsets it for the child process.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = process.cwd();
const PREFERRED = Number(process.env.ANNOT_PORT || (process.argv.find(a => /^\d+$/.test(a))) || 4317);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.woff2': 'font/woff2' };
const ANSWER_TIMEOUT_MS = 4 * 60 * 1000;

const safeBase = b => typeof b === 'string' && /^[A-Za-z0-9._-]+$/.test(b) && !b.includes('..');
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9]+$/.test(id);

// Keyed queue: work under the same key runs strictly in order. The per-doc key guards the
// threads/sessions/project files (fast, in-process work only). The per-thread key keeps two
// follow-ups in ONE thread from resuming the same session at once. Model calls for different
// threads of the same doc run in parallel.
const queues = new Map();
function withQueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}
// Cross-doc concurrency cap — without it, many questions at once could spawn unbounded model
// processes. Override with ANNOT_MAX_CONCURRENT.
const MAX_CONCURRENT = Number(process.env.ANNOT_MAX_CONCURRENT) || 4;
let activeSpawns = 0;
const spawnWaitQueue = [];
function acquireSpawnSlot() {
  if (activeSpawns < MAX_CONCURRENT) { activeSpawns++; return Promise.resolve(); }
  return new Promise(resolve => spawnWaitQueue.push(resolve));
}
function releaseSpawnSlot() {
  const next = spawnWaitQueue.shift();
  if (next) next(); else activeSpawns--;
}

// CSRF guard: the bridge is loopback-only, but with no Origin check any *other* page open in the
// same browser could fetch() these state-changing endpoints. Requests with no Origin header (curl,
// the documented set-project example in SKILL.md) are still allowed.
let SELF_ORIGIN = null;
function originOk(req) {
  const origin = req.headers.origin;
  return !origin || origin === SELF_ORIGIN;
}

function send(res, code, body, type) { res.writeHead(code, { 'Content-Type': type || 'text/plain', 'Cache-Control': 'no-store' }); res.end(body); }
const sendJSON = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json');
function readBody(req, limit, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > limit) req.destroy(); });
  req.on('end', () => { let j; try { j = JSON.parse(body); } catch (e) { j = null; } cb(j); });
}

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); } catch (e) { return send(res, 400, 'bad url'); }
  if (rel === '/') rel = '/index.html';
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) return send(res, 403, 'forbidden');           // no path traversal
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
  });
}

/* ---------------------------------- models ---------------------------------- */
// Claude aliases are stable CLI names. Codex models are read from the local Codex install (its
// models cache + config), so new Codex models show up without editing this file.
const CLAUDE_MODELS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];
function onPath(cmd) { try { execFileSync('/bin/sh', ['-c', 'command -v ' + cmd], { stdio: 'ignore', timeout: 2000 }); return true; } catch (e) { return false; } }
function codexModels() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const cache = readJSON(path.join(home, 'models_cache.json'), null);
  const raw = cache ? (Array.isArray(cache) ? cache : cache.models || []) : [];
  const models = raw.filter(m => m && (m.slug || m.id) && (m.visibility || 'list') === 'list').map(m => ({
    id: m.slug || m.id,
    label: m.display_name || m.slug || m.id,
    efforts: (m.supported_reasoning_levels || []).map(e => e.effort || e).filter(e => typeof e === 'string'),
  }));
  let cfg = ''; try { cfg = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch (e) {}
  const top = cfg.split(/^\s*\[/m)[0];   // only top-level keys, not [profiles.*]
  const cfgModel = (top.match(/^\s*model\s*=\s*"([^"]+)"/m) || [])[1];
  const cfgEffort = (top.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m) || [])[1];
  if (cfgModel && !models.some(m => m.id === cfgModel)) models.unshift({ id: cfgModel, label: cfgModel, efforts: [] });
  return { models, default: cfgModel || (models[0] && models[0].id) || null, defaultEffort: cfgEffort || 'medium' };
}
// Real login checks (both take well under a second): a side that is installed but logged out is
// shown greyed out with the reason, instead of failing only when a question is asked.
function claudeLoggedIn() {
  try { return !!JSON.parse(execFileSync('claude', ['auth', 'status'], { env: childEnv(), timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).loggedIn; }
  catch (e) { return false; }
}
function codexLoggedIn() {
  // `codex login status` prints to stderr, not stdout — read both.
  const r = spawnSync('codex', ['login', 'status'], { env: childEnv(), timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (r.stdout || '') + (r.stderr || '');
  return r.status === 0 && /logged in/i.test(out) && !/not logged in/i.test(out);
}
function backendStatus(cmd, loggedIn, hasModels) {
  if (!onPath(cmd)) return { available: false, reason: 'not installed' };
  if (!loggedIn()) return { available: false, reason: 'not logged in' };
  if (!hasModels) return { available: false, reason: 'no models found' };
  return { available: true, reason: null };
}
let modelsCache = null;
function getModels() {
  if (modelsCache && Date.now() - modelsCache.at < 60 * 1000) return modelsCache.v;
  const cx = codexModels();
  const v = {
    claude: Object.assign(backendStatus('claude', claudeLoggedIn, true), { models: CLAUDE_MODELS, default: 'sonnet' }),
    codex: Object.assign(backendStatus('codex', codexLoggedIn, cx.models.length > 0), { models: cx.models, default: cx.default, defaultEffort: cx.defaultEffort }),
  };
  modelsCache = { at: Date.now(), v };
  return v;
}
function normalizeChoice(j) {
  const M = getModels();
  let backend = j.backend === 'codex' ? 'codex' : 'claude';
  if (!M[backend].available) { const other = backend === 'codex' ? 'claude' : 'codex'; if (M[other].available) backend = other; }
  const B = M[backend];
  const model = B.models.some(m => m.id === j.model) ? j.model : B.default;
  const info = B.models.find(m => m.id === model) || {};
  let effort = null;
  if (backend === 'codex') effort = (info.efforts || []).includes(j.effort) ? j.effort : ((info.efforts || []).includes(B.defaultEffort) ? B.defaultEffort : (info.efforts || [])[0] || null);
  const label = (backend === 'codex' ? 'Codex · ' : 'Claude · ') + (info.label || model) + (effort ? ' (' + effort + ')' : '');
  return { backend, model, effort, label };
}

/*
 * Session architecture (why answers are fast and grounded without re-teaching from scratch):
 *   <base>.sessions.json — bridge-internal bookkeeping (not for the reader):
 *     { v:2, bases:{ claude:<id>, codex:<id> }, threads:{ <threadId>:{ backend, id } } }
 *     (an older { base:<id>, threads:{ <threadId>:<id> } } file is read as Claude sessions.)
 *     - A base session per backend is primed ONCE per doc with the doc + (if known) the source
 *       project's orientation — as soon as the page opens (/__annot/prime), not on first question.
 *     - Each NEW thread forks from that base session, so it starts already grounded.
 *     - Each FOLLOW-UP resumes that thread's own session, so only the new question is sent.
 *     - Switching backend mid-thread forks the new backend's base and replays the thread history
 *       in the prompt (sessions can't move between Claude and Codex).
 *   <base>.project.json — optional, user-set: { dir, git:{commonDir,branch,headSha}|null, linkedAt }.
 *     Added via --add-dir (Claude) so answers can check real code; Codex runs read-only and can
 *     read it directly. Set via the 🔗 button on the docs index (POST /__annot/set-project).
 */
function sidecarPath(base, kind) { return path.join(ROOT, base + '.' + kind + '.json'); }
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
function writeJSON(file, obj) { const tmp = file + '.tmp' + process.pid; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, file); }
function loadSessions(base) {
  const s = readJSON(sidecarPath(base, 'sessions'), null) || {};
  if (s.v === 2) return { v: 2, bases: s.bases || {}, threads: s.threads || {} };
  const threads = {};
  for (const [tid, sid] of Object.entries(s.threads || {})) if (typeof sid === 'string') threads[tid] = { backend: 'claude', id: sid };
  return { v: 2, bases: s.base ? { claude: s.base } : {}, threads };
}
function saveSessions(base, s) { writeJSON(sidecarPath(base, 'sessions'), s); }
function updateSessions(base, fn) { return withQueue('doc:' + base, () => { const s = loadSessions(base); fn(s); saveSessions(base, s); return s; }); }

// <base>-threads.js is JS, not JSON (unquoted keys, a header comment) — evaluate it in a throwaway
// `window` to get the object back out, same trick the page itself uses.
function threadsFilePath(base) { return path.join(ROOT, base + '-threads.js'); }
function readThreadsFile(base) {
  let text; try { text = fs.readFileSync(threadsFilePath(base), 'utf8'); } catch (e) { return {}; }
  try { const win = {}; new Function('window', text)(win); return win.ANNOTATE_THREADS || {}; }
  catch (e) { return null; }   // unreadable — callers must not overwrite it
}
function writeThreadsFile(base, obj) {
  const file = threadsFilePath(base), tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, `window.ANNOTATE_THREADS = ${JSON.stringify(obj, null, 2)};\n`);
  fs.renameSync(tmp, file);
}
const docExists = base => fs.existsSync(path.join(ROOT, base + '.html')) || fs.existsSync(path.join(ROOT, base + '.htm'));

// Git identity of a directory, if it's inside a git repo (worktree or main checkout) — used to
// relocate a moved/renamed worktree later. Returns null for a non-git (or no-longer-git) dir.
function detectGit(dir) {
  try {
    const commonDirRaw = execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], { timeout: 2000, encoding: 'utf8' }).trim();
    const commonDir = path.resolve(dir, commonDirRaw);
    let branch = null;
    try { branch = execFileSync('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'], { timeout: 2000, encoding: 'utf8' }).trim() || null; } catch (e) {}
    const headSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 2000, encoding: 'utf8' }).trim();
    return { commonDir, branch, headSha };
  } catch (e) { return null; }
}
// Find where a branch's worktree currently lives, by asking the (still-present) shared .git dir.
function findWorktreeByBranch(commonDir, branch, headSha) {
  try {
    const out = execFileSync('git', ['--git-dir', commonDir, 'worktree', 'list', '--porcelain'], { timeout: 3000, encoding: 'utf8' });
    const entries = out.split(/\n\n+/).map(block => {
      const e = {};
      block.split('\n').forEach(line => {
        if (line.startsWith('worktree ')) e.path = line.slice(9);
        else if (line.startsWith('HEAD ')) e.head = line.slice(5);
        else if (line.startsWith('branch ')) e.branch = line.slice(7).replace(/^refs\/heads\//, '');
      });
      return e;
    }).filter(e => e.path);
    const hit = (branch && entries.find(e => e.branch === branch)) || (headSha && entries.find(e => e.head === headSha));
    return hit ? hit.path : null;
  } catch (e) { return null; }
}
// Resolves a doc's linked project dir, self-healing a moved/renamed worktree and flagging one
// that's genuinely gone so the caller can warn instead of silently answering ungrounded.
function resolveProjectDir(base) {
  const p = readJSON(sidecarPath(base, 'project'), null);
  if (!p || typeof p.dir !== 'string') return { dir: null };
  if (fs.existsSync(p.dir)) return { dir: p.dir };
  if (p.git && p.git.commonDir && fs.existsSync(p.git.commonDir)) {
    const found = findWorktreeByBranch(p.git.commonDir, p.git.branch, p.git.headSha);
    if (found && fs.existsSync(found)) {
      writeJSON(sidecarPath(base, 'project'), Object.assign({}, p, { dir: found, relinkedAt: Date.now() }));
      updateSessions(base, s => { s.bases = {}; });   // content may differ at the new path
      console.log(`↻ ${base}: worktree moved, relinked ${p.dir} → ${found}`);
      return { dir: found, relinked: true, from: p.dir };
    }
  }
  console.log(`⚠ ${base}: linked project "${p.dir}" is missing and could not be relocated`);
  return { dir: null, stale: true, lastKnownDir: p.dir };
}

/* ---------------------------------- prompts ---------------------------------- */
const STYLE_RULES = [
  'How to write every answer:',
  '- Plain English, like one person explaining to another. No jargon; if a technical term is unavoidable, explain it in a few words.',
  '- Be concise. Start with the direct answer in one or two short sentences. Add detail only if it helps, as a short list.',
  '- Do not name files, paths, functions or variables unless the reader asks for them. Describe what the code does instead.',
  '- Say plainly when you are not sure or the doc does not say.',
].join('\n');
function buildBasePrompt(base, projectDir) {
  const doc = base + '.html';
  return [
    `You are the standing Q&A assistant for the annotated doc "${doc}" in the folder ${ROOT}.`,
    projectDir ? `That doc documents the project at "${projectDir}" — skim its structure and key entry points (README, top-level source folders) to orient yourself, but do not paste file contents back.` : null,
    `Read "${doc}" now to orient yourself on its content and structure.`,
    `Reply with one short line ("Ready.") once oriented — no summary. Readers will ask questions about this doc in later turns, each in its own thread. Re-read any file whenever you need exact specifics instead of relying on memory.`,
    STYLE_RULES,
  ].filter(Boolean).join('\n\n');
}
function buildThreadPrompt(base, item, opts) {
  const qs = item.questions.length === 1 ? item.questions[0] : item.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const parts = [];
  if (opts.followup) parts.push(`Follow-up in the same thread about "${base}.html":`);
  else parts.push(`A reader asked about this part of "${base}.html": ${JSON.stringify(item.label)}` + (item.anchor && item.anchor.type ? ` (a ${item.anchor.type} they marked).` : '.'));
  if (opts.history && opts.history.length) {
    parts.push('Earlier in this thread:\n' + opts.history.map(m => (m.role === 'user' ? 'Reader: ' : 'You: ') + m.text).join('\n'));
  }
  parts.push('Question' + (item.questions.length > 1 ? 's' : '') + ':\n' + qs);
  parts.push('Reply with ONLY the answer text (markdown is fine) — no preamble, and do not edit any files. ' + (item.questions.length > 1 ? 'Answer each question in order.' : ''));
  parts.push(STYLE_RULES);   // every time — older sessions were primed before these rules existed
  return parts.join('\n\n');
}

/* ---------------------------------- model runners ---------------------------------- */
function childEnv() {
  // Clean env: force subscription (drop API key) and strip nested-session markers so the CLI
  // runs as a normal top-level session.
  const env = Object.assign({}, process.env);
  delete env.ANTHROPIC_API_KEY;
  for (const k of Object.keys(env)) { if (/^CLAUDE(CODE|_CODE|_PID|_EFFORT|_JOB_DIR)/.test(k) || k === 'CLAUDECODE' || k === 'AI_AGENT') delete env[k]; }
  return env;
}
// Runs one CLI process, feeding each stdout line to onLine. Resolves { ok, code, err, secs }.
async function runProcess(cmd, args, onLine, timeoutMs) {
  await acquireSpawnSlot();
  return new Promise(resolve => {
    const started = Date.now();
    let proc;
    try { proc = spawn(cmd, args, { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { releaseSpawnSlot(); return resolve({ ok: false, err: 'spawn failed: ' + e.message }); }
    let err = '', buf = '', settled = false;
    const done = r => { if (settled) return; settled = true; clearTimeout(timer); releaseSpawnSlot(); resolve(Object.assign({ secs: ((Date.now() - started) / 1000).toFixed(1) }, r)); };
    const timer = setTimeout(() => { proc.kill('SIGKILL'); done({ ok: false, err: `timed out after ${timeoutMs / 1000}s` }); }, timeoutMs);
    proc.stdout.on('data', d => {
      buf += d; let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { onLine(line); } catch (e) {} } }
    });
    proc.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    proc.on('error', e => done({ ok: false, err: 'spawn failed: ' + e.message + ` (is \`${cmd}\` on PATH?)` }));
    proc.on('close', code => { if (buf.trim()) { try { onLine(buf); } catch (e) {} } done({ ok: code === 0, code, err }); });
  });
}
// Claude: stream-json gives text deltas. Text written before a tool call ("let me check…") is
// dropped by sending a reset when a new assistant message starts.
async function runClaude({ prompt, model, resumeId, fork, sessionId, addDirs, onDelta, onReset, timeoutMs }) {
  const args = ['-p', prompt, '--model', model || 'sonnet', '--permission-mode', 'bypassPermissions', '--safe-mode',
    '--tools', 'Read,Glob,Grep', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
  if (resumeId) args.push('--resume', resumeId);
  if (fork) args.push('--fork-session');
  if (sessionId) args.push('--session-id', sessionId);
  for (const d of (addDirs || [])) args.push('--add-dir', d);
  let text = '', result = null, isError = false, sid = sessionId || null, started = false;
  const r = await runProcess('claude', args, line => {
    const ev = JSON.parse(line);
    if (ev.session_id && !sid) sid = ev.session_id;
    if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
      const e = ev.event || {};
      if (e.type === 'message_start') { if (started && text) { text = ''; onReset && onReset(); } started = true; }
      else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') { text += e.delta.text; onDelta && onDelta(e.delta.text); }
    } else if (ev.type === 'result') { result = typeof ev.result === 'string' ? ev.result : null; isError = !!ev.is_error; if (ev.session_id) sid = ev.session_id; }
  }, timeoutMs || ANSWER_TIMEOUT_MS);
  const answer = (result != null ? result : text).trim();
  if (r.ok && !isError && answer) return { ok: true, text: answer, sessionId: sid, secs: r.secs };
  return { ok: false, error: isError ? (answer || 'claude reported an error') : ('claude ' + (r.code != null ? 'exited ' + r.code : '') + ' ' + (r.err || '').slice(-300)).trim(), secs: r.secs };
}
// Codex: `exec --json` emits whole messages (no token deltas). --ignore-user-config skips the
// user's MCP servers/plugins (8.5s → ~3s startup); auth still comes from CODEX_HOME.
async function runCodex({ prompt, model, effort, resumeId, fork, onDelta, timeoutMs }) {
  const common = ['--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'];
  if (model) common.push('-m', model);
  if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
  const args = resumeId ? ['exec', fork ? 'fork' : 'resume', ...common, resumeId, prompt] : ['exec', ...common, prompt];
  let sid = null, last = '', failed = null;
  const r = await runProcess('codex', args, line => {
    if (line[0] !== '{') return;
    const ev = JSON.parse(line);
    if (ev.type === 'thread.started' && ev.thread_id) sid = ev.thread_id;
    else if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && ev.item.text) { last = ev.item.text; }
    else if (ev.type === 'turn.failed' || (ev.type === 'error' && ev.message)) failed = (ev.error && ev.error.message) || ev.message || 'codex turn failed';
  }, timeoutMs || ANSWER_TIMEOUT_MS);
  if (last && onDelta) onDelta(last);
  if (r.ok && !failed && last.trim()) return { ok: true, text: last.trim(), sessionId: sid || (resumeId && !fork ? resumeId : null), secs: r.secs };
  return { ok: false, error: failed || ('codex ' + (r.code != null ? 'exited ' + r.code : '') + ' ' + (r.err || '').split('\n').filter(l => !/ERROR (codex_core::session|rmcp|codex_models_manager)/.test(l)).join('\n').slice(-300)).trim(), secs: r.secs };
}
function runModel(choice, opts) {
  return choice.backend === 'codex'
    ? runCodex(Object.assign({ model: choice.model, effort: choice.effort }, opts))
    : runClaude(Object.assign({ model: choice.model }, opts));
}

/* ---------------------------------- sessions ---------------------------------- */
const priming = new Map();   // `${base}|${backend}` -> in-flight prime promise
function ensureBase(base, choice) {
  const key = base + '|' + choice.backend;
  const existing = loadSessions(base).bases[choice.backend];
  if (existing) return Promise.resolve(existing);
  if (priming.has(key)) return priming.get(key);
  const p = (async () => {
    const proj = resolveProjectDir(base);
    const addDirs = [ROOT].concat(proj.dir ? [proj.dir] : []);
    const r = await runModel(choice, { prompt: buildBasePrompt(base, proj.dir), sessionId: choice.backend === 'claude' ? crypto.randomUUID() : undefined, addDirs, timeoutMs: 2 * 60 * 1000 });
    if (!r.ok || !r.sessionId) { console.log(`✗ priming ${base} (${choice.backend}) failed: ${r.error || 'no session id'}`); return null; }
    await updateSessions(base, s => { s.bases[choice.backend] = r.sessionId; });
    console.log(`✓ primed ${base} (${choice.label}) in ${r.secs}s`);
    return r.sessionId;
  })().finally(() => priming.delete(key));
  priming.set(key, p);
  return p;
}

// Answers one thread's pending question(s) and writes the result into the threads file.
// emit(ev) streams { t:'delta'|'reset' } events to the page.
async function answerThread(base, item, choice, emit) {
  const proj = resolveProjectDir(base);
  const addDirs = [ROOT].concat(proj.dir ? [proj.dir] : []);
  const warning = proj.stale ? `Linked project is missing (last seen at ${proj.lastKnownDir}) — answered without project context. Relink via 🔗 on the docs index.` : null;
  const onDelta = t => emit({ t: 'delta', text: t }), onReset = () => emit({ t: 'reset' });
  const fileEntry = (readThreadsFile(base) || {})[item.id];
  const history = fileEntry && Array.isArray(fileEntry.messages) ? fileEntry.messages : [];
  const own = loadSessions(base).threads[item.id];

  let r = null, sessionId = null;
  if (own && own.backend === choice.backend) {
    r = await runModel(choice, { prompt: buildThreadPrompt(base, item, { followup: true, primed: true }), resumeId: own.id, addDirs, onDelta, onReset });
    if (r.ok) sessionId = r.sessionId || own.id;
    else { console.log(`↻ resume failed for ${base}#${item.id} (${r.error}) — starting a fresh thread session`); onReset(); }
  }
  if (!r || !r.ok) {
    // New thread, a backend switch, or a dead session: fork the doc's primed base session and
    // replay the thread's history so nothing is lost.
    const prompt = opts => buildThreadPrompt(base, item, Object.assign({ followup: history.length > 0, history }, opts));
    let baseId = await ensureBase(base, choice);
    if (baseId) {
      const tid = choice.backend === 'claude' ? crypto.randomUUID() : undefined;
      r = await runModel(choice, { prompt: prompt({ primed: true }), resumeId: baseId, fork: true, sessionId: tid, addDirs, onDelta, onReset });
      if (!r.ok) {
        console.log(`↻ fork from base failed for ${base} (${r.error}) — re-priming`); onReset();
        await updateSessions(base, s => { if (s.bases[choice.backend] === baseId) delete s.bases[choice.backend]; });
        baseId = await ensureBase(base, choice);
        if (baseId) r = await runModel(choice, { prompt: prompt({ primed: true }), resumeId: baseId, fork: true, sessionId: choice.backend === 'claude' ? crypto.randomUUID() : undefined, addDirs, onDelta, onReset });
      }
    }
    if (!r || !r.ok) { onReset(); r = await runModel(choice, { prompt: prompt({ primed: false }), sessionId: choice.backend === 'claude' ? crypto.randomUUID() : undefined, addDirs, onDelta, onReset }); } // last resort: standalone
    if (r.ok) sessionId = r.sessionId;
  }
  if (!r.ok) return { ok: false, error: r.error, warning };

  // The bridge (not the model) writes the answer into the threads file, under the doc lock.
  const entry = await withQueue('doc:' + base, () => {
    if (!docExists(base)) return null;   // doc deleted while answering — don't resurrect its files
    const all = readThreadsFile(base);
    if (all === null) throw new Error('threads file is not valid JS — not overwriting it');
    const e = all[item.id] || { label: item.label, anchor: item.anchor, messages: [] };
    if (!Array.isArray(e.messages)) e.messages = [];
    item.questions.forEach(q => e.messages.push({ role: 'user', text: q }));
    e.messages.push({ role: 'claude', text: r.text, by: choice.label });
    all[item.id] = e;
    writeThreadsFile(base, all);
    if (sessionId) { const s = loadSessions(base); s.threads[item.id] = { backend: choice.backend, id: sessionId }; saveSessions(base, s); }
    return e;
  });
  if (!entry) return { ok: false, error: 'doc was deleted', warning };
  console.log(`✓ answered ${base}#${item.id} with ${choice.label} in ${r.secs}s`);
  return { ok: true, entry, warning };
}

/* ---------------------------------- server ---------------------------------- */
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__annot/ping') return sendJSON(res, 200, { ok: true, root: ROOT, v: 2 });
  if (url === '/__annot/models' && req.method === 'GET') return sendJSON(res, 200, getModels());

  const mutating = req.method === 'POST' && /^\/__annot\/(ask|prime|set-project|delete|delete-thread)$/.test(url);
  if (mutating && !originOk(req)) return sendJSON(res, 403, { ok: false, error: 'cross-origin request rejected' });

  if (req.method === 'POST' && url === '/__annot/prime') {
    return readBody(req, 1e4, j => {
      if (!j || !safeBase(j.base) || !docExists(j.base)) return sendJSON(res, 400, { ok: false, error: 'bad request' });
      const choice = normalizeChoice(j);
      ensureBase(j.base, choice).catch(() => {});   // background; the page doesn't wait
      sendJSON(res, 200, { ok: true });
    });
  }

  if (req.method === 'POST' && url === '/__annot/ask') {
    return readBody(req, 5e6, j => {
      if (!j || !safeBase(j.base)) return sendJSON(res, 400, { ok: false, error: 'bad request' });
      const choice = normalizeChoice(j);
      // Legacy batch shape ({ base, batch:[{id,label,anchor,questions}] }) → plain JSON reply.
      const items = Array.isArray(j.batch) ? j.batch : [{ id: j.id, label: j.label, anchor: j.anchor, questions: j.questions }];
      if (!items.length || !items.every(it => it && safeId(it.id) && Array.isArray(it.questions) && it.questions.length && it.questions.every(q => typeof q === 'string')))
        return sendJSON(res, 400, { ok: false, error: 'bad request' });
      const stream = !!j.stream && items.length === 1;
      if (stream) res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const emit = ev => { if (stream && !res.writableEnded) res.write(JSON.stringify(ev) + '\n'); };
      console.log(`→ ${items.length} thread(s) for ${j.base} via ${choice.label}`);
      (async () => {
        let last = { ok: true, error: null, warning: null };
        for (const item of items) {
          const r = await withQueue('thread:' + j.base + '#' + item.id, () => answerThread(j.base, item, choice, emit)).catch(e => ({ ok: false, error: e.message }));
          if (!r.ok) last = Object.assign({}, last, { ok: false, error: r.error });
          if (r.warning) last.warning = r.warning;
          if (r.entry) last.entry = r.entry;
        }
        return last;
      })().then(result => {
        if (stream) { emit(Object.assign({ t: 'done' }, result)); res.end(); }
        else sendJSON(res, 200, result);
      });
    });
  }

  if (req.method === 'POST' && url === '/__annot/delete-thread') {
    return readBody(req, 1e4, j => {
      if (!j || !safeBase(j.base) || !safeId(j.id)) return sendJSON(res, 400, { ok: false, error: 'bad request' });
      withQueue('doc:' + j.base, () => {
        const obj = readThreadsFile(j.base);
        if (obj === null) return { ok: false, error: 'threads file is not valid JS' };
        if (obj[j.id]) { delete obj[j.id]; writeThreadsFile(j.base, obj); }
        const s = loadSessions(j.base); if (s.threads[j.id]) { delete s.threads[j.id]; saveSessions(j.base, s); }
        console.log(`✗ deleted thread ${j.base}#${j.id}`);
        return { ok: true };
      }).then(r => sendJSON(res, 200, r), e => sendJSON(res, 500, { ok: false, error: e.message }));
    });
  }

  if (req.method === 'POST' && url === '/__annot/set-project') {
    return readBody(req, 1e4, j => {
      if (!j || !safeBase(j.base) || typeof j.dir !== 'string' || !j.dir.trim()) return sendJSON(res, 400, { ok: false, error: 'bad request' });
      const abs = path.resolve(j.dir.trim().replace(/^~(?=$|\/)/, os.homedir()));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return sendJSON(res, 400, { ok: false, error: 'not a directory: ' + abs });
      withQueue('doc:' + j.base, () => {
        const git = detectGit(abs);
        writeJSON(sidecarPath(j.base, 'project'), { dir: abs, git, linkedAt: Date.now() });
        // Grounding changed — drop primed base sessions so the next question re-primes.
        const s = loadSessions(j.base); s.bases = {}; saveSessions(j.base, s);
        console.log(`✓ ${j.base} now grounded in ${abs}` + (git ? ` (branch ${git.branch || '(detached)'})` : ''));
        return { ok: true, dir: abs };
      }).then(r => sendJSON(res, 200, r), e => sendJSON(res, 500, { ok: false, error: e.message }));
    });
  }

  if (req.method === 'POST' && url === '/__annot/delete') {
    return readBody(req, 1e4, j => {
      if (!j || !safeBase(j.base)) return sendJSON(res, 400, { ok: false, error: 'bad request' });
      withQueue('doc:' + j.base, () => {
        for (const suffix of ['.html', '.htm', '-threads.js', '-questions.json', '.sessions.json', '.project.json']) {
          try { fs.unlinkSync(path.join(ROOT, j.base + suffix)); } catch (e) {}
        }
        console.log(`✗ deleted ${j.base}`);
        return { ok: true };
      }).then(r => sendJSON(res, 200, r), e => sendJSON(res, 500, { ok: false, error: e.message }));
    });
  }

  if (req.method === 'GET') {
    if ((url === '/' || url === '/index.html') && !fs.existsSync(path.join(ROOT, 'index.html'))) return send(res, 200, generateIndex(), 'text/html');
    return serveStatic(req, res);
  }
  send(res, 405, 'method not allowed');
});

/* ---------- pick the doc to open, open a browser, find a free port ---------- */
function argDoc() { // open a specific doc only if one was passed on the command line
  const a = process.argv.slice(2).find(x => /\.html?$/i.test(x));
  return (a && fs.existsSync(path.join(ROOT, path.basename(a)))) ? path.basename(a) : null;
}
function esc2(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function generateIndex() { // an auto-listing home page when the folder has no index.html
  const items = fs.readdirSync(ROOT)
    .filter(f => /\.html?$/i.test(f) && f.toLowerCase() !== 'index.html')
    .map(f => ({ f, m: fs.statSync(path.join(ROOT, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const cards = items.map(d => {
    const base = d.f.replace(/\.html?$/i, '');
    const linked = readJSON(sidecarPath(base, 'project'), null);
    let metaLine = '';
    if (linked && linked.dir) {
      const proj = resolveProjectDir(base);
      metaLine = proj.stale
        ? `<small class="warn">⚠ moved/missing: ${esc2(proj.lastKnownDir)} — click 🔗 to relink</small>`
        : `<small>🔗 ${esc2(proj.dir)}${proj.relinked ? ' (auto-relinked)' : ''}</small>`;
    }
    return `<a class="c" href="/${encodeURIComponent(d.f)}">`
      + `<span class="meta"><b>${esc2(base)}</b>${metaLine}</span>`
      + `<span class="right"><span class="date">${new Date(d.m).toLocaleString()}</span>`
      + `<button class="link" data-base="${esc2(base)}" title="Set/change the source project this doc documents">🔗</button>`
      + `<button class="del" data-base="${esc2(base)}" title="Delete this doc">🗑</button></span></a>`;
  }).join('');
  const body = items.length ? `<div class="g">${cards}</div>` : `<p class="e">No docs here yet — ask Claude to make one in this folder.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Annotated docs</title>
<style>body{margin:0;background:#0f1115;color:#e7e9ee;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:64px 40px}h1{font-size:30px;margin:0 0 4px;letter-spacing:-.3px}
.sub{color:#9aa3b2;margin:0 0 28px}.g{display:grid;gap:10px}
.c{display:flex;justify-content:space-between;align-items:center;gap:12px;text-decoration:none;background:#161a21;border:1px solid #252b36;border-radius:12px;padding:14px 16px;color:#e7e9ee;transition:border-color .12s ease}
.c:hover{border-color:#7c9cff}.c b{font-size:16px;font-weight:600}.e{color:#9aa3b2}
@media (prefers-reduced-motion:reduce){.c{transition:none}}
.meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.meta small{color:#6d7583;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta small.warn{color:#e0b23a}
.right{display:flex;align-items:center;gap:4px;flex-shrink:0}
.date{color:#9aa3b2;font-size:12px;white-space:nowrap}
.link,.del{border:none;background:transparent;color:#9aa3b2;font-size:15px;cursor:pointer;padding:4px 6px;border-radius:6px;line-height:1}
.link:hover{background:rgba(124,156,255,.14);color:#7c9cff}
.del:hover{background:rgba(229,72,77,.14);color:#ff6b6f}</style></head>
<body><main><h1>Annotated docs</h1><p class="sub">Click a doc to open it — annotate, ask, get answers inline.</p>${body}</main>
<script>
document.querySelectorAll('.link').forEach(btn => btn.addEventListener('click', e => {
  e.preventDefault(); e.stopPropagation();
  const base = btn.dataset.base;
  const dir = prompt('Absolute path to the project this doc documents (for grounded answers):');
  if (!dir) return;
  fetch('/__annot/set-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base, dir }) })
    .then(r => r.json()).then(j => { if (j.ok) location.reload(); else alert('Failed: ' + (j.error || 'unknown error')); })
    .catch(() => alert('Failed — is the bridge still running?'));
}));
document.querySelectorAll('.del').forEach(btn => btn.addEventListener('click', e => {
  e.preventDefault(); e.stopPropagation();
  const base = btn.dataset.base;
  if (!confirm('Delete "' + base + '"? This removes its HTML and threads file.')) return;
  fetch('/__annot/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base }) })
    .then(r => r.json()).then(j => { if (j.ok) btn.closest('.c').remove(); else alert('Delete failed: ' + (j.error || 'unknown error')); })
    .catch(() => alert('Delete failed — is the bridge still running?'));
}));
</script>
</body></html>`;
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
  SELF_ORIGIN = `http://127.0.0.1:${port}`;
  setImmediate(() => { const m = getModels(); console.log(`  Claude: ${m.claude.available ? 'ready' : m.claude.reason} · Codex: ${m.codex.available ? 'ready' : m.codex.reason}`); });
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
