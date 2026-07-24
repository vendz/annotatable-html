/*!
 * annotate.js — drop-in, no-backend annotation layer for static HTML.
 * Select text, drag a region, or click an element → pin a Q&A thread that
 * lives in the browser. Copy a self-contained batch, paste it into any Claude
 * Code chat, Claude writes answers into "<name>-threads.js", reload → answers
 * render inline (with markdown). No API, no server.
 *
 * Flow (researched from tldraw / Figma / Hypothesis):
 *   • Text is zero-mode: select text → a Comment/Highlight pill appears.
 *   • Region (R) / Element (E) are quick tools that auto-revert to reading
 *     after one mark; a Lock keeps a tool active for placing several.
 *   • Threads expand INLINE in the right sidebar (not a popover).
 *   • Esc cancels · ⌘/Ctrl+Enter saves.
 *
 * USAGE — include AFTER a threads data file that defines window.ANNOTATE_THREADS:
 *   <script src="myfile-threads.js"></script>
 *   <script src="annotate.js"></script>
 * Optional config BEFORE this script:
 *   <script>window.ANNOTATE_CONFIG = { contentSelector:'main', threadsVar:'ANNOTATE_THREADS' }</script>
 *
 * All injected classes are prefixed `az-` and never touch host-page styles.
 */
