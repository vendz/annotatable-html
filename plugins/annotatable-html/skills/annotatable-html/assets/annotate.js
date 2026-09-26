/*!
 * annotate.js — drop-in annotation layer for static HTML.
 * Select text, drag a region, or click an element → pin a Q&A thread that
 * lives in the browser. Answers come from "<name>-threads.js" (written by the
 * optional annotate-bridge.js, or by pasting the Copy batch into any chat).
 *
 * USAGE — include AFTER a threads data file that defines window.ANNOTATE_THREADS:
 *   <script src="myfile-threads.js"></script>
 *   <script src="annotate.js"></script>
 * Optional config BEFORE this script:
 *   <script>window.ANNOTATE_CONFIG = { contentSelector:'main', threadsVar:'ANNOTATE_THREADS' }</script>
 *
 * Isolation: every control (sidebar, dock, pins, pill, toast) lives in a shadow root, so host
 * styles can't reach it and its styles can't reach the host. The only things placed into the
 * host page are text <mark class="az-hl"> wraps and an outline class on element anchors, both
 * reset with !important so host rules like `mark{padding}` can't restyle them.
 */
(function () {
  if (window.__azLoaded) return; window.__azLoaded = true;

  const CFG = Object.assign({
    contentSelector: null,   // scope for text-select, region drag, pins (auto if null)
    elementSelector: 'p,h1,h2,h3,h4,h5,li,pre,blockquote,img,figure,table,[data-annot],.node,.card,.step,.box,.prob',
    threadsVar: 'ANNOTATE_THREADS',
  }, window.ANNOTATE_CONFIG || {});

  const content = (CFG.contentSelector && document.querySelector(CFG.contentSelector))
    || document.querySelector('main,article,.wrap') || document.body;
  const HTML = document.documentElement;
  const RAIL_W = 380;

  const KEY = 'annot::' + location.pathname;
  const DELKEY = KEY + '::del', DRAFTKEY = KEY + '::drafts', CHOICEKEY = 'annot::model';
  const ANSWERS = window[CFG.threadsVar] || {};
  const ELIG = CFG.elementSelector;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const uid = () => 't' + Math.random().toString(36).slice(2, 8);
  const readLS = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch (e) { return fb; } };
  const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  let threads = readLS(KEY, {});
  const deletedIds = new Set(readLS(DELKEY, []));
  const drafts = readLS(DRAFTKEY, {});
  function persist() { writeLS(KEY, threads); }
  function persistDeleted() { writeLS(DELKEY, [...deletedIds]); }
  function persistDrafts() { writeLS(DRAFTKEY, drafts); }

  let tool = 'select', locked = false, openId = null, filter = 'all';
  let BRIDGE = false, MODELS = null;
  let choice = readLS(CHOICEKEY, null);          // { backend, model, effort } — shared by all docs
  const answering = {};                           // id -> { text, by } while an answer is in flight

  /* Merge one entry from the threads file into local state. The file is the source of truth for
     answered history, but questions typed here that the file doesn't have yet (still waiting for
     an answer, or asked in copy-paste mode) must survive — a plain overwrite used to drop them
     whenever any other thread's answer triggered a refetch. */
  function mergeThread(id, A) {
    if (!A || deletedIds.has(id)) return;
    const fileMsgs = (A.messages || []).slice();
    const t = threads[id];
    if (!t) { threads[id] = { type: A.anchor && A.anchor.type, anchor: A.anchor, label: A.label, messages: fileMsgs }; return; }
    const local = t.messages || [];
    let lastC = -1; local.forEach((m, i) => { if (m.role === 'claude') lastC = i; });
    const keep = [];
    for (let i = lastC + 1; i < local.length; i++) {
      const m = local[i]; if (m.role !== 'user') continue;
      if (fileMsgs.some((f, j) => j > lastC && f.role === 'user' && f.text === m.text)) continue;
      keep.push(m);
    }
    t.messages = fileMsgs.concat(keep);
  }
  for (const id in ANSWERS) mergeThread(id, ANSWERS[id]);
  persist();

  function stateOf(t) { if (t.messages.some(m => m.role === 'claude')) return 'done'; if (t.messages.some(m => m.role === 'user')) return 'open'; return 'hl'; }
  function pendingQuestions(t) {
    let lastC = -1; t.messages.forEach((m, i) => { if (m.role === 'claude') lastC = i; });
    return t.messages.slice(lastC + 1).filter(m => m.role === 'user').map(m => m.text);
  }

  /* ======================= host-page styles (marks only) ======================= */
  const PAGE_STYLE = `
  mark.az-hl{all:unset;display:inline!important;background:rgba(224,178,58,.22)!important;box-shadow:inset 0 -2px 0 rgba(224,178,58,.75)!important;
    border-radius:2px!important;padding:0!important;margin:0!important;color:inherit!important;font:inherit!important;cursor:pointer}
  mark.az-hl.az-done{background:rgba(62,207,122,.2)!important;box-shadow:inset 0 -2px 0 rgba(62,207,122,.75)!important}
  mark.az-hl.az-focus{background:rgba(124,156,255,.3)!important;box-shadow:inset 0 -2px 0 #7c9cff!important}
  .az-el-mark{outline:2px solid rgba(224,178,58,.75)!important;outline-offset:3px!important}
  .az-el-mark.az-done{outline-color:rgba(62,207,122,.75)!important}
  .az-el-mark.az-focus{outline-color:#7c9cff!important}
  html.az-element-mode .az-el-hover{outline:2px dashed #7c9cff!important;outline-offset:3px!important;cursor:pointer!important}
  html.az-region-mode,html.az-region-mode *{cursor:crosshair!important;user-select:none!important;-webkit-user-select:none!important}
  html.az-railopen{padding-right:${RAIL_W}px!important}
  @media (max-width:760px){html.az-railopen{padding-right:0!important}}
  `;
  const pageStyle = document.createElement('style'); pageStyle.textContent = PAGE_STYLE; document.head.appendChild(pageStyle);

  /* ======================= shadow-root UI ======================= */
  const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
  const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  const UI_STYLE = `
  :host{all:initial}
  .ui,.layer{font-family:${FONT};font-size:13px;line-height:1.45;color:#e7e9ee;-webkit-font-smoothing:antialiased;letter-spacing:normal;text-transform:none}
  *,*::before,*::after{box-sizing:border-box}
  button,textarea{font:inherit;color:inherit;letter-spacing:normal;margin:0}
  button{cursor:pointer}
  .ic{display:inline-block;margin-right:6px}
  .railtab .ic{margin:0 0 6px 0}

  .layer{position:absolute;top:0;left:0;width:0;height:0}
  .region{position:absolute;border:2px solid rgba(224,178,58,.75);background:rgba(224,178,58,.12);border-radius:6px;pointer-events:none}
  .region.done{border-color:rgba(62,207,122,.75);background:rgba(62,207,122,.12)}
  .region.focus{border-color:#7c9cff;background:rgba(124,156,255,.14)}
  .band{position:absolute;border:2px dashed #7c9cff;background:rgba(124,156,255,.12);border-radius:6px;display:none;pointer-events:none}
  .pin{position:absolute;min-width:20px;height:20px;padding:0 5px;border-radius:999px;border:none;background:#e0b23a;color:#241b00;
    font:600 11px/20px ${FONT};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.35);z-index:2}
  .pin.done{background:#3ecf7a;color:#04220f}
  .pin.focus,.pin:hover{outline:2px solid #fff;transform:scale(1.12)}

  .dock{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:4px;
    background:#161a21;border:1px solid #252b36;border-radius:14px;padding:6px;box-shadow:0 10px 34px rgba(0,0,0,.45);transition:left .2s ease}
  .ui.railopen .dock{left:calc((100vw - ${RAIL_W}px) / 2)}
  .master{display:flex;align-items:center;gap:7px;font-weight:600;font-size:13px;background:transparent;border:none;border-radius:9px;padding:7px 11px}
  .master:hover{background:#12161d}
  .led{width:8px;height:8px;border-radius:50%;background:#3a4150}
  .ui.on .led{background:#7c9cff;box-shadow:0 0 8px #7c9cff}
  .tools{display:none;align-items:center;gap:3px;padding-left:4px;margin-left:2px;border-left:1px solid #252b36}
  .ui.on .tools{display:flex}
  .tool{position:relative;width:38px;height:38px;border-radius:9px;border:1px solid transparent;background:transparent;color:#9aa3b2;
    font-size:17px;display:flex;align-items:center;justify-content:center;transition:background .1s,color .1s}
  .tool:hover{background:#12161d;color:#e7e9ee}
  .tool.active{background:#7c9cff;color:#0b1020;border-color:#7c9cff}
  .tool .kbd{position:absolute;bottom:2px;right:3px;font-size:8.5px;opacity:.65}
  .tool.lock.lockon{background:#12161d;color:#7c9cff;border-color:#252b36}
  .div{width:1px;height:24px;background:#252b36;margin:0 3px}
  .txt{font-weight:600;font-size:13px;background:transparent;border:none;border-radius:9px;padding:7px 11px;white-space:nowrap}
  .txt:hover{background:#12161d}
  .txt .n{color:#9aa3b2;font-weight:500;margin-left:4px}
  .modelbtn{display:none}
  .ui.live .modelbtn{display:inline-flex;align-items:center;gap:6px}
  .modelbtn .dot{width:7px;height:7px;border-radius:50%;background:#d97757}
  .modelbtn.codex .dot{background:#10a37f}
  [data-tip]{position:relative}
  [data-tip]:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);white-space:nowrap;
    background:#000;color:#fff;font:500 11px ${FONT};padding:4px 8px;border-radius:6px;pointer-events:none}

  .menu{position:fixed;bottom:76px;left:50%;transform:translateX(-50%);z-index:2147483002;width:300px;max-height:70vh;overflow:auto;display:none;
    background:#161a21;border:1px solid #252b36;border-radius:12px;padding:6px;box-shadow:0 14px 40px rgba(0,0,0,.5)}
  .ui.railopen .menu{left:calc((100vw - ${RAIL_W}px) / 2)}
  .menu.show{display:block}
  .menu h5{margin:8px 8px 4px;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.7px;color:#9aa3b2;display:flex;gap:6px;align-items:center}
  .menu h5 small{font-weight:500;text-transform:none;letter-spacing:0;color:#6d7583}
  .opt{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:none;border-radius:8px;padding:7px 9px;font-size:13px}
  .opt:hover{background:#12161d}
  .opt .ck{width:14px;color:#7c9cff}
  .opt[disabled]{opacity:.4;cursor:default}
  .efforts{display:flex;flex-wrap:wrap;gap:5px;padding:4px 8px 8px}

  .badge{position:fixed;z-index:2147483001;display:none;background:#7c9cff;color:#0b1020;font:600 10.5px ${FONT};padding:2px 7px;border-radius:6px;
    pointer-events:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}

  .adder{position:fixed;z-index:2147483001;display:flex;background:#161a21;border:1px solid #252b36;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45);
    overflow:hidden;opacity:0;transform:translateY(4px) scale(.98);pointer-events:none;transition:opacity .12s,transform .12s}
  .adder.show{opacity:1;transform:none;pointer-events:auto}
  .adder button{border:none;background:transparent;font-weight:600;font-size:12.5px;padding:8px 12px;display:inline-flex;gap:6px;align-items:center}
  .adder button:hover{background:#7c9cff;color:#0b1020}
  .adder button+button{border-left:1px solid #252b36}

  .rail{position:fixed;top:0;right:0;height:100vh;width:${RAIL_W}px;max-width:100vw;background:#161a21;border-left:1px solid #252b36;
    transform:translateX(100%);transition:transform .2s ease;z-index:2147483000;display:flex;flex-direction:column}
  .ui.railopen .rail{transform:none}
  @media (max-width:760px){.rail{width:100vw}}
  .rail header{flex:none;padding:14px 16px;border-bottom:1px solid #252b36;display:flex;align-items:center;gap:8px;background:transparent}
  .rail header b{font-size:14px;font-weight:650}
  .rail header .live{font-size:11.5px;color:#9aa3b2;display:none}
  .ui.live .rail header .live{display:inline}
  .x{background:transparent;border:none;color:#9aa3b2;font-size:16px;margin-left:auto;padding:2px 6px;border-radius:6px}
  .x:hover{color:#e7e9ee;background:#12161d}
  .filters{flex:none;display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid #252b36}
  .chip{font-size:12px;font-weight:500;color:#9aa3b2;background:#12161d;border:1px solid #252b36;border-radius:999px;padding:4px 11px;transition:background .12s,color .12s}
  .chip.on{background:#7c9cff;color:#0b1020;border-color:#7c9cff;font-weight:600}
  .chip .n{margin-left:4px;opacity:.75}
  .list{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px;overscroll-behavior:contain}
  .card{border:1px solid #252b36;border-left:3px solid #e0b23a;border-radius:11px;padding:10px 11px;margin-bottom:9px;cursor:pointer;background:#12161d;
    transition:border-color .12s,background .12s;min-width:0}
  .card.done{border-left-color:#3ecf7a}
  .card.hlonly{border-left-style:dashed}
  .card.focus{border-color:#7c9cff}
  .card.active{cursor:auto;background:#1a1f27;border-color:#7c9cff;padding:12px 13px}
  .top{display:flex;align-items:center;gap:7px;margin-bottom:5px}
  .type{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#9aa3b2}
  .st{margin-left:auto;font-size:10px;font-weight:700;padding:1px 7px;border-radius:999px}
  .st.open{color:#e0b23a;background:rgba(224,178,58,.16)}
  .st.doneb{color:#3ecf7a;background:rgba(62,207,122,.16)}
  .st.busy{color:#7c9cff;background:rgba(124,156,255,.16)}
  .collapse{background:transparent;border:none;color:#9aa3b2;font-size:13px;line-height:1;padding:2px 4px;border-radius:6px}
  .collapse:hover{color:#e7e9ee;background:#12161d}
  .lbl{font-size:13px;color:#d4d8e2;line-height:1.45;font-style:italic;overflow-wrap:anywhere}
  .card.active .lbl{cursor:pointer}
  .card.active .lbl:hover{color:#fff;text-decoration:underline dotted #9aa3b2}
  .q{font-size:12.5px;color:#9aa3b2;margin-top:5px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
  .empty{color:#9aa3b2;font-size:13px;line-height:1.6;padding:22px 18px}
  .empty kbd{background:#12161d;border:1px solid #252b36;border-radius:5px;padding:1px 6px;font:600 11px ${FONT};color:#e7e9ee}
  .rail footer{flex:none;padding:12px;border-top:1px solid #252b36;background:#161a21}
  .rail footer .btn{width:100%;text-align:center;padding:9px}
  .cap{font-size:10.5px;color:#9aa3b2;margin-top:8px;text-align:center;line-height:1.4}

  .msgs{display:flex;flex-direction:column;gap:11px;margin-top:11px}
  .msg{font-size:13.5px;line-height:1.55;min-width:0;user-select:text;-webkit-user-select:text;cursor:text}
  .who{font-size:9.5px;text-transform:uppercase;letter-spacing:.7px;color:#9aa3b2;display:block;margin-bottom:4px;user-select:none;-webkit-user-select:none}
  .msg.user .bubble{color:#fff}
  .msg.claude .bubble{color:#cdd4e6;background:#0f1319;border-radius:10px;padding:9px 11px;border:1px solid #252b36}
  .bubble{min-width:0;overflow-wrap:anywhere;word-break:normal}
  .bubble p{margin:0 0 7px}
  .bubble p:last-child{margin-bottom:0}
  .bubble ul,.bubble ol{margin:5px 0 7px;padding-left:19px}
  .bubble li{margin:3px 0}
  .bubble h4{font-size:13.5px;font-weight:650;color:#fff;margin:8px 0 4px}
  .bubble strong{color:#fff;font-weight:650}
  .bubble em{font-style:italic}
  .bubble code{font-family:${MONO};font-size:12px;background:#0b0e13;border:1px solid #252b36;border-radius:5px;padding:0 4px;
    white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;-webkit-box-decoration-break:clone;box-decoration-break:clone;letter-spacing:0}
  .bubble pre{font-family:${MONO};font-size:12px;background:#0b0e13;border:1px solid #252b36;border-radius:8px;padding:9px 11px;margin:6px 0;
    white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}
  .bubble pre code{background:none;border:none;padding:0}
  .bubble a{color:#7c9cff;overflow-wrap:anywhere}
  .skel{display:flex;flex-direction:column;gap:6px;background:#0f1319;border-radius:10px;padding:9px 11px;border:1px solid #252b36}
  .skline{height:9px;border-radius:5px;width:100%;background:linear-gradient(90deg,#161a21 25%,#1d222b 37%,#161a21 63%);background-size:400% 100%;animation:shimmer 1.4s ease infinite}
  .skline:nth-child(2){width:82%}
  .skline:nth-child(3){width:58%}
  @keyframes shimmer{0%{background-position:100% 0}100%{background-position:0 0}}
  .compose{margin-top:11px;padding-top:11px;border-top:1px solid #252b36}
  .compose textarea{display:block;width:100%;font-size:13.5px;background:#0f1319;border:1px solid #252b36;color:#e7e9ee;border-radius:9px;padding:8px 9px;
    resize:vertical;min-height:44px;max-height:40vh}
  .compose textarea:focus{outline:none;border-color:#7c9cff}
  .row{display:flex;align-items:center;gap:8px;margin-top:8px}
  .hint{font-size:10.5px;color:#9aa3b2;flex:1;min-width:0}
  .btn{font-size:12.5px;border-radius:8px;border:1px solid #252b36;background:#12161d;padding:6px 11px}
  .btn:hover{border-color:#7c9cff;color:#fff}
  .btn.primary{background:#7c9cff;color:#0b1020;border-color:#7c9cff;font-weight:650}
  .btn.danger:hover{border-color:#e5484d;color:#ff6b6f}
  .btn.ghost{background:transparent}

  .railtab{position:fixed;right:0;top:88px;z-index:2147482999;background:#161a21;border:1px solid #252b36;border-right:none;border-radius:10px 0 0 10px;
    font-weight:600;font-size:12px;padding:9px 10px;writing-mode:vertical-rl;display:flex;align-items:center;gap:6px}
  .ui.railopen .railtab{display:none}
  .railtab .n{background:#7c9cff;color:#0b1020;border-radius:999px;padding:1px 6px;font-size:10px;writing-mode:horizontal-tb}

  .toast{position:fixed;top:16px;left:50%;transform:translate(-50%,-6px);background:#e7e9ee;color:#0f1115;font-weight:600;font-size:12.5px;
    padding:9px 15px;border-radius:10px;opacity:0;transition:opacity .18s,transform .18s;pointer-events:none;z-index:2147483003;max-width:80vw}
  .ui.railopen .toast{left:calc((100vw - ${RAIL_W}px) / 2)}
  .toast.show{opacity:1;transform:translate(-50%,0)}
  .pastebox{position:fixed;top:20%;left:10%;width:80%;height:50%;z-index:2147483003;background:#0f1319;color:#e7e9ee;border:1px solid #7c9cff;border-radius:10px;padding:10px;font:12px ${MONO}}
  @media (prefers-reduced-motion:reduce){.rail,.adder,.chip,.card,.toast,.tool,.dock{transition:none}.skline{animation:none}}
  `;

  const host = document.createElement('az-annotate');
  host.setAttribute('style', 'all:initial!important;position:absolute!important;top:0!important;left:0!important;width:0!important;height:0!important;display:block!important;z-index:2147483000!important;pointer-events:auto!important');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${UI_STYLE}</style>
  <div class="layer" id="layer"><div class="band" id="band"></div></div>
  <div class="ui" id="ui">
    <button class="railtab" id="railtab"><span class="ic">💬</span>Threads <span class="n" id="tabn">0</span></button>
    <aside class="rail" id="rail">
      <header><b><span class="ic">💬</span>Threads</b><span class="live">· ⚡ live</span><button class="x" id="closeRail" title="Close">✕</button></header>
      <div class="filters">
        <button class="chip on" data-filter="all">All<span class="n" id="cAll">0</span></button>
        <button class="chip" data-filter="open">Unanswered<span class="n" id="cOpen">0</span></button>
        <button class="chip" data-filter="done">Answered<span class="n" id="cDone">0</span></button>
      </div>
      <div class="list" id="list"><div class="empty" id="empty"></div></div>
      <footer><button class="btn primary" id="copyBtn"><span class="ic">📋</span>Copy questions for Claude</button></footer>
    </aside>
    <div class="dock" id="dock">
      <button class="master" id="master"><span class="led"></span><span class="ic">💬</span>Annotate</button>
      <div class="tools">
        <button class="tool active" data-tool="select" data-tip="Read / select — V">↖<span class="kbd">V</span></button>
        <button class="tool" data-tool="region" data-tip="Region box — R">▭<span class="kbd">R</span></button>
        <button class="tool" data-tool="element" data-tip="Element — E">◎<span class="kbd">E</span></button>
        <button class="tool lock" id="lock" data-tip="Tool lock — place many">🔒</button>
        <span class="div"></span>
        <button class="txt modelbtn" id="modelBtn" data-tip="Who answers"><span class="dot"></span><span id="modelName">Model</span></button>
        <button class="txt" id="dockThreads">Threads<span class="n" id="dockn">0</span></button>
      </div>
    </div>
    <div class="menu" id="menu"></div>
    <div class="badge" id="badge"></div>
    <div class="adder" id="adder"><button id="addComment"><span class="ic">💬</span>Comment</button><button id="addHighlight"><span class="ic">✏️</span>Highlight</button></div>
    <div class="toast" id="toast"></div>
  </div>`;
  document.body.appendChild(host);
  const $ = id => root.getElementById(id);
  const ui = $('ui'), layer = $('layer'), list = $('list');
  const fromUI = e => e.composedPath().includes(host);

  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), Math.min(1500 + t.length * 30, 6000)); }

  /* ===================== markdown (safe: escape then subset) ===================== */
  function inlineMd(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[i] + '</code>');
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

  /* ===================== text anchoring ===================== */
  // Raw text of the content scope, as one string plus a node map. Range.toString() walks the same
  // text nodes, so offsets from it line up with this string.
  function textIndex() {
    const w = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
    let full = '', segs = [], n;
    while ((n = w.nextNode())) { if (!n.nodeValue) continue; segs.push({ node: n, start: full.length, end: full.length + n.nodeValue.length }); full += n.nodeValue; }
    return { full, segs };
  }
  function posToNode(segs, pos) {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (segs[mid].end < pos) lo = mid + 1; else hi = mid; }
    const s = segs[lo]; return { node: s.node, offset: Math.max(0, Math.min(pos - s.start, s.node.nodeValue.length)) };
  }
  const normWS = s => (s || '').replace(/\s+/g, ' ');
  function normIndex(full) {   // whitespace-collapsed copy + map back to raw offsets
    let norm = '', map = [], ws = false;
    for (let i = 0; i < full.length; i++) {
      const c = full.charCodeAt(i), isWS = c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 160;
      if (isWS) { if (!ws) { norm += ' '; map.push(i); } ws = true; } else { norm += full[i]; map.push(i); ws = false; }
    }
    map.push(full.length);
    return { norm, map };
  }
  function tailMatch(a, b) { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; }
  function headMatch(a, b) { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }
  // Finds the occurrence of the anchored phrase whose surrounding text best matches the stored
  // prefix/suffix. Whitespace is collapsed on both sides, so source indentation and the trimmed
  // edges of a selection can't make it fall back to the first occurrence of a repeated phrase.
  function locateText(idx, anchor) {
    const ex = normWS(anchor.exact).trim(); if (!ex) return null;
    const pre = normWS(anchor.prefix).trimEnd(), suf = normWS(anchor.suffix).trimStart();
    const { norm, map } = idx.n || (idx.n = normIndex(idx.full));
    let best = -1, bestScore = -1;
    for (let i = norm.indexOf(ex); i >= 0; i = norm.indexOf(ex, i + 1)) {
      const before = norm.slice(Math.max(0, i - pre.length - 2), i).trimEnd();
      const after = norm.slice(i + ex.length, i + ex.length + suf.length + 2).trimStart();
      const score = tailMatch(before, pre) + headMatch(after, suf);
      if (score > bestScore) { best = i; bestScore = score; }
    }
    if (best < 0) return null;
    const a = posToNode(idx.segs, map[best]), b = posToNode(idx.segs, map[best + ex.length - 1] + 1);
    const r = document.createRange(); r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); return r;
  }
  function offsetOf(node, off) { const r = document.createRange(); r.setStart(content, 0); r.setEnd(node, off); return r.toString().length; }
  function anchorFromRange(range) {
    const { full } = textIndex();
    let s = offsetOf(range.startContainer, range.startOffset), e = offsetOf(range.endContainer, range.endOffset);
    while (s < e && /\s/.test(full[s])) s++;
    while (e > s && /\s/.test(full[e - 1])) e--;
    const exact = normWS(full.slice(s, e));
    return { type: 'text', exact, prefix: normWS(full.slice(Math.max(0, s - 32), s)), suffix: normWS(full.slice(e, e + 32)) };
  }
  function wrapRange(range, id, done) {
    // Wrap each intersecting text node in its own <mark>, never touching element structure.
    const cls = 'az-hl' + (done ? ' az-done' : '');
    try {
      const nodes = [];
      const w = document.createTreeWalker(range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
        acceptNode: n => range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
      });
      let n; while ((n = w.nextNode())) nodes.push(n);
      const sc = range.startContainer, so = range.startOffset, ec = range.endContainer, eo = range.endOffset;
      nodes.forEach(node => {
        const start = node === sc ? so : 0;
        const end = node === ec ? eo : node.nodeValue.length;
        if (start >= end) return;
        const middle = start > 0 ? node.splitText(start) : node;
        if (end - start < middle.nodeValue.length) middle.splitText(end - start);
        if (!middle.nodeValue.trim()) return;
        const p = middle.parentNode;
        // <mark> is HTML — inside SVG it is invalid and the label vanishes; skip non-HTML parents.
        if (!p || p.namespaceURI !== 'http://www.w3.org/1999/xhtml' || /^(script|style|textarea|title)$/i.test(p.nodeName)) return;
        const mark = document.createElement('mark'); mark.className = cls; mark.dataset.tid = id;
        p.insertBefore(mark, middle); mark.appendChild(middle);
      });
    } catch (e) {}
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
    let el = null; try { el = a.sel ? content.querySelector(a.sel) : null; } catch (e) {}
    if (el) return el;
    if (a.tag) { const c = [...content.querySelectorAll(a.tag)]; el = c.find(e => e.textContent.trim().slice(0, 120) === a.text) || c.find(e => a.text && e.textContent.trim().slice(0, 60) === a.text.slice(0, 60)); }
    return el || null;
  }

  /* ===================== marks (host page) + pins/regions (overlay) ===================== */
  // syncMarks() rewrites the host-page marks — only needed when threads are added/removed or change
  // state. layoutPins() only repositions the overlay, so rail toggles, resizes and reflows are cheap
  // and never touch the host DOM (or the reader's current text selection).
  let order = [];
  const pins = {}, regions = {};
  function clearHostMarks() {
    const parents = new Set();
    content.querySelectorAll('mark.az-hl').forEach(m => { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); parents.add(p); });
    parents.forEach(p => p.normalize && p.normalize());
    content.querySelectorAll('.az-el-mark').forEach(e => e.classList.remove('az-el-mark', 'az-done', 'az-focus'));
  }
  function syncMarks() {
    clearHostMarks();
    const idx = textIndex();
    const ranges = [];
    for (const id in threads) {
      const t = threads[id], done = stateOf(t) === 'done';
      if (t.type === 'text' && t.anchor && idx.segs.length) { const r = locateText(idx, t.anchor); if (r) ranges.push([r, id, done]); }
      else if (t.type === 'element') { const e = elFromAnchor(t.anchor || {}); if (e) { e.classList.add('az-el-mark'); if (done) e.classList.add('az-done'); } }
    }
    ranges.forEach(([r, id, done]) => wrapRange(r, id, done));   // live ranges survive earlier splits
    layoutPins();
  }
  function markRect(id) {
    const t = threads[id]; if (!t) return null;
    if (t.type === 'text') { const m = content.querySelector('mark.az-hl[data-tid="' + id + '"]'); return m && m.getClientRects()[0]; }
    if (t.type === 'region') return regionRect(t.anchor);
    if (t.type === 'element') { const e = elFromAnchor(t.anchor || {}); return e && e.getBoundingClientRect(); }
  }
  function regionRect(a) {
    const cr = content.getBoundingClientRect(), bx = cr.left + content.clientLeft, by = cr.top + content.clientTop;
    return { left: bx + a.x * content.offsetWidth, top: by + a.y * content.offsetHeight, width: a.w * content.offsetWidth, height: a.h * content.offsetHeight };
  }
  let layoutRaf = 0;
  function scheduleLayout() { cancelAnimationFrame(layoutRaf); layoutRaf = requestAnimationFrame(layoutPins); }
  function layoutPins() {
    const lr = layer.getBoundingClientRect(), cr = content.getBoundingClientRect();
    const railOpen = ui.classList.contains('railopen');
    const limit = innerWidth - (railOpen && innerWidth > 760 ? RAIL_W : 0);
    const inGutter = cr.right + 34 <= limit;
    const rects = {};
    order = Object.keys(threads).map(id => { const r = markRect(id); rects[id] = r; return { id, y: r ? r.top : 1e9 }; }).sort((a, b) => a.y - b.y).map(o => o.id);
    const live = new Set();
    let prevTop = null, stack = 0;
    order.forEach(id => {
      const t = threads[id], r = rects[id], st = stateOf(t); if (!r) return;
      live.add(id);
      if (t.type === 'region') {
        const b = regions[id] || (regions[id] = layer.appendChild(Object.assign(document.createElement('div'), { className: 'region' })));
        b.classList.toggle('done', st === 'done');
        Object.assign(b.style, { left: (r.left - lr.left) + 'px', top: (r.top - lr.top) + 'px', width: r.width + 'px', height: r.height + 'px' });
      }
      const pin = pins[id] || (pins[id] = makePin(id));
      pin.className = 'pin' + (st === 'done' ? ' done' : '');
      const uc = t.messages.filter(m => m.role === 'user').length;
      pin.textContent = st === 'done' ? '✓' : (uc ? String(uc) : '·');
      const top = r.top - lr.top + (t.type === 'text' ? Math.max(0, (r.height - 20) / 2) : 2);
      stack = (prevTop !== null && Math.abs(top - prevTop) < 22) ? stack + 1 : 0; prevTop = top;
      // Pins sit in the gutter right of the content so they never cover words; when there is no
      // gutter (content touches the viewport/rail) they tuck just inside the right edge.
      let x = inGutter ? cr.right + 8 + stack * 24 : cr.right - 26 - stack * 24;
      if (inGutter && x + 22 > limit) x = cr.right - 26 - (stack - Math.floor((limit - cr.right - 30) / 24)) * 24;   // gutter full → continue inside
      pin.style.left = (x - lr.left) + 'px'; pin.style.top = top + 'px';
    });
    for (const id in pins) if (!live.has(id)) { pins[id].remove(); delete pins[id]; }
    for (const id in regions) if (!live.has(id) || threads[id].type !== 'region') { regions[id].remove(); delete regions[id]; }
  }
  function makePin(id) {
    const pin = document.createElement('button'); pin.dataset.tid = id;
    pin.onclick = e => { e.stopPropagation(); openThread(pin.dataset.tid); };
    pin.onmouseenter = () => focusMark(id, true); pin.onmouseleave = () => focusMark(id, false);
    layer.appendChild(pin); return pin;
  }
  function focusMark(id, on) {
    const t = threads[id]; if (!t) return;
    if (t.type === 'text') content.querySelectorAll('mark.az-hl[data-tid="' + id + '"]').forEach(m => m.classList.toggle('az-focus', on));
    if (t.type === 'region' && regions[id]) regions[id].classList.toggle('focus', on);
    if (t.type === 'element') { const e = elFromAnchor(t.anchor || {}); e && e.classList.toggle('az-focus', on); }
    pins[id] && pins[id].classList.toggle('focus', on);
    const c = cards.get(id); c && c.el.classList.toggle('focus', on);
  }

  /* ===================== rail: keyed cards, persistent composer ===================== */
  // Cards are updated in place and only when their own content changes, so another thread's
  // answer arriving (or a filter click) can't wipe a half-typed follow-up or the reader's
  // selection inside an answer.
  const TYPE = { text: '✎ text', region: '▭ region', element: '◎ element' };
  const cards = new Map();   // id -> { el, sig, composer }
  function whoLabel(m) { return m.role === 'user' ? 'You' : (m.by || 'Claude'); }
  function cardSig(id) {
    const t = threads[id], a = answering[id];
    return [stateOf(t), id === openId, t.label, t.messages.length, t.messages.map(m => (m.text || '').length + (m.by || '')).join(','), a ? 'busy' : ''].join('|');
  }
  function composerFor(id) {
    const wrap = document.createElement('div'); wrap.className = 'compose';
    wrap.innerHTML = '<textarea placeholder="Ask about this…"></textarea><div class="row"><span class="hint">⌘/Ctrl+Enter to send</span>'
      + '<button class="btn ghost danger" data-del>Delete</button><button class="btn primary" data-save>Send</button></div>';
    const ta = wrap.querySelector('textarea');
    ta.value = drafts[id] || '';
    ta.addEventListener('input', () => { if (ta.value) drafts[id] = ta.value; else delete drafts[id]; persistDrafts(); });
    ta.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveMsg(id); } e.stopPropagation(); });
    wrap.querySelector('[data-save]').onclick = e => { e.stopPropagation(); saveMsg(id); };
    wrap.querySelector('[data-del]').onclick = e => { e.stopPropagation(); deleteThread(id); };
    return wrap;
  }
  function uiSelectionText() {
    const s = (root.getSelection && root.getSelection()) || document.getSelection();
    return s && !s.isCollapsed ? s.toString().trim() : '';
  }
  function buildCard(id) {
    const el = document.createElement('div'); el.dataset.tid = id;
    const c = { el, sig: null, composer: null };
    el.addEventListener('mouseenter', () => focusMark(id, true));
    el.addEventListener('mouseleave', () => focusMark(id, false));
    el.addEventListener('mousedown', e => { c.down = [e.clientX, e.clientY]; });
    el.addEventListener('click', e => {
      if (e.target.closest('button,textarea,a,input,select')) return;
      const d = c.down; if (d && Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4) return;   // a drag-select, not a click
      if (e.detail > 1 || uiSelectionText()) return;                                            // double/triple-click selects words
      if (id !== openId) openThread(id, { fromCard: true });
      else if (e.target.closest('.lbl')) scrollToMark(id);
    });
    cards.set(id, c); return c;
  }
  function renderCard(id, c) {
    const t = threads[id], s = stateOf(t), open = id === openId, busy = answering[id];
    c.el.className = 'card ' + (s === 'done' ? 'done ' : s === 'hl' ? 'hlonly ' : '') + (open ? 'active' : '');
    const composer = open ? (c.composer || (c.composer = composerFor(id))) : null;
    const ta = composer && composer.querySelector('textarea');
    const hadFocus = ta && root.activeElement === ta, selA = ta && ta.selectionStart, selB = ta && ta.selectionEnd;
    if (composer && composer.parentNode) composer.remove();
    if (!open) c.composer = null;
    const badge = busy ? '<span class="st busy">Answering…</span>' : s === 'hl' ? '' : '<span class="st ' + (s === 'done' ? 'doneb' : 'open') + '">' + (s === 'done' ? 'Answered' : 'Open') + '</span>';
    let html = '<div class="top"><span class="type">' + (TYPE[t.type] || t.type) + '</span>' + badge
      + (open ? '<button class="collapse" data-collapse title="Collapse">▾</button>' : '') + '</div>'
      + '<div class="lbl" title="' + (open ? 'Show in page' : '') + '">“' + esc(t.label) + '”</div>';
    if (open) {
      html += '<div class="msgs">';
      t.messages.forEach(m => { html += '<div class="msg ' + (m.role === 'user' ? 'user' : 'claude') + '"><span class="who">' + esc(whoLabel(m)) + '</span><div class="bubble">' + md(m.text) + '</div></div>'; });
      if (busy) html += '<div class="msg claude stream"><span class="who">' + esc(busy.by || 'Claude') + '</span>' + (busy.text ? '<div class="bubble">' + md(busy.text) + '</div>' : '<div class="skel"><div class="skline"></div><div class="skline"></div><div class="skline"></div></div>') + '</div>';
      html += '</div>';
    } else {
      const q = (t.messages.find(m => m.role === 'user') || {}).text || '';
      if (q) html += '<div class="q">' + esc(q) + '</div>';
    }
    c.el.innerHTML = html;
    if (open) {
      c.el.appendChild(composer);
      c.el.querySelector('[data-collapse]').onclick = e => { e.stopPropagation(); closeThread(); };
      if (hadFocus) { ta.focus({ preventScroll: true }); try { ta.setSelectionRange(selA, selB); } catch (e) {} }
    }
    c.sig = cardSig(id);
  }
  function updateStream(id) {   // streaming deltas touch only the in-flight bubble
    const c = cards.get(id), a = answering[id]; if (!c || !a || id !== openId) return;
    const s = c.el.querySelector('.msg.stream'); if (!s) return;
    let b = s.querySelector('.bubble');
    if (!b) { const sk = s.querySelector('.skel'); b = document.createElement('div'); b.className = 'bubble'; sk ? sk.replaceWith(b) : s.appendChild(b); }
    b.innerHTML = md(a.text);
  }
  function renderRail() {
    const ids = order.filter(id => threads[id]).concat(Object.keys(threads).filter(id => !order.includes(id)));
    $('tabn').textContent = $('dockn').textContent = ids.length;
    let openCount = 0, doneCount = 0;
    ids.forEach(id => { if (stateOf(threads[id]) === 'done') doneCount++; else openCount++; });
    $('cAll').textContent = ids.length; $('cOpen').textContent = openCount; $('cDone').textContent = doneCount;
    const shown = ids.filter(id => { const s = stateOf(threads[id]); return filter === 'all' || (filter === 'open' ? s !== 'done' : s === 'done'); });
    const empty = $('empty');
    empty.style.display = shown.length ? 'none' : '';
    if (!ids.length) empty.innerHTML = '<b>No annotations yet.</b><br><br>Turn on <b>Annotate</b>, then:<br>• <b>Select text</b> → Comment pill appears<br>• <kbd>R</kbd> → drag a box over anything<br>• <kbd>E</kbd> → click a whole block';
    else if (!shown.length) empty.textContent = 'Nothing in this filter.';
    const want = new Set(shown);
    for (const [id, c] of cards) if (!want.has(id)) { c.el.remove(); cards.delete(id); }
    shown.forEach((id, i) => {
      const c = cards.get(id) || buildCard(id);
      if (c.sig !== cardSig(id)) renderCard(id, c);
      const at = list.children[i + 1];   // +1: the empty-state div stays first
      if (at !== c.el) list.insertBefore(c.el, at || null);
    });
  }
  function scrollToMark(id) { const r = markRect(id); if (!r) return; window.scrollTo({ top: Math.max(0, window.scrollY + r.top - 160), behavior: 'smooth' }); }
  function setRail(open) {
    ui.classList.toggle('railopen', open); HTML.classList.toggle('az-railopen', open);
    scheduleLayout();
  }
  function openThread(id, opts) {
    if (!threads[id]) return;
    openId = id; setRail(true); renderRail();
    if (opts && opts.fromCard) scrollToMark(id);
    const c = cards.get(id);
    if (c) {
      c.el.scrollIntoView({ block: 'nearest' });
      const ta = c.el.querySelector('textarea'); ta && ta.focus({ preventScroll: true });
    }
  }
  function closeThread() { openId = null; renderRail(); }
  function deleteThread(id) {
    delete threads[id]; delete drafts[id]; deletedIds.add(id); persist(); persistDeleted(); persistDrafts();
    if (openId === id) openId = null;
    syncMarks(); renderRail(); toast('Deleted');
    // Also remove it from -threads.js on disk, or another browser / a cleared localStorage would
    // resurrect it from the file. The tombstone above already makes this browser correct.
    if (BRIDGE) fetch('/__annot/delete-thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: baseName(), id }) }).catch(() => {});
  }
  function saveMsg(id) {
    const c = cards.get(id); const ta = c && c.composer && c.composer.querySelector('textarea'); if (!ta) return;
    const v = ta.value.trim(); if (!v) return;
    ta.value = ''; delete drafts[id]; persistDrafts();
    threads[id].messages.push({ role: 'user', text: v }); persist(); layoutPins(); renderRail();
    if (BRIDGE) askBridge(id);
    else toast('Saved — hit Copy for Claude when ready');
  }

  /* ===================== text (always-on adder) ===================== */
  const adder = $('adder'); let pendingRange = null;
  document.addEventListener('mouseup', e => {
    if (!HTML.classList.contains('az-on') || tool !== 'select' || fromUI(e)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { hideAdder(); return; }
      const r = sel.getRangeAt(0);
      if (!content.contains(r.commonAncestorContainer) || host.contains(r.commonAncestorContainer) || sel.toString().trim().length < 2) { hideAdder(); return; }
      pendingRange = r.cloneRange();
      const rect = r.getBoundingClientRect();
      adder.classList.add('show');
      let l = rect.left + rect.width / 2 - adder.offsetWidth / 2; l = Math.max(8, Math.min(l, innerWidth - adder.offsetWidth - 8));
      const above = rect.top - adder.offsetHeight - 8;
      adder.style.left = l + 'px'; adder.style.top = (above < 8 ? rect.bottom + 8 : above) + 'px';
    }, 0);
  });
  document.addEventListener('scroll', () => { if (adder.classList.contains('show')) hideAdder(); }, { passive: true, capture: true });
  function hideAdder() { adder.classList.remove('show'); pendingRange = null; }
  function makeText(withComment) {
    if (!pendingRange) return;
    const anchor = anchorFromRange(pendingRange); if (!anchor.exact) { hideAdder(); return; }
    const id = uid(); threads[id] = { type: 'text', anchor, label: anchor.exact.slice(0, 80), messages: [] };
    persist(); window.getSelection().removeAllRanges(); hideAdder(); syncMarks(); renderRail();
    if (withComment) openThread(id); else toast('Highlighted');
  }
  $('addComment').onmousedown = e => e.preventDefault();   // keep the page selection alive
  $('addHighlight').onmousedown = e => e.preventDefault();
  $('addComment').onclick = () => makeText(true);
  $('addHighlight').onclick = () => makeText(false);

  /* ===================== region (drag a box) ===================== */
  const band = $('band'); let dragging = null;
  function toContent(x, y) { const cr = content.getBoundingClientRect(); return { x: x - cr.left - content.clientLeft, y: y - cr.top - content.clientTop }; }
  document.addEventListener('mousedown', e => {
    if (tool !== 'region' || !HTML.classList.contains('az-on') || e.button !== 0 || fromUI(e)) return;
    const cr = content.getBoundingClientRect();
    if (e.clientX < cr.left || e.clientX > cr.right || e.clientY < cr.top || e.clientY > cr.bottom) return;
    e.preventDefault();
    const p = toContent(e.clientX, e.clientY); dragging = { x0: p.x, y0: p.y, cx0: e.clientX, cy0: e.clientY };
    const lr = layer.getBoundingClientRect();
    Object.assign(band.style, { display: 'block', left: (e.clientX - lr.left) + 'px', top: (e.clientY - lr.top) + 'px', width: '0px', height: '0px' });
  }, true);
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const p = toContent(e.clientX, e.clientY), lr = layer.getBoundingClientRect();
    const l = Math.min(p.x, dragging.x0), t = Math.min(p.y, dragging.y0), w = Math.abs(p.x - dragging.x0), h = Math.abs(p.y - dragging.y0);
    dragging.box = { l, t, w, h };
    Object.assign(band.style, { left: (Math.min(e.clientX, dragging.cx0) - lr.left) + 'px', top: (Math.min(e.clientY, dragging.cy0) - lr.top) + 'px', width: w + 'px', height: h + 'px' });
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return; const box = dragging.box; dragging = null; band.style.display = 'none';
    if (!box || box.w < 12 || box.h < 12) return;
    const id = uid(), W = content.offsetWidth, H = content.offsetHeight;
    threads[id] = { type: 'region', anchor: { type: 'region', x: box.l / W, y: box.t / H, w: box.w / W, h: box.h / H }, label: 'region near ' + nearestHeading(box.t), messages: [] };
    persist(); layoutPins(); renderRail(); openThread(id); if (!locked) setTool('select');
  });
  function nearestHeading(topPx) {
    const cr = content.getBoundingClientRect(); let best = 'the page';
    content.querySelectorAll('h1,h2,h3').forEach(h => { if (h.getBoundingClientRect().top - cr.top <= topPx + 20) best = h.textContent; });
    return best.trim().slice(0, 40);
  }

  /* ===================== element (hover-outline → click) ===================== */
  let hoverEl = null;
  const badgeEl = $('badge');
  function updateBadge() {
    if (!hoverEl) { badgeEl.style.display = 'none'; return; }
    const r = hoverEl.getBoundingClientRect(), txt = hoverEl.textContent.trim().slice(0, 28);
    badgeEl.textContent = hoverEl.tagName.toLowerCase() + (txt ? ' · ' + txt : '');
    badgeEl.style.display = 'block'; badgeEl.style.left = Math.max(4, r.left) + 'px'; badgeEl.style.top = (r.top - 22 < 0 ? r.top + 4 : r.top - 22) + 'px';
  }
  function setHover(el) { if (el === hoverEl) return; hoverEl && hoverEl.classList.remove('az-el-hover'); hoverEl = el; hoverEl && hoverEl.classList.add('az-el-hover'); updateBadge(); }
  content.addEventListener('mousemove', e => {
    if (tool !== 'element' || !HTML.classList.contains('az-on')) return;
    if (fromUI(e)) { setHover(null); return; }
    const el = e.target.closest && e.target.closest(ELIG);
    setHover(el && content.contains(el) ? el : null);
  });
  content.addEventListener('mouseleave', () => { if (tool === 'element') setHover(null); });
  content.addEventListener('click', e => {
    if (tool !== 'element' || !HTML.classList.contains('az-on') || fromUI(e)) return;
    const el = e.target.closest && e.target.closest(ELIG); if (!el || !content.contains(el)) return;
    e.preventDefault(); e.stopPropagation(); setHover(null);
    const id = uid();
    threads[id] = { type: 'element', anchor: { type: 'element', sel: selectorFor(el), tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 120) }, label: (el.textContent || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 80), messages: [] };
    persist(); syncMarks(); renderRail(); openThread(id); if (!locked) setTool('select');
  }, true);

  /* reopen a mark's thread (select mode) — but not when the click ended a text drag */
  content.addEventListener('click', e => {
    if (tool !== 'select' || fromUI(e)) return;
    const s = window.getSelection(); if (s && !s.isCollapsed && s.toString().trim()) return;
    const m = e.target.closest && e.target.closest('mark.az-hl'); if (m) openThread(m.dataset.tid);
  });

  /* ===================== tools + shortcuts ===================== */
  function setTool(t) {
    tool = t; hideAdder();
    root.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    HTML.classList.toggle('az-region-mode', t === 'region');
    HTML.classList.toggle('az-element-mode', t === 'element');
    if (t !== 'element') setHover(null);
  }
  root.querySelectorAll('.tool[data-tool]').forEach(b => b.onclick = () => { setAnnot(true); setTool(b.dataset.tool); });
  $('lock').onclick = () => { locked = !locked; $('lock').classList.toggle('lockon', locked); toast(locked ? 'Tool lock ON — place many' : 'Tool lock off'); };
  function setAnnot(on) { HTML.classList.toggle('az-on', on); ui.classList.toggle('on', on); if (on) prime(); if (!on) { setTool('select'); hideAdder(); closeThread(); hideMenu(); } }
  $('master').onclick = () => { const on = !HTML.classList.contains('az-on'); setAnnot(on); if (on) { setRail(true); renderRail(); toast('Select text · R region · E element'); } };
  document.addEventListener('keydown', e => {
    const t = e.composedPath()[0];
    if (t && (/^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;   // leave ⌘E, ⌘R, ⌘V etc. to the browser
    if (e.key === 'Escape') { if (menuOpen()) hideMenu(); else if (openId) closeThread(); else if (tool !== 'select') setTool('select'); hideAdder(); return; }
    if (!HTML.classList.contains('az-on')) return;
    const k = e.key.toLowerCase();
    if (k === 'v') setTool('select');
    else if (k === 'r') setTool('region');
    else if (k === 'e') setTool('element');
  });

  /* rail open/close + filters + copy */
  $('railtab').onclick = () => { setRail(true); renderRail(); };
  $('dockThreads').onclick = () => { setRail(!ui.classList.contains('railopen')); renderRail(); };
  $('closeRail').onclick = () => setRail(false);
  root.querySelectorAll('.chip').forEach(c => c.onclick = () => { filter = c.dataset.filter; root.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c)); renderRail(); });
  $('copyBtn').onclick = () => {
    const batch = Object.entries(threads).filter(([id, t]) => t.messages.some(m => m.role === 'user'))
      .map(([id, t]) => ({ id, label: t.label, anchor: t.anchor, questions: t.messages.filter(m => m.role === 'user').map(m => m.text) }));
    if (!batch.length) { toast('No questions yet'); return; }
    const threadsFile = threadsFileName();
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
  • Write answers in plain English: short, direct, no jargon. Lead with the answer in one or two
    sentences. Only name files, functions or code when the question asks for them. Markdown is OK.
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
        const ta = document.createElement('textarea'); ta.className = 'pastebox'; ta.value = text; ui.appendChild(ta); ta.select();
        ta.addEventListener('blur', () => ta.remove()); toast('Select-all + copy, then click away');
      });
  };

  /* ===================== model picker ===================== */
  const menu = $('menu');
  const menuOpen = () => menu.classList.contains('show');
  function hideMenu() { menu.classList.remove('show'); }
  function validChoice(c) {
    if (!MODELS || !c) return false;
    const b = MODELS[c.backend]; if (!b || !b.available) return false;
    return b.models.some(m => m.id === c.model);
  }
  function defaultChoice() {
    if (!MODELS) return null;
    if (MODELS.claude && MODELS.claude.available) return { backend: 'claude', model: MODELS.claude.default };
    if (MODELS.codex && MODELS.codex.available) return { backend: 'codex', model: MODELS.codex.default, effort: MODELS.codex.defaultEffort };
    return null;
  }
  function modelInfo(c) { const b = MODELS && c && MODELS[c.backend]; return b && b.models.find(m => m.id === c.model); }
  function choiceLabel(c) {
    c = c || choice; const m = modelInfo(c); if (!m) return 'Claude';
    return (c.backend === 'codex' ? 'Codex · ' : 'Claude · ') + m.label + (c.backend === 'codex' && c.effort ? ' (' + c.effort + ')' : '');
  }
  function paintModelBtn() {
    const m = modelInfo(choice);
    $('modelName').textContent = m ? m.label + (choice.backend === 'codex' && choice.effort ? ' · ' + choice.effort : '') : 'Model';
    $('modelBtn').classList.toggle('codex', !!choice && choice.backend === 'codex');
  }
  function renderMenu() {
    let h = '';
    for (const be of ['claude', 'codex']) {
      const b = MODELS[be]; if (!b) continue;
      h += '<h5>' + (be === 'claude' ? 'Claude' : 'Codex') + (b.available ? '' : ' <small>' + esc(b.reason || 'unavailable') + '</small>') + '</h5>';
      b.models.forEach(m => {
        const on = choice && choice.backend === be && choice.model === m.id;
        h += '<button class="opt" data-be="' + be + '" data-m="' + esc(m.id) + '"' + (b.available ? '' : ' disabled') + '><span class="ck">' + (on ? '✓' : '') + '</span>' + esc(m.label) + '</button>';
      });
      if (be === 'codex' && choice && choice.backend === 'codex') {
        const m = modelInfo(choice);
        if (m && m.efforts && m.efforts.length) {
          h += '<h5>Effort</h5><div class="efforts">' + m.efforts.map(e => '<button class="chip' + (choice.effort === e ? ' on' : '') + '" data-effort="' + esc(e) + '">' + esc(e) + '</button>').join('') + '</div>';
        }
      }
    }
    menu.innerHTML = h;
    menu.querySelectorAll('.opt').forEach(o => o.onclick = () => {
      const be = o.dataset.be, id = o.dataset.m;
      const m = MODELS[be].models.find(x => x.id === id);
      choice = { backend: be, model: id };
      if (be === 'codex') choice.effort = (m.efforts || []).includes(MODELS.codex.defaultEffort) ? MODELS.codex.defaultEffort : (m.efforts || [])[0];
      writeLS(CHOICEKEY, choice); paintModelBtn(); renderMenu(); prime();
      toast('Answers now from ' + choiceLabel());
    });
    menu.querySelectorAll('[data-effort]').forEach(o => o.onclick = () => { choice.effort = o.dataset.effort; writeLS(CHOICEKEY, choice); paintModelBtn(); renderMenu(); });
  }
  $('modelBtn').onclick = e => { e.stopPropagation(); if (menuOpen()) hideMenu(); else { renderMenu(); menu.classList.add('show'); } };
  document.addEventListener('mousedown', e => { if (menuOpen() && !e.composedPath().includes(menu) && !e.composedPath().includes($('modelBtn'))) hideMenu(); }, true);

  /* ===================== auto-answer bridge (optional) ===================== */
  function baseName() { return decodeURIComponent(location.pathname.split('/').pop() || '').replace(/\.html?$/i, '') || 'page'; }
  function threadsFileName() { return baseName() + '-threads.js'; }
  async function detectBridge() {
    if (location.protocol === 'file:') return;
    try {
      const r = await fetch('/__annot/ping', { cache: 'no-store' });
      if (r.ok && (await r.json()).ok) BRIDGE = true;
    } catch (e) { return; }
    if (!BRIDGE) return;
    ui.classList.add('live');
    try { const r = await fetch('/__annot/models', { cache: 'no-store' }); if (r.ok) MODELS = await r.json(); } catch (e) {}
    if (MODELS && !validChoice(choice)) { choice = defaultChoice(); if (choice) writeLS(CHOICEKEY, choice); }
    paintModelBtn();
    if (HTML.classList.contains('az-on')) prime();
  }
  // Warm the doc's base session in the background when Annotate is turned on (not on every page
  // view — reading a doc shouldn't spend a model call), so the first question doesn't wait for it.
  let primedFor = null;
  function prime() {
    if (!BRIDGE || !choice) return;
    const key = choice.backend + '|' + choice.model; if (primedFor === key) return; primedFor = key;
    fetch('/__annot/prime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: baseName(), backend: choice.backend, model: choice.model, effort: choice.effort }) }).catch(() => {});
  }
  async function askBridge(id) {
    const t = threads[id]; if (!t || answering[id]) return;
    const questions = pendingQuestions(t); if (!questions.length) return;
    const by = choiceLabel();
    answering[id] = { text: '', by }; renderRail();
    let final = null;
    try {
      const res = await fetch('/__annot/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: baseName(), id, label: t.label, anchor: t.anchor, questions, backend: choice && choice.backend, model: choice && choice.model, effort: choice && choice.effort, by, stream: true }) });
      if (!res.ok || !res.body) throw new Error('bridge returned ' + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '', raf = 0;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
          if (ev.t === 'delta' && answering[id]) { answering[id].text += ev.text; if (!raf) raf = requestAnimationFrame(() => { raf = 0; updateStream(id); }); }
          else if (ev.t === 'reset' && answering[id]) { answering[id].text = ''; }
          else if (ev.t === 'done') final = ev;
        }
      }
      if (!final || !final.ok) throw new Error((final && final.error) || 'no answer');
      if (threads[id] && final.entry) { mergeThread(id, final.entry); persist(); }
      toast(final.warning ? '⚠ ' + final.warning : 'Answered');
    } catch (e) { toast('Answer failed: ' + String(e.message || e).slice(0, 140)); }
    delete answering[id];
    if (!threads[id]) { renderRail(); return; }
    syncMarks(); renderRail();
    if (final && final.ok && pendingQuestions(threads[id]).length) askBridge(id);   // follow-up typed while this one was answering
  }

  /* ===================== boot ===================== */
  window.addEventListener('resize', scheduleLayout);
  if (window.ResizeObserver) new ResizeObserver(scheduleLayout).observe(content);
  window.addEventListener('load', scheduleLayout);
  document.fonts && document.fonts.ready && document.fonts.ready.then(scheduleLayout);
  function boot() {
    syncMarks(); renderRail();
    detectBridge().then(() => {
      if (!BRIDGE && location.protocol === 'file:') {
        const f = root.querySelector('.rail footer');
        if (f && !f.querySelector('.cap')) { const n = document.createElement('div'); n.className = 'cap'; n.textContent = 'Copy-paste mode. For automatic answers, open this doc via its launcher instead of the file directly.'; f.appendChild(n); }
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