(function () {
  const CFG = Object.assign({
    contentSelector: null,   // scope for text-select, region drag, pins (auto if null)
    elementSelector: 'p,h1,h2,h3,h4,h5,li,pre,blockquote,img,figure,table,[data-annot],.node,.card,.step,.box,.prob',
    threadsVar: 'ANNOTATE_THREADS',
  }, window.ANNOTATE_CONFIG || {});

  const content = (CFG.contentSelector && document.querySelector(CFG.contentSelector))
    || document.querySelector('main,article,.wrap') || document.body;
  if (getComputedStyle(content).position === 'static') content.style.position = 'relative';

  const KEY = 'annot::' + location.pathname;
  const ANSWERS = window[CFG.threadsVar] || {};
  const ELIG = CFG.elementSelector;

  const esc = s => (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const $ = s => document.querySelector(s);
  const uid = () => 't' + Math.random().toString(36).slice(2, 8);
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function persist() { localStorage.setItem(KEY, JSON.stringify(threads)); }

  let threads = load();
  let tool = 'select', locked = false, openId = null, filter = 'all';
  let BRIDGE = false, answering = {};   // auto-answer bridge (optional; see annotate-bridge.js)

  /* merge Claude's answers (from the -threads.js file) over local state */
  for (const id in ANSWERS) {
    if (!threads[id]) threads[id] = { type: ANSWERS[id].anchor && ANSWERS[id].anchor.type, anchor: ANSWERS[id].anchor, label: ANSWERS[id].label, messages: [] };
    threads[id].messages = (ANSWERS[id].messages || []).slice();
  }
  persist();

  /* ============================== styles ============================== */
  const CSS = `
  .az-hl{background:rgba(224,178,58,.20);box-shadow:inset 0 -2px 0 rgba(224,178,58,.7);border-radius:2px;padding:0 .5px;cursor:pointer;color:inherit}
  .az-hl.az-done{background:rgba(62,207,122,.20);box-shadow:inset 0 -2px 0 rgba(62,207,122,.7)}
  .az-hl.az-focus{background:rgba(124,156,255,.30);box-shadow:inset 0 -2px 0 #7c9cff}
  .az-el-mark{outline:2px solid rgba(224,178,58,.7);outline-offset:3px;border-radius:6px}
  .az-el-mark.az-done{outline-color:rgba(62,207,122,.7)}
  .az-el-mark.az-focus{outline-color:#7c9cff}
  .az-region{position:absolute;border:2px solid rgba(224,178,58,.7);background:rgba(224,178,58,.14);border-radius:6px;cursor:pointer;z-index:5}
  .az-region.az-done{border-color:rgba(62,207,122,.7);background:rgba(62,207,122,.14)}
  .az-region.az-focus{border-color:#7c9cff;background:rgba(124,156,255,.14)}
  #az-band{position:absolute;border:2px dashed #7c9cff;background:rgba(124,156,255,.12);border-radius:6px;z-index:8;display:none;pointer-events:none}
  .az-pin{position:absolute;z-index:9;min-width:20px;height:20px;padding:0 5px;border-radius:999px;border:none;background:#e0b23a;color:#241b00;
    font:600 11px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;
    box-shadow:0 2px 8px rgba(0,0,0,.4);transform:translate(-4px,-10px)}
  .az-pin.az-done{background:#3ecf7a;color:#04220f}
  .az-pin.az-focus,.az-pin:hover{outline:2px solid #fff;transform:translate(-4px,-10px) scale(1.12)}

  .az-dock{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:4px;
    background:#161a21;border:1px solid #252b36;border-radius:14px;padding:6px;box-shadow:0 10px 34px rgba(0,0,0,.5);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .az-dock .az-master{display:flex;align-items:center;gap:7px;font:600 13px inherit;color:#e7e9ee;background:transparent;border:none;cursor:pointer;border-radius:9px;padding:7px 11px}
  .az-dock .az-led{width:8px;height:8px;border-radius:50%;background:#3a4150}
  body.az-on .az-dock .az-led{background:#7c9cff;box-shadow:0 0 8px #7c9cff}
  .az-tools{display:none;align-items:center;gap:3px;padding-left:4px;margin-left:2px;border-left:1px solid #252b36}
  body.az-on .az-tools{display:flex}
  .az-tool{position:relative;width:38px;height:38px;border-radius:9px;border:1px solid transparent;background:transparent;color:#9aa3b2;cursor:pointer;
    font-size:17px;display:flex;align-items:center;justify-content:center}
  .az-tool:hover{background:#12161d;color:#e7e9ee}
  .az-tool.az-active{background:#7c9cff;color:#0b1020;border-color:#7c9cff}
  .az-tool .az-kbd{position:absolute;bottom:2px;right:3px;font-size:8.5px;opacity:.65}
  .az-tool.az-lock.az-lockon{background:#12161d;color:#7c9cff;border-color:#252b36}
  .az-dock .az-div{width:1px;height:24px;background:#252b36;margin:0 3px}
  .az-dock .az-txt{font:600 13px inherit;color:#e7e9ee;background:transparent;border:none;cursor:pointer;border-radius:9px;padding:7px 11px}
  .az-dock .az-txt:hover{background:#12161d}
  .az-dock .az-txt .az-n{color:#9aa3b2;font-weight:500;margin-left:3px}
  .az-tool[data-tip]:hover::after,.az-dock [data-tip]:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 8px);left:50%;
    transform:translateX(-50%);white-space:nowrap;background:#000;color:#fff;font:500 11px inherit;padding:4px 8px;border-radius:6px;pointer-events:none}
  .az-dock [data-tip]{position:relative}

  body.az-region-mode{cursor:crosshair}
  body.az-element-mode .az-el-hover{outline:2px dashed #7c9cff;outline-offset:3px;border-radius:6px;background:rgba(124,156,255,.06)}

  .az-adder{position:fixed;z-index:2147483001;display:none;background:#161a21;border:1px solid #252b36;border-radius:10px;
    box-shadow:0 8px 24px rgba(0,0,0,.5);overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .az-adder button{border:none;background:transparent;color:#e7e9ee;font:600 12.5px inherit;padding:8px 12px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
  .az-adder button:hover{background:#7c9cff;color:#0b1020}
  .az-adder button+button{border-left:1px solid #252b36}

  .az-rail{position:fixed;top:0;right:0;height:100vh;width:360px;max-width:100vw;background:#161a21;border-left:1px solid #252b36;
    transform:translateX(100%);transition:transform .2s;z-index:2147483000;display:flex;flex-direction:column;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e7e9ee}
  body.az-railopen .az-rail{transform:none}
  body{box-sizing:border-box;transition:padding-right .2s ease}
  body.az-railopen{padding-right:360px}                     /* push page content out from under the rail */
  @media (max-width:760px){ .az-rail{width:100vw} body.az-railopen{padding-right:0} }
  .az-rail header{padding:14px 16px;border-bottom:1px solid #252b36;display:flex;align-items:center;gap:8px}
  .az-rail header b{font-size:14px}
  .az-rail .az-x{background:transparent;border:none;color:#9aa3b2;cursor:pointer;font-size:16px;margin-left:auto}
  .az-filters{display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid #252b36}
  .az-chip{font:500 12px inherit;color:#9aa3b2;background:#12161d;border:1px solid #252b36;border-radius:999px;padding:4px 11px;cursor:pointer}
  .az-chip.az-on{background:#7c9cff;color:#0b1020;border-color:#7c9cff;font-weight:600}
  .az-list{flex:1;overflow:auto;padding:10px}
  .az-card{border:1px solid #252b36;border-left:3px solid #e0b23a;border-radius:11px;padding:10px 11px;margin-bottom:9px;cursor:pointer;background:#12161d}
  .az-card.az-done{border-left-color:#3ecf7a}
  .az-card.az-hlonly{border-left-style:dashed}
  .az-card.az-focus{border-color:#7c9cff}
  .az-card.az-active{cursor:default;background:#1a1f27;border-color:#7c9cff;box-shadow:0 6px 22px rgba(124,156,255,.14);padding:12px 13px}
  .az-card .az-collapse{margin-left:auto;background:transparent;border:none;color:#9aa3b2;cursor:pointer;font-size:13px;line-height:1;padding:2px 4px;border-radius:6px}
  .az-card .az-collapse:hover{color:#e7e9ee;background:#12161d}
  .az-card .az-top{display:flex;align-items:center;gap:7px;margin-bottom:5px}
  .az-card .az-type{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#9aa3b2}
  .az-card .az-st{margin-left:auto;font-size:10px;font-weight:700;padding:1px 7px;border-radius:999px}
  .az-card .az-st.az-open{color:#e0b23a;background:rgba(224,178,58,.16)}
  .az-card .az-st.az-doneb{color:#3ecf7a;background:rgba(62,207,122,.16)}
  .az-card .az-lbl{font-size:13px;color:#d4d8e2;line-height:1.45;font-style:italic}
  .az-card .az-q{font-size:12.5px;color:#9aa3b2;margin-top:5px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .az-empty{color:#9aa3b2;font-size:13px;line-height:1.6;padding:22px 18px}
  .az-empty kbd{background:#12161d;border:1px solid #252b36;border-radius:5px;padding:1px 6px;font:600 11px inherit;color:#e7e9ee}
  .az-rail footer{padding:12px;border-top:1px solid #252b36}
  .az-rail footer .az-btn{width:100%;text-align:center;padding:9px}

  .az-msgs{display:flex;flex-direction:column;gap:11px;margin-top:11px}
  .az-msg{font-size:13.5px;line-height:1.55}
  .az-msg .az-who{font-size:9.5px;text-transform:uppercase;letter-spacing:.7px;color:#9aa3b2;display:block;margin-bottom:4px}
  .az-msg.az-user .az-bubble{color:#fff}
  .az-msg.az-claude .az-bubble{color:#cdd4e6;background:#0f1319;border-radius:10px;padding:9px 11px;border:1px solid #252b36}
  .az-bubble p{font-size:13.5px;line-height:1.55;margin:0 0 7px;color:inherit}
  .az-bubble p:last-child{margin-bottom:0}
  .az-bubble ul,.az-bubble ol{margin:5px 0 7px;padding-left:19px}
  .az-bubble li{font-size:13.5px;line-height:1.5;margin:3px 0;color:inherit}
  .az-bubble h4{font-size:13.5px;font-weight:650;color:#fff;margin:8px 0 4px}
  .az-bubble strong{color:#fff;font-weight:650}
  .az-bubble em{font-style:italic}
  .az-bubble code{background:#0b0e13;border:1px solid #252b36;border-radius:5px;padding:0 5px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .az-bubble pre{background:#0b0e13;border:1px solid #252b36;border-radius:8px;padding:9px 11px;overflow:auto;margin:6px 0}
  .az-bubble pre code{background:none;border:none;padding:0}
  .az-bubble a{color:#7c9cff}
  .az-compose{margin-top:11px;padding-top:11px;border-top:1px solid #252b36}
  .az-compose textarea{box-sizing:border-box;width:100%;max-width:100%;font:inherit;font-size:13.5px;background:#0f1319;border:1px solid #252b36;color:#e7e9ee;border-radius:9px;padding:8px 9px;resize:vertical;min-height:44px}
  .az-compose textarea:focus{outline:none;border-color:#7c9cff}
  .az-compose .az-row{display:flex;align-items:center;gap:8px;margin-top:8px}
  .az-compose .az-hint{font-size:10.5px;color:#9aa3b2;flex:1}
  .az-btn{font:inherit;font-size:12.5px;cursor:pointer;border-radius:8px;border:1px solid #252b36;background:#12161d;color:#e7e9ee;padding:6px 11px}
  .az-btn:hover{border-color:#7c9cff;color:#fff}
  .az-btn.az-primary{background:#7c9cff;color:#0b1020;border-color:#7c9cff;font-weight:650}
  .az-btn.az-danger:hover{border-color:#e5484d;color:#ff6b6f}
  .az-btn.az-ghost{background:transparent}

  .az-railtab{position:fixed;right:0;top:88px;z-index:2147482999;background:#161a21;border:1px solid #252b36;border-right:none;border-radius:10px 0 0 10px;
    color:#e7e9ee;font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:9px 10px;cursor:pointer;writing-mode:vertical-rl;display:flex;align-items:center;gap:6px}
  body.az-railopen .az-railtab{display:none}
  .az-railtab .az-n{background:#7c9cff;color:#0b1020;border-radius:999px;padding:1px 6px;font-size:10px;writing-mode:horizontal-tb}

  .az-toast{position:fixed;bottom:78px;left:50%;transform:translateX(-50%);background:#e7e9ee;color:#0f1115;font:600 12.5px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    padding:9px 15px;border-radius:10px;opacity:0;transition:.2s;pointer-events:none;z-index:2147483002}
  .az-toast.az-show{opacity:1}
  @media (prefers-reduced-motion:reduce){.az-rail{transition:none}}
  `;
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

  /* ============================== controls ============================== */
  const ui = document.createElement('div');
  ui.innerHTML = `
  <button class="az-railtab" id="az-railtab">💬 Threads <span class="az-n" id="az-tabn">0</span></button>
  <aside class="az-rail" id="az-rail">
    <header><b>💬 Threads</b><button class="az-x" id="az-closeRail" data-tip="Close">✕</button></header>
    <div class="az-filters">
      <button class="az-chip az-on" data-filter="all">All</button>
      <button class="az-chip" data-filter="open">Unanswered</button>
      <button class="az-chip" data-filter="done">Answered</button>
    </div>
    <div class="az-list" id="az-list"></div>
    <footer><button class="az-btn az-primary" id="az-copyBtn">📋 Copy questions for Claude</button></footer>
  </aside>
  <div class="az-dock" id="az-dock">
    <button class="az-master" id="az-master"><span class="az-led"></span>💬 Annotate</button>
    <div class="az-tools">
      <button class="az-tool az-active" data-tool="select" data-tip="Read / select — V">↖<span class="az-kbd">V</span></button>
      <button class="az-tool" data-tool="region" data-tip="Region box — R">▭<span class="az-kbd">R</span></button>
      <button class="az-tool" data-tool="element" data-tip="Element — E">◎<span class="az-kbd">E</span></button>
      <button class="az-tool az-lock" id="az-lock" data-tip="Tool lock — place many">🔒</button>
      <span class="az-div"></span>
      <button class="az-txt" id="az-dockThreads">Threads<span class="az-n" id="az-dockn">0</span></button>
    </div>
  </div>
  <div id="az-band"></div>
  <div class="az-adder" id="az-adder">
    <button id="az-addComment">💬 Comment</button>
    <button id="az-addHighlight">✏️ Highlight</button>
  </div>
  <div class="az-toast" id="az-toast"></div>`;
  document.body.appendChild(ui);

  function toast(t) { const el = $('#az-toast'); el.textContent = t; el.classList.add('az-show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('az-show'), 1500); }
  function stateOf(t) { if (t.messages.some(m => m.role === 'claude')) return 'done'; if (t.messages.some(m => m.role === 'user')) return 'open'; return 'hl'; }

  /* ===================== markdown (safe: escape then subset) ===================== */
  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function md(src) {
    const lines = esc(src || '').split(/\r?\n/);
    let html = '', inUL = false, inOL = false, para = [], fence = false, code = [];
    const closeLists = () => { if (inUL) { html += '</ul>'; inUL = false; } if (inOL) { html += '</ol>'; inOL = false; } };
    const flush = () => { if (para.length) { html += '<p>' + inlineMd(para.join('<br>')) + '</p>'; para = []; } };
    for (const raw of lines) {
      if (/^```/.test(raw.trim())) { if (fence) { html += '<pre><code>' + code.join('\n') + '</code></pre>'; code = []; fence = false; } else { flush(); closeLists(); fence = true; } continue; }
      if (fence) { code.push(raw); continue; }
      const line = raw.trim(); let m;
      if (!line) { flush(); continue; }
      if ((m = line.match(/^#{1,4}\s+(.*)$/))) { flush(); closeLists(); html += '<h4>' + inlineMd(m[1]) + '</h4>'; continue; }
      if ((m = line.match(/^(\d+)[.)]\s+(.*)$/))) { flush(); if (inUL) { html += '</ul>'; inUL = false; } if (!inOL) { html += '<ol>'; inOL = true; } html += '<li>' + inlineMd(m[2]) + '</li>'; continue; }
      if ((m = line.match(/^[-*]\s+(.*)$/))) { flush(); if (inOL) { html += '</ol>'; inOL = false; } if (!inUL) { html += '<ul>'; inUL = true; } html += '<li>' + inlineMd(m[1]) + '</li>'; continue; }
      closeLists(); para.push(line);
    }
    if (fence) html += '<pre><code>' + code.join('\n') + '</code></pre>';
    flush(); closeLists();
    return html;
  }

  /* ===================== anchoring helpers ===================== */
  function textIndex() {
    const w = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
    let full = '', segs = [], n;
    while ((n = w.nextNode())) { if (!n.nodeValue) continue; segs.push({ node: n, start: full.length, end: full.length + n.nodeValue.length }); full += n.nodeValue; }
    return { full, segs };
  }
  function posToNode(segs, pos) { for (const s of segs) if (pos >= s.start && pos <= s.end) return { node: s.node, offset: pos - s.start }; const l = segs[segs.length - 1]; return { node: l.node, offset: l.node.nodeValue.length }; }
  function rangeFromText(exact, prefix) {
    const { full, segs } = textIndex(); if (!segs.length) return null;
    let i = prefix != null ? full.indexOf(prefix + exact) : -1;
    if (i >= 0) i += prefix.length; else i = full.indexOf(exact);
    if (i < 0) return null;
    const a = posToNode(segs, i), b = posToNode(segs, i + exact.length);
    const r = document.createRange(); r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); return r;
  }
  function contextAround(range) {
    const { full, segs } = textIndex(); const seg = segs.find(s => s.node === range.startContainer);
    if (!seg) return { prefix: '' };
    const gs = seg.start + range.startOffset; return { prefix: full.slice(Math.max(0, gs - 24), gs) };
  }
  function wrapRange(range, id, done) {
    const mark = document.createElement('mark'); mark.className = 'az-hl' + (done ? ' az-done' : ''); mark.dataset.tid = id;
    try { mark.appendChild(range.extractContents()); range.insertNode(mark); } catch (e) { return null; }
    return mark;
  }
  function selectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el !== content && el.nodeType === 1) {
      let p = el.tagName.toLowerCase();
      const sib = Array.from(el.parentNode.children).filter(c => c.tagName === el.tagName);
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')';
      parts.unshift(p); el = el.parentNode;
    }
    return parts.join('>');
  }
  function elFromAnchor(a) {
    let el = null; try { el = content.querySelector(a.sel); } catch (e) {}
    if (el) return el;
    if (a.tag) { const c = [...content.querySelectorAll(a.tag)]; el = c.find(e => e.textContent.trim().slice(0, 120) === a.text) || c.find(e => a.text && e.textContent.trim().slice(0, 60) === a.text.slice(0, 60)); }
    return el || null;
  }

  /* ===================== render marks + pins ===================== */
  const pins = {};
  function clearMarks() {
    content.querySelectorAll('mark.az-hl').forEach(m => { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize && p.normalize(); });
    content.querySelectorAll('.az-region').forEach(r => r.remove());
    content.querySelectorAll('.az-el-mark').forEach(e => e.classList.remove('az-el-mark', 'az-done', 'az-focus'));
    content.querySelectorAll('.az-pin').forEach(p => p.remove());
  }
  function markRect(id) {
    const t = threads[id]; if (!t) return null;
    if (t.type === 'text') { const m = content.querySelector('mark.az-hl[data-tid="' + id + '"]'); return m && m.getClientRects()[0]; }
    if (t.type === 'region') { const r = content.querySelector('.az-region[data-tid="' + id + '"]'); return r && r.getBoundingClientRect(); }
    if (t.type === 'element') { const e = elFromAnchor(t.anchor); return e && e.getBoundingClientRect(); }
  }
  function docOrder() { return Object.keys(threads).map(id => ({ id, y: (markRect(id) || {}).top ?? 1e9 })).sort((a, b) => a.y - b.y).map(o => o.id); }
  function renderMarks() {
    clearMarks();
    const cr = content.getBoundingClientRect();
    for (const id in threads) {
      const t = threads[id], done = stateOf(t) === 'done';
      if (t.type === 'text') { const r = rangeFromText(t.anchor.exact, t.anchor.prefix); if (r) wrapRange(r, id, done); }
      else if (t.type === 'region') {
        const b = document.createElement('div'); b.className = 'az-region' + (done ? ' az-done' : ''); b.dataset.tid = id;
        b.style.left = (t.anchor.x * content.offsetWidth) + 'px'; b.style.top = (t.anchor.y * content.offsetHeight) + 'px';
        b.style.width = (t.anchor.w * content.offsetWidth) + 'px'; b.style.height = (t.anchor.h * content.offsetHeight) + 'px';
        content.appendChild(b);
      } else if (t.type === 'element') { const e = elFromAnchor(t.anchor); if (e) { e.classList.add('az-el-mark'); if (done) e.classList.add('az-done'); } }
    }
    docOrder().forEach(id => {
      const t = threads[id], st = stateOf(t), rect = markRect(id); if (!rect) return;
      const pin = document.createElement('button'); pin.className = 'az-pin' + (st === 'done' ? ' az-done' : ''); pin.dataset.tid = id;
      const uc = t.messages.filter(m => m.role === 'user').length;
      pin.textContent = st === 'done' ? '✓' : (uc ? String(uc) : '·');
      pin.style.left = (rect.left - cr.left + (t.type === 'element' ? rect.width - 6 : rect.width)) + 'px';
      pin.style.top = (rect.top - cr.top) + 'px';
      pin.onclick = e => { e.stopPropagation(); openThread(id); };
      pin.onmouseenter = () => focusMark(id, true); pin.onmouseleave = () => focusMark(id, false);
      content.appendChild(pin); pins[id] = pin;
    });
  }
  function focusMark(id, on) {
    const t = threads[id]; if (!t) return;
    if (t.type === 'text') content.querySelectorAll('mark.az-hl[data-tid="' + id + '"]').forEach(m => m.classList.toggle('az-focus', on));
    if (t.type === 'region') { const r = content.querySelector('.az-region[data-tid="' + id + '"]'); r && r.classList.toggle('az-focus', on); }
    if (t.type === 'element') { const e = elFromAnchor(t.anchor); e && e.classList.toggle('az-focus', on); }
    pins[id] && pins[id].classList.toggle('az-focus', on);
    const card = $('#az-list .az-card[data-tid="' + id + '"]'); card && card.classList.toggle('az-focus', on);
  }

  /* ===================== rail (threads expand inline) ===================== */
  const TYPE = { text: '✎ text', region: '▭ region', element: '◎ element' };
  function renderRail() {
    const list = $('#az-list'); const ids = docOrder();
    $('#az-tabn').textContent = $('#az-dockn').textContent = ids.length;
    const shown = ids.filter(id => { const s = stateOf(threads[id]); if (filter === 'all') return true; if (filter === 'open') return s === 'open' || s === 'hl'; return s === 'done'; });
    if (!ids.length) { list.innerHTML = '<div class="az-empty"><b>No annotations yet.</b><br><br>Turn on <b>Annotate</b>, then:<br>• <b>Select text</b> → Comment pill appears<br>• <kbd>R</kbd> → drag a box over anything<br>• <kbd>E</kbd> → click a whole block</div>'; return; }
    if (!shown.length) { list.innerHTML = '<div class="az-empty">Nothing in this filter.</div>'; return; }
    list.innerHTML = '';
    shown.forEach(id => {
      const t = threads[id], s = stateOf(t), open = (id === openId);
      const card = document.createElement('div');
      card.className = 'az-card ' + (s === 'done' ? 'az-done ' : s === 'hl' ? 'az-hlonly ' : '') + (open ? 'az-active' : ''); card.dataset.tid = id;
      let html = '<div class="az-top"><span class="az-type">' + TYPE[t.type] + '</span>'
        + (s === 'hl' ? '' : '<span class="az-st ' + (s === 'done' ? 'az-doneb' : 'az-open') + '">' + (s === 'done' ? 'Answered' : 'Open') + '</span>')
        + (open ? '<button class="az-collapse" data-collapse data-tip="Collapse">▾</button>' : '') + '</div>'
        + '<div class="az-lbl">“' + esc(t.label) + '”</div>';
      if (open) {
        if (t.messages.length) { html += '<div class="az-msgs">'; t.messages.forEach(m => { html += '<div class="az-msg az-' + m.role + '"><span class="az-who">' + (m.role === 'user' ? 'You' : 'Claude') + '</span><div class="az-bubble">' + md(m.text) + '</div></div>'; }); html += '</div>'; }
        if (answering[id]) html += '<div style="font-size:12.5px;color:#7c9cff;margin-top:11px">⏳ Claude is answering…</div>';
        html += '<div class="az-compose"><textarea placeholder="Ask Claude about this…"></textarea>'
          + '<div class="az-row"><span class="az-hint">⌘/Ctrl+Enter to save</span>'
          + '<button class="az-btn az-ghost az-danger" data-del>Delete</button>'
          + '<button class="az-btn az-primary" data-save>Save</button></div></div>';
      } else {
        const q = (t.messages.find(m => m.role === 'user') || {}).text || '';
        if (q) html += '<div class="az-q">' + esc(q) + '</div>';
      }
      card.innerHTML = html;
      card.onmouseenter = () => focusMark(id, true); card.onmouseleave = () => focusMark(id, false);
      if (open) {
        card.querySelector('[data-collapse]').onclick = e => { e.stopPropagation(); closeThread(); };
        card.querySelector('[data-save]').onclick = e => { e.stopPropagation(); saveMsg(id); };
        card.querySelector('[data-del]').onclick = e => { e.stopPropagation(); delete threads[id]; persist(); openId = null; renderAll(); toast('Deleted'); };
        card.querySelector('textarea').addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveMsg(id); } });
        card.onclick = e => { if (e.target.closest('button,textarea,a')) return; scrollToMark(id); };
      } else { card.onclick = () => openThread(id); }
      list.appendChild(card);
    });
  }
  function scrollToMark(id) { const r = markRect(id); if (!r) return; window.scrollTo({ top: Math.max(0, window.scrollY + r.top - 160), behavior: 'smooth' }); }
  function openThread(id) {
    openId = id; document.body.classList.add('az-railopen'); renderRail(); scrollToMark(id);
    const ac = $('#az-list .az-card.az-active'); if (ac) { ac.scrollIntoView({ block: 'nearest' }); const ta = ac.querySelector('textarea'); ta && ta.focus({ preventScroll: true }); }
  }
  function closeThread() { openId = null; renderRail(); }
  function saveMsg(id) {
    const ac = $('#az-list .az-card.az-active'); const ta = ac && ac.querySelector('textarea'); if (!ta) return;
    const v = ta.value.trim(); if (!v) return;
    threads[id].messages.push({ role: 'user', text: v }); persist(); renderMarks(); renderRail();
    if (BRIDGE) askBridge(id);                      // auto-answer via the local bridge
    else toast('Saved — hit Copy for Claude when ready');
    const t2 = $('#az-list .az-card.az-active textarea'); t2 && t2.focus({ preventScroll: true });
  }

  /* ===================== text (always-on adder) ===================== */
  const adder = $('#az-adder'); let pendingRange = null;
  document.addEventListener('mouseup', e => {
    if (!document.body.classList.contains('az-on') || tool !== 'select') return;
    if (adder.contains(e.target) || $('#az-dock').contains(e.target) || $('#az-rail').contains(e.target)) return;
    const sel = window.getSelection();
    setTimeout(() => {
      if (!sel || sel.isCollapsed) { hideAdder(); return; }
      const r = sel.getRangeAt(0);
      if (!content.contains(r.commonAncestorContainer) || sel.toString().trim().length < 2) { hideAdder(); return; }
      pendingRange = r.cloneRange();
      const rect = r.getBoundingClientRect();
      adder.style.display = 'block';
      let l = rect.left + rect.width / 2 - adder.offsetWidth / 2; l = Math.max(8, Math.min(l, innerWidth - adder.offsetWidth - 8));
      adder.style.left = l + 'px'; adder.style.top = Math.max(8, rect.top - adder.offsetHeight - 8) + 'px';
    }, 0);
  });
  function hideAdder() { adder.style.display = 'none'; pendingRange = null; }
  function makeText(withComment) {
    if (!pendingRange) return;
    const exact = pendingRange.toString().trim(); const { prefix } = contextAround(pendingRange);
    const id = uid(); threads[id] = { type: 'text', anchor: { type: 'text', exact, prefix }, label: exact.slice(0, 80), messages: [] };
    persist(); window.getSelection().removeAllRanges(); hideAdder(); renderAll();
    if (withComment) openThread(id); else toast('Highlighted');
  }
  $('#az-addComment').onclick = () => makeText(true);
  $('#az-addHighlight').onclick = () => makeText(false);

  /* ===================== region (drag a box) ===================== */
  const band = $('#az-band'); let dragging = null;
  content.addEventListener('mousedown', e => {
    if (tool !== 'region' || !document.body.classList.contains('az-on')) return;
    if (e.target.closest('.az-pin,.az-region')) return;
    e.preventDefault();
    const cr = content.getBoundingClientRect(); dragging = { x0: e.clientX - cr.left, y0: e.clientY - cr.top };
    band.style.display = 'block'; band.style.left = dragging.x0 + 'px'; band.style.top = dragging.y0 + 'px'; band.style.width = '0px'; band.style.height = '0px';
    content.appendChild(band);
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return; const cr = content.getBoundingClientRect();
    const x = e.clientX - cr.left, y = e.clientY - cr.top;
    const l = Math.min(x, dragging.x0), t = Math.min(y, dragging.y0), w = Math.abs(x - dragging.x0), h = Math.abs(y - dragging.y0);
    band.style.left = l + 'px'; band.style.top = t + 'px'; band.style.width = w + 'px'; band.style.height = h + 'px'; dragging.box = { l, t, w, h };
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return; const box = dragging.box; dragging = null; band.style.display = 'none';
    if (!box || box.w < 12 || box.h < 12) return;
    const id = uid();
    threads[id] = { type: 'region', anchor: { type: 'region', x: box.l / content.offsetWidth, y: box.t / content.offsetHeight, w: box.w / content.offsetWidth, h: box.h / content.offsetHeight }, label: 'region near ' + nearestHeading(box.t), messages: [] };
    persist(); renderAll(); openThread(id); if (!locked) setTool('select');
  });
  function nearestHeading(topPx) { let best = 'the page'; content.querySelectorAll('h1,h2,h3').forEach(h => { if (h.offsetTop <= topPx + 20) best = h.textContent; }); return best.trim().slice(0, 40); }

  /* ===================== element (hover-outline → click) ===================== */
  let hoverEl = null;
  content.addEventListener('mousemove', e => {
    if (tool !== 'element' || !document.body.classList.contains('az-on')) return;
    const el = e.target.closest(ELIG); if (el === hoverEl) return;
    hoverEl && hoverEl.classList.remove('az-el-hover');
    hoverEl = el && content.contains(el) ? el : null; hoverEl && hoverEl.classList.add('az-el-hover');
  });
  content.addEventListener('click', e => {
    if (tool !== 'element' || !document.body.classList.contains('az-on')) return;
    const el = e.target.closest(ELIG); if (!el || !content.contains(el)) return;
    e.preventDefault(); e.stopPropagation(); el.classList.remove('az-el-hover'); hoverEl = null;
    const id = uid();
    threads[id] = { type: 'element', anchor: { type: 'element', sel: selectorFor(el), tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 120) }, label: (el.textContent || el.tagName).trim().slice(0, 80), messages: [] };
    persist(); renderAll(); openThread(id); if (!locked) setTool('select');
  }, true);

  /* reopen a mark's thread (in select mode) */
  content.addEventListener('click', e => {
    if (tool !== 'select') return;
    const m = e.target.closest('mark.az-hl'); if (m) { openThread(m.dataset.tid); return; }
    const r = e.target.closest('.az-region'); if (r) openThread(r.dataset.tid);
  });

  /* ===================== tools + shortcuts ===================== */
  function setTool(t) {
    tool = t; hideAdder();
    document.querySelectorAll('.az-tool[data-tool]').forEach(b => b.classList.toggle('az-active', b.dataset.tool === t));
    document.body.classList.toggle('az-region-mode', t === 'region');
    document.body.classList.toggle('az-element-mode', t === 'element');
    if (t !== 'element' && hoverEl) { hoverEl.classList.remove('az-el-hover'); hoverEl = null; }
  }
  document.querySelectorAll('.az-tool[data-tool]').forEach(b => b.onclick = () => { setAnnot(true); setTool(b.dataset.tool); });
  $('#az-lock').onclick = () => { locked = !locked; $('#az-lock').classList.toggle('az-lockon', locked); toast(locked ? 'Tool lock ON — place many' : 'Tool lock off'); };
  function setAnnot(on) { document.body.classList.toggle('az-on', on); if (!on) { setTool('select'); hideAdder(); closeThread(); } }
  $('#az-master').onclick = () => { const on = !document.body.classList.contains('az-on'); setAnnot(on); if (on) { document.body.classList.add('az-railopen'); toast('Select text · R region · E element'); } };
  document.addEventListener('keydown', e => {
    if (/^(input|textarea)$/i.test(e.target.tagName)) return;
    if (e.key === 'Escape') { if (openId) closeThread(); else if (tool !== 'select') setTool('select'); hideAdder(); return; }
    if (!document.body.classList.contains('az-on')) return;
    if (e.key === 'v' || e.key === 'V') setTool('select');
    if (e.key === 'r' || e.key === 'R') setTool('region');
    if (e.key === 'e' || e.key === 'E') setTool('element');
  });

  /* rail open/close + filters + copy */
  $('#az-railtab').onclick = () => { document.body.classList.add('az-railopen'); renderRail(); };
  $('#az-dockThreads').onclick = () => { document.body.classList.toggle('az-railopen'); renderRail(); };
  $('#az-closeRail').onclick = () => document.body.classList.remove('az-railopen');
  document.querySelectorAll('.az-chip').forEach(c => c.onclick = () => { filter = c.dataset.filter; document.querySelectorAll('.az-chip').forEach(x => x.classList.toggle('az-on', x === c)); renderRail(); });
  $('#az-copyBtn').onclick = () => {
    const batch = Object.entries(threads).filter(([id, t]) => t.messages.some(m => m.role === 'user'))
      .map(([id, t]) => ({ id, label: t.label, anchor: t.anchor, questions: t.messages.filter(m => m.role === 'user').map(m => m.text) }));
    if (!batch.length) { toast('No questions yet'); return; }
    const base = (location.pathname.split('/').pop() || '').replace(/\.html?$/i, '') || 'page';
    const threadsFile = base + '-threads.js';
    const fullPath = location.protocol === 'file:'
      ? decodeURIComponent(location.pathname).replace(/[^/]+$/, threadsFile)
      : threadsFile + '  (sibling of this HTML file; page served from ' + location.href + ')';
    const text =
`You are answering a reader's questions that are pinned to a local HTML document. Write your
answers into this file (create it if it does not exist):

  ${fullPath}

That file assigns a single global: window.${CFG.threadsVar} = { <id>: {...}, ... }
Merge the entries below into it, keyed by "id". Rules:
  • Keep each "label" and "anchor" EXACTLY as given — that is how the page re-locates the mark.
  • "messages" is an ordered array. For each item, append {role:"user",text:<their question>}
    followed immediately by {role:"claude",text:<your answer>}. Preserve existing messages.
    Answers may use markdown (bold, lists, code) — it renders in the sidebar.
  • If the file is new, write:  window.${CFG.threadsVar} = { ...these entries... };
  • This is a plain file edit. Do NOT commit, push, or touch git.

When done, the reader reloads the page: pins turn green and answers appear inline.

Shape to write per id:
  "<id>": { "label":"…", "anchor":{…}, "messages":[
      {"role":"user","text":"…"}, {"role":"claude","text":"…"} ] }

Questions to answer (${batch.length}):
${JSON.stringify(batch, null, 2)}`;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => toast('Copied ' + batch.length + ' thread(s)'), () => {
        const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;top:40%;left:10%;width:80%;height:40%;z-index:2147483003'; document.body.appendChild(ta); ta.select(); toast('Select-all + copy, then remove box');
      });
  };

  /* ===================== auto-answer bridge (optional) ===================== */
  function baseName() { return (location.pathname.split('/').pop() || '').replace(/\.html?$/i, '') || 'page'; }
  function threadsFileName() { return baseName() + '-threads.js'; }
  async function detectBridge() {
    try {
      const r = await fetch('/__annot/ping', { cache: 'no-store' });
      if (r.ok && (await r.json()).ok) { BRIDGE = true; const b = document.querySelector('.az-rail header b'); if (b) b.textContent = '💬 Threads · ⚡ live'; }
    } catch (e) { /* no bridge → copy-paste fallback stays */ }
  }
  async function refetchThreads() {
    try {
      const r = await fetch(threadsFileName() + '?ts=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return;
      const text = await r.text(); (0, eval)(text);              // reassigns window[threadsVar] from our own bridge
      const A = window[CFG.threadsVar] || {};
      for (const id in A) { if (!threads[id]) threads[id] = { type: A[id].anchor && A[id].anchor.type, anchor: A[id].anchor, label: A[id].label, messages: [] }; threads[id].messages = (A[id].messages || []).slice(); }
      persist();
    } catch (e) {}
  }
  async function askBridge(id) {
    const t = threads[id]; if (!t) return;
    const batch = [{ id, label: t.label, anchor: t.anchor, questions: t.messages.filter(m => m.role === 'user').map(m => m.text) }];
    answering[id] = true; renderRail();
    try {
      const res = await fetch('/__annot/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: baseName(), batch }) });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error) || 'bridge error');
      await refetchThreads(); toast('Answered');
    } catch (e) { toast('Auto-answer failed — use Copy'); }
    answering[id] = false; renderMarks(); renderRail();
    if (openId === id) { const ta = $('#az-list .az-card.az-active textarea'); ta && ta.focus({ preventScroll: true }); }
  }

  /* ===================== boot ===================== */
  function renderAll() { renderMarks(); renderRail(); }
  let raf; window.addEventListener('resize', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderMarks); });
  function boot() {
    renderAll();
    detectBridge().then(() => {
      if (!BRIDGE && location.protocol === 'file:') {
        const f = document.querySelector('.az-rail footer');
        if (f && !f.querySelector('.az-cap')) {
          const n = document.createElement('div');
          n.className = 'az-cap'; n.style.cssText = 'font-size:10.5px;color:#9aa3b2;margin-top:8px;text-align:center;line-height:1.4';
          n.textContent = 'Copy-paste mode. For automatic answers, open this doc via its launcher instead of the file directly.';
          f.appendChild(n);
        }
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
