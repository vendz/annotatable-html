/*!
 * annotate.js 2.0 — drop-in comment layer for static HTML.
 * Select text, draw a box, or pick a block (a paragraph, a table, a node inside a diagram) → ask
 * Claude. Threads sit in margin cards beside what they point at, and in a Comments panel.
 * Answers come from "<name>-threads.js" (written by the optional annotate-bridge.js, or by pasting
 * the copied questions into any chat).
 *
 * USAGE — include AFTER a threads data file that defines window.ANNOTATE_THREADS:
 *   <script src="myfile-threads.js"></script>
 *   <script src="annotate.js"></script>
 * Optional config BEFORE this script:
 *   <script>window.ANNOTATE_CONFIG = { contentSelector:'main', threadsVar:'ANNOTATE_THREADS', theme:'auto' }</script>
 *
 * Isolation: every control lives in a shadow root (<az-annotate>), so host styles can't reach it
 * and its styles can't reach the host. Put into the host page: text <mark class="az-hl"> wraps,
 * <az-box> outlines for boxes and picked blocks, and a padding-right on <html> that makes room for
 * the margin cards — all reset with !important.
 */
(function () {
  'use strict';
  if (window.__azLoaded) return; window.__azLoaded = true;

  const CFG = Object.assign({ contentSelector: null, threadsVar: 'ANNOTATE_THREADS', theme: 'auto' }, window.ANNOTATE_CONFIG || {});
  const HTML = document.documentElement;
  const findContent = () => (CFG.contentSelector && document.querySelector(CFG.contentSelector)) || document.querySelector('main,article,.wrap') || document.body;
  let content = findContent();

  /* Sideways-scrolling blocks inside the content (wide tables, figures). Listed in document order,
     so the reader's page and the bridge's hidden browser agree on "scroller #i". */
  const scrollsX = e => { const o = getComputedStyle(e).overflowX; return (o === 'auto' || o === 'scroll') && e.scrollWidth > e.clientWidth + 1; };
  let scCache = null, scAt = 0;
  function scrollers(fresh) {
    if (!fresh && scCache && performance.now() - scAt < 400) return scCache;
    const out = []; content.querySelectorAll('*').forEach(e => { if (!/^(az-annotate|az-box|svg|script|style)$/i.test(e.tagName) && !(e instanceof SVGElement) && scrollsX(e)) out.push(e); });
    scCache = out; scAt = performance.now(); return out;
  }
  function scrollerOf(el) { for (let e = el && el.parentElement; e && e !== content.parentElement; e = e.parentElement) if (e.nodeType === 1 && !(e instanceof SVGElement) && scrollsX(e)) return e; return null; }

  // ?az-snap: the bridge's hidden browser is taking a region picture — show the bare doc, scrolled
  // the way the reader had it when the box was drawn (&scroll=i:left).
  if (/[?&]az-snap\b/.test(location.search)) {
    const sc = new URLSearchParams(location.search).get('scroll');
    if (sc) {
      const apply = () => { content = findContent(); const hs = scrollers(true); sc.split(',').forEach(p => { const [i, l] = p.split(':').map(Number); if (hs[i] && Number.isFinite(l)) hs[i].scrollLeft = l; }); };
      const run = () => { apply(); [300, 900, 1800, 2700].forEach(t => setTimeout(apply, t)); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
    }
    return;
  }

  const KEY = 'annot::' + location.pathname;
  const DELKEY = KEY + '::del', DRAFTKEY = KEY + '::drafts', CHOICEKEY = 'annot::model';
  const ANSWERS = window[CFG.threadsVar] || {};
  const DRAFT = '__draft';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const uid = () => 't' + Math.random().toString(36).slice(2, 8);
  const readLS = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch (e) { return fb; } };
  const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const normWS = s => (s || '').replace(/\s+/g, ' ');

  let threads = readLS(KEY, {});
  const deletedIds = new Set(readLS(DELKEY, []));
  const drafts = readLS(DRAFTKEY, {});
  const persist = () => writeLS(KEY, threads);
  const persistDeleted = () => writeLS(DELKEY, [...deletedIds]);
  const persistDrafts = () => writeLS(DRAFTKEY, drafts);

  /* Merge one entry from the threads file into local state. The file is the source of truth for
     answered history; questions typed here that the file doesn't have yet survive, and local
     details (times, resolved) are kept. */
  function mergeThread(id, A) {
    if (!A || deletedIds.has(id)) return;
    const local = (threads[id] && threads[id].messages) || [];
    const fileMsgs = (A.messages || []).map((m, i) => (local[i] && local[i].role === m.role && local[i].text === m.text && local[i].at) ? Object.assign({}, m, { at: local[i].at }) : Object.assign({}, m));
    const t = threads[id];
    if (!t) { threads[id] = { type: A.anchor && A.anchor.type, anchor: A.anchor, label: A.label, messages: fileMsgs }; return; }
    let lastC = -1; local.forEach((m, i) => { if (m.role === 'claude') lastC = i; });
    const keep = [];
    for (let i = lastC + 1; i < local.length; i++) {
      const m = local[i]; if (m.role !== 'user') continue;
      if (fileMsgs.some((f, j) => j > lastC && f.role === 'user' && f.text === m.text)) continue;
      keep.push(m);
    }
    t.messages = fileMsgs.concat(keep);
    if (!t.type && A.anchor) t.type = A.anchor.type;
  }
  for (const id in ANSWERS) mergeThread(id, ANSWERS[id]);
  for (const id in threads) if (!threads[id].type) threads[id].type = (threads[id].anchor && threads[id].anchor.type) || 'text';
  persist();
  function pendingQuestions(t) {
    let lastC = -1; t.messages.forEach((m, i) => { if (m.role === 'claude') lastC = i; });
    return t.messages.slice(lastC + 1).filter(m => m.role === 'user').map(m => m.text);
  }

  /* ======================= host-page styles ======================= */
  const EASE = 'cubic-bezier(.165,.84,.44,1)';
  const pageStyle = document.createElement('style');
  pageStyle.textContent = `
  mark.az-hl{all:unset;display:inline!important;background:rgba(251,179,21,.22)!important;color:inherit!important;font:inherit!important;padding:0!important;margin:0!important;
    border-radius:0!important;box-shadow:none!important;cursor:pointer;transition:background-color .2s ${EASE},box-shadow .2s ${EASE}!important}
  mark.az-hl.az-on{background:rgba(251,179,21,.45)!important;box-shadow:inset 0 -2px 0 var(--az-edge,#e49c06)!important}
  mark.az-hl.az-gone{background:transparent!important;box-shadow:none!important;cursor:text}
  az-box{all:unset;position:absolute!important;display:block!important;box-sizing:border-box!important;pointer-events:none!important;border-radius:5px!important;
    background:rgba(251,179,21,.18)!important;box-shadow:inset 0 0 0 1px var(--az-edge,#e49c06)!important;z-index:5!important;transition:opacity .2s,background-color .2s ${EASE}!important}
  az-box.az-on{background:rgba(251,179,21,.26)!important;box-shadow:inset 0 0 0 2px var(--az-edge,#e49c06)!important}
  az-box.az-gone{opacity:0!important}
  html.az-mode-region,html.az-mode-region *{cursor:crosshair!important;user-select:none!important;-webkit-user-select:none!important}
  html.az-pad{padding-right:var(--az-pad,0px)!important}
  html.az-panel{padding-right:320px!important}
  @media (max-width:700px){html.az-panel{padding-right:0!important}}`;
  document.head.appendChild(pageStyle);

  /* ======================= shadow-root UI ======================= */
  const SANS = 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
  const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  const UI_STYLE = `
  .ui{--page:#fff;--surface:#fff;--popover:#fff;--t1:rgba(0,0,0,.9);--t2:rgba(0,0,0,.6);--t3:rgba(0,0,0,.47);
    --ring:rgba(0,0,0,.08);--line:rgba(0,0,0,.08);--ghost:rgba(0,0,0,.05);--ghost-2:rgba(0,0,0,.1);--tint:rgba(0,0,0,.03);--field:rgba(0,0,0,.04);
    --sh-sm:0 1px 2px rgba(11,11,11,.06),0 2px 8px rgba(0,0,0,.08);--sh-md:0 2px 4px rgba(11,11,11,.07),0 6px 16px rgba(0,0,0,.1);--sh-pop:0 8px 24px rgba(0,0,0,.12),0 2px 6px rgba(0,0,0,.08);
    --accent:#257de0;--accent-text:#1757ac;--danger:#dc3c3d;--claude:#d97757;--you:#257de0;--code:rgba(0,0,0,.05);
    --ease:${EASE};--snap:cubic-bezier(.32,.72,0,1);--spring:linear(0,.2459,.6526,.9468,1.0764,1.0915,1.0585,1.0219,.9993,.9914,.9921,.9957,.9988,1.0004,1);
    font:14px/20px ${SANS};color:var(--t1);-webkit-font-smoothing:antialiased}
  .ui[data-theme=dark]{--page:#0b0b0b;--surface:#1f1f1f;--popover:#303030;--t1:rgba(255,255,255,.93);--t2:rgba(255,255,255,.57);--t3:rgba(255,255,255,.4);
    --ring:rgba(255,255,255,.04);--line:rgba(255,255,255,.07);--ghost:rgba(255,255,255,.075);--ghost-2:rgba(255,255,255,.15);--tint:rgba(255,255,255,.03);--field:rgba(255,255,255,.05);
    --sh-sm:0 1px 2px rgba(11,11,11,.06),0 2px 8px rgba(0,0,0,.24);--sh-md:0 2px 4px rgba(11,11,11,.07),0 6px 16px rgba(0,0,0,.24);--sh-pop:0 8px 24px rgba(0,0,0,.32),0 2px 6px rgba(0,0,0,.2);
    --accent-text:#6aabf1;--code:rgba(255,255,255,.07)}
  *{box-sizing:border-box}
  button{font:inherit;color:inherit}
  svg{display:block}
  .ib{all:unset;box-sizing:border-box;width:28px;height:28px;display:grid;place-items:center;border-radius:8px;color:var(--t2);cursor:pointer;
    transition:background-color 60ms var(--ease),color 60ms,transform .45s var(--spring)}
  .ib:hover{background:var(--ghost);color:var(--t1)}
  .ib:active{transform:scale(.94);transition:transform 60ms ease-out}
  .ib svg{width:16px;height:16px}
  .ib:focus-visible,.send:focus-visible,.tool:focus-visible,.menu button:focus-visible{box-shadow:0 0 0 1px var(--accent),0 0 6px 1px rgba(37,125,224,.6)}
  .av{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font:500 9px/1 ${SANS};color:#fff;flex:none}
  .av.you{background:var(--you)} .av.claude{background:var(--claude)} .av svg{width:12px;height:12px}
  .av.codex{background:var(--t1);color:var(--surface)}

  .top{position:fixed;top:16px;right:16px;display:flex;align-items:center;gap:2px;height:36px;padding:4px;border-radius:12px;
    background:var(--surface);box-shadow:inset 0 0 0 1px var(--ring),var(--sh-sm);z-index:40;transition:right .3s var(--ease)}
  .ui.panel-open .top{right:336px}
  .tool{all:unset;box-sizing:border-box;height:28px;min-width:28px;padding:0 6px;display:flex;align-items:center;justify-content:center;gap:4px;border-radius:8px;
    color:var(--t2);cursor:pointer;font:500 13px/1 ${SANS};transition:background-color 60ms,color 60ms,transform .45s var(--spring)}
  .tool:hover,.tool[aria-expanded="true"],.tool.sel{background:var(--ghost);color:var(--t1)}
  .tool:active{transform:scale(.96);transition:transform 60ms ease-out}
  .tool svg{width:16px;height:16px} .tool .caret{width:10px;height:10px;opacity:.6}
  .tool .n{color:var(--t2);font-variant-numeric:tabular-nums}
  .sep{width:1px;height:16px;background:var(--line);margin:0 3px}

  .menu{position:fixed;min-width:180px;background:var(--popover);border-radius:14px;padding:4px;z-index:60;box-shadow:inset 0 0 0 1px var(--ring),var(--sh-pop);
    transform-origin:top right;animation:pop .14s var(--ease);--cols:16px minmax(0,1fr) auto 16px}
  .menu.noicons{--cols:minmax(0,1fr) auto 16px} .menu.noicons .ic{display:none}
  @keyframes pop{from{opacity:0;transform:scale(.97) translateY(-2px)}}
  .menu button{all:unset;box-sizing:border-box;display:grid;grid-template-columns:var(--cols);column-gap:10px;align-items:start;width:100%;min-height:30px;padding:5px 10px;
    border-radius:8px;cursor:pointer;font:14px/20px ${SANS};color:var(--t1)}
  .menu button:hover{background:var(--ghost)} .menu button.danger{color:var(--danger)} .menu button[disabled]{opacity:.45;cursor:default}
  .menu small{display:block;color:var(--t2);font-size:12px;line-height:16px}
  .menu .ic{display:grid;place-items:center;height:20px} .menu .ic svg{width:16px;height:16px;color:var(--t2)}
  .menu .chk{display:grid;place-items:center;height:20px;visibility:hidden} .menu .chk svg{width:14px;height:14px}
  .menu button.sel .chk{visibility:visible}
  .menu kbd{min-width:12px;text-align:right;color:var(--t3);font:12px/20px ${SANS}}
  .menu hr{border:0;height:1px;background:var(--line);margin:4px 8px}
  .menu h5{margin:6px 10px 2px;font:500 11px/16px ${SANS};color:var(--t3);text-transform:uppercase;letter-spacing:.04em}

  .selbar{position:fixed;display:none;height:36px;padding:4px;border-radius:12px;background:var(--popover);z-index:45;box-shadow:inset 0 0 0 1px var(--ring),var(--sh-pop)}
  .selbar.show{display:flex;animation:rise .14s var(--ease)}
  @keyframes rise{from{opacity:0;transform:translateY(4px)}}
  .selbar .tool{color:var(--t1);padding:0 10px 0 8px;gap:6px;font-size:14px;font-weight:450}

  .rail{position:absolute;top:0;left:0;width:284px;z-index:20}
  .card{position:absolute;left:0;width:284px;background:var(--surface);border-radius:16px;box-shadow:inset 0 0 0 1px var(--ring),var(--sh-sm);
    transition:top .26s var(--ease),translate .2s var(--ease),opacity .2s var(--ease),box-shadow .2s var(--ease)}
  .card.on{translate:-8px 0;box-shadow:inset 0 0 0 1px var(--ring),var(--sh-md);z-index:3}
  .card.lifted{box-shadow:inset 0 0 0 1px var(--ring),var(--sh-pop);z-index:4}
  .card.enter{opacity:0;translate:0 4px} .card.leave{opacity:0;translate:12px 0;pointer-events:none}
  .card.pinned{transition:translate .2s var(--ease),opacity .2s,box-shadow .2s}
  .card .inner{padding:16px} .card .msgwrap{position:relative}
  .scroll{max-height:min(456px,calc(55vh + 16px));overflow-y:auto;margin:-6px -8px -8px;padding:6px 8px 8px;scrollbar-width:thin;scrollbar-color:var(--ghost-2) transparent}
  .card:not(.on):not(.lifted) .scroll{max-height:140px;overflow:hidden}
  .card.clipped:not(.on):not(.lifted) .scroll{-webkit-mask-image:linear-gradient(#000 55%,transparent);mask-image:linear-gradient(#000 55%,transparent)}
  .tcard .scroll{max-height:none;overflow:visible;margin:0;padding:0}
  .seemore{all:unset;position:absolute;left:50%;transform:translateX(-50%);bottom:12px;display:none;align-items:center;gap:4px;height:24px;padding:0 10px;border-radius:12px;
    background:var(--popover);box-shadow:inset 0 0 0 1px var(--ring),var(--sh-pop);font:500 12px/1 ${SANS};color:var(--t1);cursor:pointer}
  .seemore svg{width:12px;height:12px} .card.overflowing .seemore{display:flex}

  .msg{position:relative} .msg+.msg{margin-top:12px}
  .who{position:relative;display:flex;align-items:center;gap:8px;height:28px;margin:-4px 0 2px}
  .who>*{white-space:nowrap}
  .name{font-size:13px;font-weight:520;flex:none} .time{font-size:12px;color:var(--t3);flex:none}
  .by{font-size:12px;color:var(--t3);min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}
  .by::before{content:"·";margin-right:6px}
  .acts{position:absolute;right:-4px;top:0;bottom:0;display:flex;align-items:center;padding-left:32px;opacity:0;pointer-events:none;
    background:linear-gradient(to right,transparent,var(--rowbg,var(--surface)) 30%);transition:opacity 60ms var(--snap)}
  .msg:hover .acts,.acts:focus-within{opacity:1;pointer-events:auto;transition:opacity .12s var(--snap)}
  .body{min-width:0;overflow-wrap:anywhere}
  .body p{margin:0 0 8px} .body p:last-child{margin-bottom:0}
  .body ul,.body ol{margin:4px 0 8px;padding-left:18px} .body li{margin:2px 0}
  .body h4{font-size:14px;font-weight:600;margin:10px 0 4px} .body strong{font-weight:600}
  .body a{color:var(--accent-text);text-underline-offset:2px}
  .body code{font:12.5px ${MONO};background:var(--code);border-radius:4px;padding:1px 4px}
  .body pre{font:12px/1.5 ${MONO};background:var(--code);border-radius:8px;padding:9px 11px;margin:6px 0;white-space:pre;overflow-x:auto}
  .body pre code{background:none;padding:0} .body pre code.hljs{background:none;padding:0}
  .body .katex-display{margin:6px 0;overflow-x:auto;overflow-y:hidden}
  .body .tex{font:12px ${MONO};color:var(--t2)} .body .tex.disp{display:block;margin:6px 0;white-space:pre-wrap}
  .body .tbl{overflow-x:auto;margin:6px 0}
  .body table{border-collapse:collapse;font-size:12.5px;width:100%}
  .body th,.body td{border-bottom:1px solid var(--line);padding:4px 7px;text-align:left;vertical-align:top} .body th{color:var(--t2);font-weight:520}
  .note{font-size:12.5px;color:var(--t3)}
  .thinking{font-size:14px;font-weight:450;background:linear-gradient(90deg,var(--t3) 0%,var(--t3) 35%,var(--t1) 50%,var(--t3) 65%,var(--t3) 100%);background-size:300% 100%;
    -webkit-background-clip:text;background-clip:text;color:transparent;animation:shine 1.6s cubic-bezier(.45,0,.55,1) infinite}
  @keyframes shine{from{background-position:100% 0}to{background-position:0 0}}
  .rs .sq{fill:var(--accent);fill-opacity:0;stroke:currentColor;stroke-width:1.6;stroke-dasharray:52;stroke-dashoffset:52;opacity:0}
  .rs .ck{fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  .resolving .rs .sq{opacity:1;stroke:var(--accent);animation:sq .34s var(--ease) forwards} .resolving .rs .ck{animation:ck .34s forwards}
  @keyframes sq{0%{stroke-dashoffset:52;fill-opacity:0}55%{stroke-dashoffset:0;fill-opacity:0}100%{stroke-dashoffset:0;fill-opacity:1}}
  @keyframes ck{0%,74.9%{stroke:currentColor}75%,100%{stroke:#fff}}

  .field{border-radius:14px;background:var(--field);padding:7px 12px;font:13px/20px ${SANS};cursor:text;transition:background-color .15s var(--ease),box-shadow .15s var(--ease)}
  .card .field,.tcard .field{margin-top:12px}
  .field.focus{background:transparent;box-shadow:0 0 0 1px var(--accent),0 0 6px 1px rgba(37,125,224,.45)}
  .field.bare{background:transparent;padding:0;margin:0;box-shadow:none}
  .ed{outline:none;min-height:20px;max-height:272px;overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap;color:var(--t1)}
  .ed:empty::before{content:attr(data-ph);color:var(--t3);pointer-events:none}
  .frow{display:grid;grid-template-rows:0fr;transition:grid-template-rows .18s var(--ease)}
  .frow>div{overflow:hidden;display:flex;align-items:center;gap:6px;min-height:0}
  .field.focus .frow,.field.bare .frow{grid-template-rows:1fr}
  .frow>div>*{margin-top:8px}
  .model{all:unset;display:flex;align-items:center;gap:3px;height:24px;padding:0 6px;margin-left:-6px;border-radius:6px;font:12px/1 ${SANS};color:var(--t2);cursor:pointer}
  .model:hover{background:var(--ghost);color:var(--t1)} .model svg{width:10px;height:10px;opacity:.7}
  .send{all:unset;box-sizing:border-box;margin-left:auto;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;cursor:default;color:var(--t3);
    background:var(--ghost);transition:background-color .12s var(--ease),color .12s,transform .45s var(--spring)}
  .send.ready{background:var(--accent);color:#fff;cursor:pointer} .send.ready:active{transform:scale(.92);transition:transform 60ms ease-out}
  .send svg{width:14px;height:14px}

  .panel{position:fixed;top:0;right:0;bottom:0;width:320px;background:var(--surface);box-shadow:inset 1px 0 0 var(--line);display:flex;flex-direction:column;z-index:30;
    translate:100% 0;visibility:hidden;transition:translate .3s var(--ease),visibility 0s .3s}
  .ui.panel-open .panel{translate:0 0;visibility:visible;transition:translate .3s var(--ease)}
  .ph{display:flex;align-items:center;gap:2px;height:56px;padding:0 10px 0 18px;flex:none}
  .ph h3{margin:0;font:520 14px/20px ${SANS}} .ph .n{color:var(--t3);font-size:13px;margin:0 auto 0 8px;font-variant-numeric:tabular-nums}
  .plist{overflow:auto;flex:1;padding:4px 0 40px;scrollbar-width:thin}
  .pnew{padding:12px 18px 16px;box-shadow:inset 0 -1px 0 var(--line)}
  .tcard{--rowbg:var(--surface);position:relative;padding:14px 18px;cursor:pointer;overflow:hidden;transition:background-color .12s,opacity .2s var(--ease),max-height .26s var(--ease),padding .26s var(--ease)}
  .tcard:hover,.tcard.on{background:var(--tint);--rowbg:color-mix(in srgb,var(--surface),var(--t1) 3%)}
  .tcard.enter{opacity:0} .tcard.leave{opacity:0;max-height:0!important;padding-top:0;padding-bottom:0;pointer-events:none}
  .quote{border-left:2px solid var(--ghost-2);padding-left:12px;margin-bottom:12px;color:var(--t2);font-size:12px;line-height:17px;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .quote .kind{color:var(--t3);text-transform:uppercase;letter-spacing:.04em;font-size:10.5px;margin-right:4px}
  .shot{display:block;max-width:100%;max-height:120px;border-radius:6px;margin:0 0 12px;box-shadow:0 0 0 1px var(--line)}
  .rtag{margin-top:10px;font-size:12px;color:var(--t3);display:flex;align-items:center;gap:6px} .rtag svg{width:14px;height:14px}
  .rtag[hidden],.pnew[hidden],.empty[hidden]{display:none}
  .empty{color:var(--t3);font-size:13px;padding:40px 24px;text-align:center;line-height:20px;white-space:pre-line}

  .band{position:fixed;display:none;border-radius:4px;box-shadow:inset 0 0 0 1.5px var(--accent);background:rgba(37,125,224,.08);z-index:44;pointer-events:none}
  .pick{position:fixed;display:none;pointer-events:none;border-radius:6px;box-shadow:0 0 0 1.5px var(--accent);background:rgba(37,125,224,.07);z-index:44}
  .pick.show{display:block}
  .pick span{position:absolute;left:-1px;bottom:calc(100% + 4px);white-space:nowrap;padding:2px 7px;border-radius:6px;background:var(--accent);color:#fff;font:500 11px/16px ${SANS}}
  .pick span i{font-style:normal;opacity:.8;margin-left:6px}
  .toast{position:fixed;bottom:24px;left:50%;translate:-50% 0;display:none;align-items:center;gap:4px;min-height:40px;max-width:min(560px,calc(100vw - 32px));padding:0 6px 0 14px;
    border-radius:12px;background:var(--popover);box-shadow:inset 0 0 0 1px var(--ring),var(--sh-pop);font:14px/20px ${SANS};color:var(--t1);z-index:70}
  .toast.show{display:flex;animation:rise .16s var(--ease)}
  .toast span{padding:10px 8px 10px 0}
  .toast button{all:unset;cursor:pointer;font-weight:520;padding:4px 8px;border-radius:8px;color:var(--accent-text);flex:none}
  .toast button:hover{background:var(--ghost)} .toast button:empty{display:none}
  .pastebox{position:fixed;top:15%;left:10%;width:80%;height:60%;z-index:80;background:var(--surface);color:var(--t1);border:0;border-radius:14px;padding:14px;
    font:12px/1.5 ${MONO};box-shadow:0 0 0 1px var(--accent),var(--sh-pop)}
  @media (max-width:700px){.panel{width:100%} .ui.panel-open .top{right:16px}}
  @media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important}}`;

  const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const I = {
    comment: svg('<path d="M20 11.5a7.5 7.5 0 0 1-11 6.6L4 19.5l1.4-4.6A7.5 7.5 0 1 1 20 11.5z"/>'),
    cursor: svg('<path d="M5 4l6.5 16 2.3-6.7L20.5 11z"/>'),
    box: svg('<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/>'),
    block: svg('<rect x="4" y="5" width="16" height="14" rx="2.5"/><path d="M8 10h8M8 14h5"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
    dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/></svg>',
    up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>', 'stroke-width="2"'),
    x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    filter: svg('<path d="M4 6h16M7 12h10M10 18h4"/>'),
    down: svg('<path d="M12 5v14M6 13l6 6 6-6"/>', 'stroke-width="2"'),
    caret: svg('<path d="m7 10 5 5 5-5"/>', 'class="caret" stroke-width="2"'),
    copy: svg('<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
    codex: svg('<path d="M7 8l4 4-4 4M13 16h4"/>', 'stroke-width="2.2"'),
    spark: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 2l1.6 6.2L20 6l-4.4 4.8L22 12l-6.4 1.2L20 18l-6.4-2.2L12 22l-1.6-6.2L4 18l4.4-4.8L2 12l6.4-1.2L4 6l6.4 2.2z"/></svg>',
    resolve: '<svg class="rs" viewBox="0 0 20 20" width="16" height="16"><rect class="sq" x="2.5" y="2.5" width="15" height="15" rx="4.5" pathLength="52"/><path class="ck" d="M6.2 10.4l2.6 2.6 5-5.6"/></svg>',
  };

  const host = document.createElement('az-annotate');
  host.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:2147483000;';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${UI_STYLE}</style>
  <div class="ui" id="ui">
    <div class="top" role="toolbar" aria-label="Annotate">
      <button class="tool" id="modeBtn" aria-haspopup="menu" aria-expanded="false"></button><span class="sep"></span>
      <button class="tool" id="listBtn" title="All comments" aria-label="Show all comments"></button>
    </div>
    <div class="selbar" id="selbar" role="toolbar" aria-label="Selection"><button class="tool" id="sbComment">${I.comment}Comment</button></div>
    <div class="rail" id="rail"></div>
    <aside class="panel" id="panel" aria-label="Comments">
      <div class="ph"><h3>Comments</h3><span class="n" id="pcount"></span>
        <button class="ib" id="filterBtn" title="Filter" aria-label="Filter">${I.filter}</button>
        <button class="ib" id="pmoreBtn" title="More" aria-label="More">${I.dots}</button>
        <button class="ib" id="pclose" title="Close" aria-label="Close">${I.x}</button></div>
      <div class="pnew" id="pnew" hidden></div>
      <div class="plist" id="plist"><div class="empty" id="pempty" hidden></div></div>
    </aside>
    <div class="band" id="band"></div>
    <div class="pick" id="pick"><span></span></div>
    <div class="toast" id="toast" role="status"><span></span><button></button></div>
  </div>`;
  const $ = id => root.getElementById(id);
  const ui = $('ui'), rail = $('rail'), plist = $('plist');
  const fromUI = e => e.composedPath().includes(host);

  /* theme: follow the doc's own background, so cards look native on light and dark docs */
  function lum(c) { const m = String(c).match(/[\d.]+/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); if (a < 0.1) return null; return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
  function applyTheme() {
    let dark;
    if (CFG.theme === 'dark' || CFG.theme === 'light') dark = CFG.theme === 'dark';
    else {
      const bg = lum(getComputedStyle(document.body).backgroundColor) ?? lum(getComputedStyle(HTML).backgroundColor);
      dark = bg != null ? bg < 0.5 : (lum(getComputedStyle(document.body).color) ?? 0) > 0.6;
    }
    ui.dataset.theme = dark ? 'dark' : 'light';
    HTML.style.setProperty('--az-edge', dark ? '#fbb315' : '#bf8004');
  }
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(applyTheme, 50));

  let toastT;
  function toast(s, label, fn, ms) {
    const t = $('toast'); t.firstChild.textContent = s;
    const b = t.querySelector('button'); b.textContent = label || ''; b.onclick = fn ? () => { t.classList.remove('show'); fn(); } : null;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms || (fn ? 4500 : Math.min(1600 + s.length * 25, 6000)));
  }

  /* ===================== markdown (safe: escape then subset) ===================== */
  function inlineMd(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[i] + '</code>');
  }
  /* Math via KaTeX, code via highlight.js — loaded from a CDN only when an answer needs them.
     Offline, math stays as readable TeX and code stays plain. */
  const KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/', HLJS = 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.12.0/';
  const libs = {};
  function addCss(href, where) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; where.appendChild(l); }
  function addFonts(href) {   // only @font-face rules go in the page head: the full sheet would restyle the doc's own math
    const dir = href.slice(0, href.lastIndexOf('/') + 1);
    fetch(href).then(r => r.ok ? r.text() : '').then(t => {
      const faces = (t.match(/@font-face\s*\{[^}]*\}/g) || []).join('\n').replace(/url\((['"]?)(?![a-z]+:)/gi, 'url($1' + dir);
      if (!faces) return;
      const s = document.createElement('style'); s.setAttribute('data-az-fonts', href); s.textContent = faces; document.head.appendChild(s);
    }).catch(() => {});
  }
  function loadLib(name, test, js, css) {
    if (test()) return true;
    if (libs[name]) return false;
    libs[name] = 'loading';
    css.forEach(([href, fonts]) => { addCss(href, root); if (fonts && !document.querySelector('style[data-az-fonts="' + href + '"]')) addFonts(href); });
    const sc = document.createElement('script'); sc.src = js; sc.async = true;
    sc.onload = () => { libs[name] = test() ? 'ok' : 'fail'; refreshAll(); };
    sc.onerror = () => { libs[name] = 'fail'; };
    document.head.appendChild(sc);
    return false;
  }
  const katexReady = () => loadLib('katex', () => !!(window.katex && window.katex.renderToString), KATEX + 'katex.min.js', [[KATEX + 'katex.min.css', true]]);
  const hljsReady = () => loadLib('hljs', () => !!(window.hljs && window.hljs.highlightElement), HLJS + 'highlight.min.js', [[HLJS + 'styles/github-dark.min.css', false]]);
  function renderTex(tex, display, raw) {
    if (katexReady()) { try { return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' }); } catch (e) {} }
    return '<span class="tex' + (display ? ' disp' : '') + '">' + esc(raw) + '</span>';
  }
  function stashMath(text, maths) {
    const codes = [];
    text = text.replace(/`[^`\n]+`/g, c => { codes.push(c); return '\u0002' + (codes.length - 1) + '\u0002'; });
    const put = (raw, tex, display) => { maths.push(renderTex(tex.trim(), display, raw)); return '\u0001' + (maths.length - 1) + '\u0001'; };
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (r, t) => put(r, t, true)).replace(/\\\[([\s\S]+?)\\\]/g, (r, t) => put(r, t, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (r, t) => put(r, t, false))
      .replace(/(^|[^\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, (r, pre, t) => pre + put(r.slice(pre.length), t, false));
    return text.replace(/\u0002(\d+)\u0002/g, (_, i) => codes[i]);
  }
  function md(src) {
    const maths = [], out = [];
    let chunk = [], inFence = false;
    for (const raw of String(src || '').split(/\r?\n/)) {
      if (/^```/.test(raw.trim())) { if (!inFence) { out.push(stashMath(chunk.join('\n'), maths)); chunk = []; } out.push(raw); inFence = !inFence; continue; }
      (inFence ? out : chunk).push(raw);
    }
    if (chunk.length) out.push(stashMath(chunk.join('\n'), maths));
    const lines = esc(out.join('\n')).split('\n');
    let html = '', inUL = false, inOL = false, para = [], fence = null, code = [];
    const closeLists = () => { if (inUL) { html += '</ul>'; inUL = false; } if (inOL) { html += '</ol>'; inOL = false; } };
    const flush = () => { if (para.length) { html += '<p>' + inlineMd(para.join('<br>')) + '</p>'; para = []; } };
    const codeBlock = () => '<pre><code' + (fence ? ' class="language-' + fence + '"' : '') + '>' + code.join('\n') + '</code></pre>';
    const cells = l => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => inlineMd(c.trim()));
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const f = raw.trim().match(/^```\s*([\w+#.-]*)/);
      if (f) { if (fence !== null) { html += codeBlock(); code = []; fence = null; } else { flush(); closeLists(); fence = f[1].toLowerCase(); } continue; }
      if (fence !== null) { code.push(raw); continue; }
      const line = raw.trim(); let m;
      if (!line) { flush(); continue; }
      if (/^\|.*\|$/.test(line) && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test((lines[i + 1] || '').trim())) {
        flush(); closeLists();
        html += '<div class="tbl"><table><thead><tr>' + cells(line).map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>';
        i += 2;
        for (; i < lines.length && /^\|.*\|$/.test(lines[i].trim()); i++) html += '<tr>' + cells(lines[i].trim()).map(c => '<td>' + c + '</td>').join('') + '</tr>';
        i--; html += '</tbody></table></div>'; continue;
      }
      if ((m = line.match(/^#{1,4}\s+(.*)$/))) { flush(); closeLists(); html += '<h4>' + inlineMd(m[1]) + '</h4>'; continue; }
      if ((m = line.match(/^(\d+)[.)]\s+(.*)$/))) { flush(); if (inUL) { html += '</ul>'; inUL = false; } if (!inOL) { html += '<ol>'; inOL = true; } html += '<li>' + inlineMd(m[2]) + '</li>'; continue; }
      if ((m = line.match(/^[-*•]\s+(.*)$/))) { flush(); if (inOL) { html += '</ol>'; inOL = false; } if (!inUL) { html += '<ul>'; inUL = true; } html += '<li>' + inlineMd(m[1]) + '</li>'; continue; }
      closeLists(); para.push(line);
    }
    if (fence !== null) html += codeBlock();
    flush(); closeLists();
    return html.replace(/\u0001(\d+)\u0001/g, (_, i) => maths[i]);
  }
  function highlightIn(el) {
    const blocks = el.querySelectorAll('pre code:not(.hljs)');
    if (!blocks.length || !hljsReady()) return;
    blocks.forEach(b => { try { window.hljs.highlightElement(b); } catch (e) {} });
  }

  /* ===================== text anchoring ===================== */
  function textIndex() {
    const w = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentNode && n.parentNode.closest && n.parentNode.closest('az-annotate,script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    let full = '', segs = [], n;
    while ((n = w.nextNode())) { if (!n.nodeValue) continue; segs.push({ node: n, start: full.length, end: full.length + n.nodeValue.length }); full += n.nodeValue; }
    return { full, segs };
  }
  function posToNode(segs, pos) {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (segs[mid].end < pos) lo = mid + 1; else hi = mid; }
    const s = segs[lo]; return { node: s.node, offset: Math.max(0, Math.min(pos - s.start, s.node.nodeValue.length)) };
  }
  function normIndex(full) {
    let norm = '', map = [], ws = false;
    for (let i = 0; i < full.length; i++) {
      const c = full.charCodeAt(i), isWS = c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 160;
      if (isWS) { if (!ws) { norm += ' '; map.push(i); } ws = true; } else { norm += full[i]; map.push(i); ws = false; }
    }
    map.push(full.length);
    return { norm, map };
  }
  const tailMatch = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
  const headMatch = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
  // The occurrence of the phrase whose surroundings best match the stored prefix/suffix.
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
  // Offsets in the same text the index walks (it skips <style>/<script>, e.g. the style block inside
  // a Mermaid SVG). Range.toString() would count those and shift every offset after a diagram.
  function offsetOf(idx, node, off) {
    if (node.nodeType === 3) { const g = idx.segs.find(x => x.node === node); if (g) return g.start + Math.min(off, node.nodeValue.length); }
    const r = document.createRange();
    if (node.nodeType === 3) r.setStartAfter(node); else r.setStart(node, off);
    r.collapse(true);
    for (const g of idx.segs) if (r.comparePoint(g.node, 0) >= 0) return g.start;
    return idx.full.length;
  }
  function anchorFromRange(range) {
    const idx = textIndex(), full = idx.full;
    let s = offsetOf(idx, range.startContainer, range.startOffset), e = offsetOf(idx, range.endContainer, range.endOffset);
    while (s < e && /\s/.test(full[s])) s++;
    while (e > s && /\s/.test(full[e - 1])) e--;
    return { type: 'text', exact: normWS(full.slice(s, e)), prefix: normWS(full.slice(Math.max(0, s - 32), s)), suffix: normWS(full.slice(e, e + 32)) };
  }
  function wrapRange(range, id) {
    try {
      const nodes = [];
      const w = document.createTreeWalker(range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
        acceptNode: n => range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
      });
      let n; while ((n = w.nextNode())) nodes.push(n);
      const sc = range.startContainer, so = range.startOffset, ec = range.endContainer, eo = range.endOffset;
      nodes.forEach(node => {
        const start = node === sc ? so : 0, end = node === ec ? eo : node.nodeValue.length;
        if (start >= end) return;
        const middle = start > 0 ? node.splitText(start) : node;
        if (end - start < middle.nodeValue.length) middle.splitText(end - start);
        if (!middle.nodeValue.trim()) return;
        const p = middle.parentNode;
        // <mark> is HTML — inside SVG it is invalid and the label vanishes; skip non-HTML parents.
        if (!p || p.namespaceURI !== 'http://www.w3.org/1999/xhtml' || /^(script|style|textarea|title)$/i.test(p.nodeName)) return;
        const mark = document.createElement('mark'); mark.className = 'az-hl'; mark.dataset.tid = id;
        p.insertBefore(mark, middle); mark.appendChild(middle);
      });
    } catch (e) {}
  }
  function selectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el !== content && el.nodeType === 1) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); return parts.join('>'); }
      let p = el.tagName.toLowerCase();
      const sib = Array.from(el.parentNode.children).filter(c => c.tagName === el.tagName);
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')';
      parts.unshift(p); el = el.parentNode;
    }
    return parts.join('>');
  }
  function elFromAnchor(a) {
    let el = null;
    try { el = a.sel ? (a.sel[0] === '#' ? document.querySelector(a.sel) : content.querySelector(':scope>' + a.sel) || content.querySelector(a.sel)) : null; } catch (e) {}
    const txt = normWS(a.text || '').trim();
    if (el && (!txt || normWS(el.textContent || '').trim().startsWith(txt.slice(0, 40)))) return el;
    // the text under the selector changed: look for the text elsewhere; if it is gone too, the
    // block at the same position is the best guess (docs often get rewritten in place)
    if (a.tag && txt) {
      const c = [...content.querySelectorAll(a.tag)];
      const byText = c.find(e => normWS(e.textContent || '').trim().slice(0, 120) === txt) || c.find(e => normWS(e.textContent || '').trim().startsWith(txt.slice(0, 60)));
      if (byText) return byText;
    }
    return el || null;
  }

  /* ===================== regions pinned to what they cover ===================== */
  // A region is pinned to the page pieces it was drawn over (a.els), its edges saved as fractions of
  // their joint bounds (a.f) or fixed pixel margins (a.m), so it follows them when text rewraps.
  // Content-wide fractions (x/y/w/h) are the fallback, and what the bridge uses for pictures.
  function regionEl(sel) { try { return content.querySelector(sel); } catch (e) { return null; } }
  function unionRect(els) {
    let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
    els.forEach(e => { const q = e.getBoundingClientRect(); if (!q.width && !q.height) return; l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); });
    return r > l ? { left: l, top: t, width: r - l, height: b - t } : null;
  }
  function regionRect(a) {
    const u = a.els && a.f && unionRect(a.els.map(regionEl).filter(Boolean));
    if (u && u.width && u.height) {
      const m = a.m || [], ux = f => u.left + f * u.width, uy = f => u.top + f * u.height;
      const l = m[0] != null ? u.left - m[0] : ux(a.f[0]), t = m[1] != null ? u.top - m[1] : uy(a.f[1]);
      const r = m[2] != null ? u.left + u.width + m[2] : ux(a.f[2]), b = m[3] != null ? u.top + u.height + m[3] : uy(a.f[3]);
      return { left: l, top: t, width: Math.max(4, r - l), height: Math.max(4, b - t) };
    }
    const cr = content.getBoundingClientRect(), bx = cr.left + content.clientLeft, by = cr.top + content.clientTop;
    return { left: bx + a.x * content.offsetWidth, top: by + a.y * content.offsetHeight, width: a.w * content.offsetWidth, height: a.h * content.offsetHeight };
  }
  const LEAF = /^(svg|img|canvas|video|picture|iframe|pre|table|math)$/i;
  function regionPieces(box) {
    const hit = q => Math.max(0, Math.min(q.right, box.right) - Math.max(q.left, box.left)) * Math.max(0, Math.min(q.bottom, box.bottom) - Math.max(q.top, box.top));
    const boxA = (box.right - box.left) * (box.bottom - box.top), out = [];
    const walk = el => {
      for (const c of el.children) {
        if (/^(az-annotate|az-box|script|style|template)$/i.test(c.tagName) || c.classList.contains('az-hl')) continue;
        const q = c.getBoundingClientRect(), a = q.width * q.height, h = hit(q);
        if (!a || h < Math.max(16, boxA * 0.02)) continue;
        const blockKids = !LEAF.test(c.tagName) && [...c.children].some(k => !/^inline/.test(getComputedStyle(k).display) && hit(k.getBoundingClientRect()) > 0);
        if (h >= a * 0.85 || !blockKids) out.push(c); else walk(c);
      }
    };
    walk(content);
    return out.length > 40 ? [] : out;
  }
  function regionAnchorEls(box) {
    const els = regionPieces(box); if (!els.length) return null;
    const u = unionRect(els); if (!u) return null;
    const sels = els.map(e => e.id ? '#' + CSS.escape(e.id) : ':scope>' + selectorFor(e));
    if (sels.some((q, i) => regionEl(q) !== els[i])) return null;
    const r4 = v => Math.round(v * 1e4) / 1e4, ur = u.left + u.width, ub = u.top + u.height, px = v => v >= 0 ? Math.round(v) : null;
    return { els: sels, f: [r4((box.left - u.left) / u.width), r4((box.top - u.top) / u.height), r4((box.right - u.left) / u.width), r4((box.bottom - u.top) / u.height)],
      m: [px(u.left - box.left), px(u.top - box.top), px(box.right - ur), px(box.bottom - ub)] };
  }
  // The window size and the page push (padding-right on <html>), so the bridge lays the page out the same way.
  function viewSize() { return { vw: HTML.clientWidth, vh: innerHeight, pad: Math.round(parseFloat(getComputedStyle(HTML).paddingRight) || 0) }; }
  function nearestHeading(clientTop) {
    let best = 'the top';
    content.querySelectorAll('h1,h2,h3,h4').forEach(h => { if (h.getBoundingClientRect().top <= clientTop + 20) best = h.textContent; });
    return normWS(best).trim().slice(0, 48);
  }

  /* ===================== marks + boxes in the host page ===================== */
  let draft = null;                 // { anchor, label, top, bottom, box?, target? } while a new comment is written
  let active = null;                // focused thread id
  const boxes = {};                 // id -> <az-box> for region and element threads
  const targets = {};               // id -> element a picked block points at
  function clearMarks() {
    const parents = new Set();
    content.querySelectorAll('mark.az-hl').forEach(m => { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); parents.add(p); });
    parents.forEach(p => p.normalize && p.normalize());
  }
  function syncMarks() {
    clearMarks();
    const idx = textIndex(), ranges = [];
    if (idx.segs.length) {
      for (const id in threads) { const t = threads[id]; if (t.type === 'text' && t.anchor) { const r = locateText(idx, t.anchor); if (r) ranges.push([r, id]); } }
      if (draft && draft.anchor.type === 'text') { const r = locateText(idx, draft.anchor); if (r) ranges.push([r, DRAFT]); }
    }
    ranges.forEach(([r, id]) => wrapRange(r, id));
    applyMarkState();
  }
  function applyMarkState(hoverId) {
    const on = active || hoverId;
    content.querySelectorAll('mark.az-hl').forEach(m => {
      const id = m.dataset.tid, t = threads[id];
      m.classList.toggle('az-gone', !!(t && t.resolved));
      m.classList.toggle('az-on', id === DRAFT || (!!on && id === on && !(t && t.resolved)));
    });
    for (const id in boxes) { const t = threads[id]; boxes[id].classList.toggle('az-gone', !!(t && t.resolved)); boxes[id].classList.toggle('az-on', !!on && id === on); }
    if (draft && draft.box) draft.box.classList.add('az-on');
    for (const [k, el] of railEls) el.classList.toggle('on', k === active);
    for (const [k, el] of panelEls) el.classList.toggle('on', k === on);
  }
  function ensureRelative(c) { if (getComputedStyle(c).position === 'static') { c.style.position = 'relative'; c.setAttribute('data-az-rel', ''); } }
  // Puts a box over a client rect. Inside a sideways-scrolling block it lives in that block, so it
  // scrolls and clips with it; otherwise it sits in the page.
  function placeBox(b, rect, container) {
    const parent = container || document.body;
    if (container) ensureRelative(container);
    if (b.parentElement !== parent) parent.appendChild(b);
    let ox, oy;
    if (container) { const c = container.getBoundingClientRect(); ox = c.left + container.clientLeft - container.scrollLeft; oy = c.top + container.clientTop - container.scrollTop; }
    else if (getComputedStyle(document.body).position === 'static') { ox = -scrollX; oy = -scrollY; }
    else { const c = document.body.getBoundingClientRect(); ox = c.left + document.body.clientLeft; oy = c.top + document.body.clientTop; }
    Object.assign(b.style, { left: (rect.left - ox) + 'px', top: (rect.top - oy) + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  }
  function placeAnchorBox(b, anchor, target) {
    if (target) {
      if (!target.isConnected) return false;
      const r = target.getBoundingClientRect(), p = 3;
      placeBox(b, { left: r.left - p, top: r.top - p, width: r.width + p * 2, height: r.height + p * 2 }, scrollerOf(target));
      return true;
    }
    const sc = anchor.scroll && scrollers()[anchor.scroll.i];
    if (sc) {   // drawn on a sideways-scrolling block: stored in that block's own coordinates
      ensureRelative(sc);
      if (b.parentElement !== sc) sc.appendChild(b);
      Object.assign(b.style, { left: anchor.scroll.x + 'px', top: anchor.scroll.y + 'px', width: anchor.scroll.w + 'px', height: anchor.scroll.h + 'px' });
      return true;
    }
    placeBox(b, regionRect(anchor), null);
    return true;
  }
  function layoutBoxes() {
    const live = new Set();
    for (const id in threads) {
      const t = threads[id]; if (t.type !== 'region' && t.type !== 'element') continue;
      let tg = null;
      if (t.type === 'element') { tg = targets[id]; if (!tg || !tg.isConnected) tg = targets[id] = elFromAnchor(t.anchor || {}); if (!tg) continue; }
      const b = boxes[id] || (boxes[id] = Object.assign(document.createElement('az-box'), {}));
      b.dataset.tid = id;
      if (placeAnchorBox(b, t.anchor || {}, tg)) live.add(id);
    }
    for (const id in boxes) if (!live.has(id)) { boxes[id].remove(); delete boxes[id]; }
    if (draft && draft.box) placeAnchorBox(draft.box, draft.anchor, draft.target);
    applyMarkState();
  }
  function anchorBox(id) {
    let rs = [];
    if (boxes[id]) rs = [boxes[id].getBoundingClientRect()];
    else content.querySelectorAll('mark.az-hl[data-tid="' + id + '"]').forEach(m => { const q = m.getClientRects(); for (const r of q) rs.push(r); });
    if (!rs.length) { const t = threads[id]; if (t && t.type === 'region' && t.anchor) rs = [regionRect(t.anchor)]; }
    if (!rs.length) return null;
    return { top: Math.min(...rs.map(r => r.top)) + scrollY, bottom: Math.max(...rs.map(r => r.top + r.height)) + scrollY };
  }
  // boxes ignore the pointer (so scrolling over a figure still works); clicks and hover find them by position
  function boxAt(x, y) {
    for (const id in boxes) {
      const t = threads[id]; if (!t || t.resolved) continue;
      const r = boxes[id].getBoundingClientRect(); if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const sc = boxes[id].parentElement !== document.body && boxes[id].parentElement;
      if (sc) { const c = sc.getBoundingClientRect(); if (x < c.left || x > c.right || y < c.top || y > c.bottom) continue; }
      return id;
    }
    return null;
  }

  /* ===================== layout: margin cards at the right edge ===================== */
  const CARD_W = 284, EDGE = 24, GAP = 32, PIN = 64;
  let railFits = false;
  const panelOpen = () => ui.classList.contains('panel-open');
  // How far the page is pushed to make room for the cards depends only on the window — never on
  // how many comments exist — so adding the first comment moves nothing.
  function measureRoom() {
    HTML.classList.remove('az-pad'); HTML.style.removeProperty('--az-pad');
    const W = HTML.clientWidth, cardX = W - CARD_W - EDGE;
    if (W < 1000) { railFits = false; return; }
    let cr = content.getBoundingClientRect();
    if (cr.right + GAP <= cardX) { railFits = true; return; }
    const push = p => { HTML.style.setProperty('--az-pad', p + 'px'); HTML.classList.add('az-pad'); return content.getBoundingClientRect(); };
    let p = Math.ceil(2 * (cr.right + GAP - cardX));          // a centred column moves by half the push
    cr = push(p);
    if (cr.right + GAP > cardX + 1) { p = W - cardX + GAP; cr = push(p); }   // a fluid page: reserve the whole column
    railFits = cr.right + GAP <= cardX + 1 && W - p >= 560;
    if (!railFits) { HTML.classList.remove('az-pad'); HTML.style.removeProperty('--az-pad'); }
  }
  const railEls = new Map(), panelEls = new Map();
  let stack = [];

  /* ===================== cards ===================== */
  let BRIDGE = false, MODELS = null;
  let choice = readLS(CHOICEKEY, null);
  const answering = {};            // id -> { text, by } while an answer streams in
  const shots = {};                // region picture state: 'probe' | 'wait' | 'ok' | 'none'
  function author(by) {
    const s = String(by || 'Claude'), codex = /^codex\b/i.test(s);
    return { name: codex ? 'Codex' : 'Claude', codex, model: s.replace(/^(claude|codex)\s*·?\s*/i, '').replace(/\s*\(([^)]+)\)\s*$/, ' · $1').trim() };
  }
  const avatarHTML = w => w.codex ? `<span class="av codex">${I.codex}</span>` : `<span class="av claude">${I.spark}</span>`;
  const timeStr = at => at ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  function msgsHTML(id) {
    const t = threads[id]; if (!t) return '';
    let h = t.messages.map((m, i) => {
      const isC = m.role !== 'user', w = isC ? author(m.by) : null;
      const acts = i !== 0 ? '' : t.resolved
        ? `<button class="ib" data-act="reopen" title="Reopen" aria-label="Reopen">${I.undo}</button><button class="ib" data-act="delete" title="Delete" aria-label="Delete">${I.trash}</button>`
        : `<button class="ib" data-act="resolve" title="Resolve" aria-label="Resolve">${I.resolve}</button>`;
      return `<div class="msg ${isC ? 'reply' : ''}"><div class="who">${isC ? avatarHTML(w) : '<span class="av you">Y</span>'}
        <span class="name">${isC ? w.name : 'You'}</span>${m.at ? `<span class="time">${timeStr(m.at)}</span>` : ''}
        ${isC && w.model ? `<span class="by" title="${esc(w.model)}">${esc(w.model)}</span>` : ''}
        ${acts ? `<span class="acts" role="toolbar" aria-label="Comment actions">${acts}</span>` : ''}</div>
        <div class="body">${isC ? md(m.text) : '<p>' + esc(m.text).replace(/\n/g, '<br>') + '</p>'}</div></div>`;
    }).join('');
    const a = answering[id];
    if (a && a.text) { const w = author(a.by); h += `<div class="msg reply streaming"><div class="who">${avatarHTML(w)}<span class="name">${w.name}</span>${w.model ? `<span class="by">${esc(w.model)}</span>` : ''}</div><div class="body">${md(a.text)}</div></div>`; }
    else if (a) { const w = author(a.by); h += `<div class="msg reply"><div class="who">${avatarHTML(w)}<span class="thinking">Thinking</span></div></div>`; }
    else if (!BRIDGE && pendingQuestions(t).length) h += `<div class="msg"><div class="note">Not answered yet. Use “Copy questions” in the Comments panel and paste them into any Claude chat.</div></div>`;
    return h;
  }
  function makeField(id, bare) {
    const f = document.createElement('div'); f.className = 'field' + (bare ? ' bare' : '');
    const ph = id ? 'Reply…' : 'Ask Claude…';
    f.innerHTML = `<div class="ed" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${id ? 'Reply' : 'Ask Claude'}" data-ph="${ph}"></div>
      <div class="frow"><div>${BRIDGE ? `<button class="model" title="Model">${esc(modelShort())} ${I.caret}</button>` : ''}
      <button class="send" aria-label="Send" title="Send (↵)" disabled>${I.up}</button></div></div>`;
    const ed = f.querySelector('.ed'), send = f.querySelector('.send');
    const text = () => ed.innerText.trim();
    const upd = () => { const ok = !!text(); send.classList.toggle('ready', ok); send.disabled = !ok; };
    const dkey = id || DRAFT;
    if (drafts[dkey] && id) { ed.textContent = drafts[dkey]; upd(); }
    ed.addEventListener('input', () => { if (!text()) ed.textContent = ''; upd(); if (id) { if (text()) drafts[id] = ed.innerText; else delete drafts[id]; persistDrafts(); } });
    ed.addEventListener('paste', e => { e.preventDefault(); const s = (e.clipboardData || window.clipboardData).getData('text/plain'); document.execCommand('insertText', false, s); });
    ed.addEventListener('focus', () => f.classList.add('focus'));
    ed.addEventListener('blur', () => setTimeout(() => { if (!f.contains(root.activeElement) && !text()) f.classList.remove('focus'); }, 120));
    f.addEventListener('mousedown', e => { if (!e.target.closest('button')) { e.stopPropagation(); setTimeout(() => ed.focus()); } });
    const go = () => { const q = text(); if (q) submit(id, q); };
    send.addEventListener('click', e => { e.stopPropagation(); go(); });
    ed.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
      if (e.key === 'Escape') { e.preventDefault(); if (draft) cancelDraft(); else { active = null; render(); } }
    });
    const mb = f.querySelector('.model'); if (mb) mb.addEventListener('click', e => { e.stopPropagation(); openModelMenu(mb); });
    return f;
  }
  function makeCard(kind, id) {
    const el = document.createElement('div'); el.className = kind + ' enter'; el.dataset.t = id;
    el.innerHTML = kind === 'card'
      ? '<div class="inner"><div class="msgwrap"><div class="scroll"><div class="msgs"></div></div></div><div class="slot"></div></div><button class="seemore" tabindex="-1">' + I.down + 'See more</button>'
      : '<div class="quote"></div><div class="scroll"><div class="msgs"></div></div><div class="rtag" hidden>' + I.check + 'Resolved</div><div class="slot"></div>';
    el.addEventListener('mouseenter', () => { if (!active) applyMarkState(el.dataset.t); });
    el.addEventListener('mouseleave', () => { if (!active) applyMarkState(null); });
    el.addEventListener('click', e => {
      const tid = el.dataset.t; if (tid === DRAFT || !threads[tid]) return;
      const b = e.target.closest('[data-act]');
      if (b) { e.stopPropagation(); act(tid, b.dataset.act, b); return; }
      if (e.target.closest('.field,a,.seemore')) return;
      if (active !== tid) { draft = null; activate(tid, panelOpen()); }
    });
    const sc = el.querySelector('.scroll');
    if (kind === 'card') {
      sc.addEventListener('scroll', () => overflowCheck(el), { passive: true });
      el.querySelector('.seemore').addEventListener('click', e => { e.stopPropagation(); sc.scrollBy({ top: sc.clientHeight * 0.8, behavior: reduced() ? 'auto' : 'smooth' }); });
    }
    return el;
  }
  function overflowCheck(el) {
    const sc = el.querySelector('.scroll'); if (!sc || !el.classList.contains('card')) return;
    const focused = el.classList.contains('on') || el.classList.contains('lifted');
    el.classList.toggle('clipped', !focused && sc.scrollHeight > sc.clientHeight + 4);
    el.classList.toggle('overflowing', focused && sc.scrollHeight - sc.clientHeight - sc.scrollTop > 8);
  }
  function fillCard(el, id, wantField) {
    const msgs = el.querySelector('.msgs'), h = id === DRAFT ? '' : msgsHTML(id);
    if (el._h !== h) {
      const sc = el.querySelector('.scroll'), atEnd = sc && sc.scrollHeight - sc.clientHeight - sc.scrollTop < 24;
      msgs.innerHTML = h; el._h = h; highlightIn(msgs);
      if (sc && atEnd && answering[id]) sc.scrollTop = sc.scrollHeight;
    }
    const q = el.querySelector('.quote'), t = threads[id];
    if (q && t) {
      const kind = t.type === 'text' ? '' : `<span class="kind">${t.type === 'region' ? 'box' : 'block'}</span>`;
      const shot = t.type === 'region' && shots[id] === 'ok' ? `<img class="shot" alt="" src="${shotUrl(id)}">` : '';
      const qh = shot ? '' : kind + esc(t.label || '');
      if (q._h !== qh + shot) { q.innerHTML = qh; q.hidden = !qh; q._h = qh + shot; let im = el.querySelector('.shot'); if (shot && !im) q.insertAdjacentHTML('beforebegin', shot); if (!shot && im) im.remove(); }
    }
    const rt = el.querySelector('.rtag'); if (rt) rt.hidden = !(t && t.resolved);
    const slot = el.querySelector('.slot');
    let fresh = null;
    if (wantField && !slot.firstChild) { fresh = makeField(id === DRAFT ? null : id, id === DRAFT); slot.appendChild(fresh); }
    if (!wantField && slot.firstChild) slot.innerHTML = '';
    overflowCheck(el);
    return fresh;
  }
  function leave(el, map, key) {
    map.delete(key);
    if (reduced()) { el.remove(); return; }
    if (el.classList.contains('tcard')) { el.style.maxHeight = el.offsetHeight + 'px'; void el.offsetHeight; }
    el.classList.add('leave');
    setTimeout(() => el.remove(), 280);
  }
  function pageOrigin() { const r = host.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY }; }

  function renderRail() {
    const show = railFits && !panelOpen();
    const o = pageOrigin();
    rail.style.left = (HTML.clientWidth - CARD_W - EDGE + scrollX - o.x) + 'px';
    const items = !show ? [] : Object.keys(threads).filter(id => !threads[id].resolved).map(id => ({ id, box: anchorBox(id) })).filter(i => i.box);
    if (show && draft) items.push({ id: DRAFT, box: { top: draft.top, bottom: draft.bottom } });
    items.sort((a, b) => a.box.top - b.box.top);
    const keep = new Set(items.map(i => i.id));
    for (const [k, el] of [...railEls]) if (!keep.has(k)) { show ? leave(el, railEls, k) : (el.remove(), railEls.delete(k)); }
    let focusEd = null; const fresh = [];
    items.forEach(it => {
      let el = railEls.get(it.id);
      if (!el) { el = makeCard('card', it.id); rail.appendChild(el); railEls.set(it.id, el); fresh.push(el); el.style.transition = 'none'; sizeWatch.observe(el); }
      const isFocus = it.id === DRAFT || it.id === active;
      el.classList.toggle('lifted', it.id === DRAFT);
      el.classList.toggle('on', it.id === active);
      if (!isFocus) { const sc = el.querySelector('.scroll'); if (sc) sc.scrollTop = 0; }
      const f = fillCard(el, it.id, isFocus && (it.id === DRAFT || !threads[it.id].resolved));
      if (f && it.id === DRAFT) focusEd = f.querySelector('.ed');
    });
    // the focused card sits level with its anchor; the rest make room above and below it
    const els = items.map(i => railEls.get(i.id)), pos = items.map(i => i.box.top - o.y);
    let fi = items.findIndex(i => i.id === (draft ? DRAFT : active)); if (fi < 0) fi = 0;
    for (let i = fi + 1; i < items.length; i++) pos[i] = Math.max(pos[i], pos[i - 1] + els[i - 1].offsetHeight + 8);
    for (let i = fi - 1; i >= 0; i--) pos[i] = Math.min(pos[i], pos[i + 1] - els[i].offsetHeight - 8);
    els.forEach((el, i) => { el._base = pos[i]; el._abottom = items[i].box.bottom - o.y; el.classList.remove('pinned'); });
    stack = els;
    pin(false);
    if (fresh.length) { void rail.offsetHeight; fresh.forEach(el => { el.style.transition = ''; }); requestAnimationFrame(() => fresh.forEach(el => el.classList.remove('enter'))); }
    if (focusEd) focusEd.focus({ preventScroll: true });
  }
  /* The focused card stays on screen while its anchor is; cards below are pushed along, so nothing overlaps. */
  function pin(fromScroll) {
    const focus = railEls.get(draft ? DRAFT : active), fi = stack.indexOf(focus), tops = stack.map(el => el._base);
    if (fi >= 0) {
      const min = scrollY - pageOrigin().y + PIN;
      if (tops[fi] < min) tops[fi] = Math.max(tops[fi], Math.min(min, focus._abottom - 32));
      for (let i = fi + 1; i < stack.length; i++) tops[i] = Math.max(stack[i]._base, tops[i - 1] + stack[i - 1].offsetHeight + 8);
    }
    stack.forEach((el, i) => {
      const moving = Math.abs(parseFloat(el.style.top) - tops[i]) > 0.5;
      if (fromScroll && moving) el.classList.add('pinned');   // only cards the scroll itself moves follow it exactly
      if (moving || !fromScroll) el.style.top = tops[i] + 'px';
    });
  }
  let rs = 0; const sizeWatch = new ResizeObserver(() => { cancelAnimationFrame(rs); rs = requestAnimationFrame(renderRail); });

  const visible = (t, f) => f === 'all' || (f === 'open' ? !t.resolved : !!t.resolved);
  let filter = 'open';
  function renderPanel() {
    const ids = Object.keys(threads), open = ids.filter(id => !threads[id].resolved).length;
    $('pcount').textContent = open;
    $('listBtn').innerHTML = `${I.comment}<span class="n">${open}</span>`;
    $('listBtn').classList.toggle('sel', panelOpen());
    const top = id => { const b = anchorBox(id); return b ? b.top : 1e9; };
    const shown = ids.filter(id => visible(threads[id], filter)).sort((a, b) => top(a) - top(b));
    shown.forEach(ensureShot);
    const keep = new Set(shown);
    for (const [k, el] of [...panelEls]) if (!keep.has(k)) { panelOpen() ? leave(el, panelEls, k) : (el.remove(), panelEls.delete(k)); }
    let focusEd = null; const fresh = [];
    shown.forEach(id => {
      let el = panelEls.get(id);
      if (!el) { el = makeCard('tcard', id); panelEls.set(id, el); fresh.push(el); }
      fillCard(el, id, active === id && !threads[id].resolved);
    });
    let ref = plist.querySelector('.tcard:not(.leave)');
    shown.forEach(id => {
      const el = panelEls.get(id);
      while (ref && ref.classList.contains('leave')) ref = ref.nextElementSibling;
      if (el !== ref) plist.insertBefore(el, ref); else ref = ref.nextElementSibling;
    });
    const empty = $('pempty');
    empty.hidden = shown.length > 0;
    empty.textContent = filter === 'resolved' ? 'No resolved comments.' : 'Select text to comment.\nPress R to draw a box, E to pick a block.';
    plist.prepend(empty);
    if (fresh.length) requestAnimationFrame(() => fresh.forEach(el => el.classList.remove('enter')));
    const pn = $('pnew');
    if (draft && panelOpen()) {
      if (pn._d !== draft) {
        pn._d = draft; pn.hidden = false; pn.innerHTML = `<div class="quote">${esc(draft.label)}</div>`;
        const f = makeField(null, false); pn.appendChild(f); focusEd = f.querySelector('.ed');
      }
    } else if (pn._d) { pn._d = null; pn.hidden = true; pn.innerHTML = ''; }
    if (focusEd) focusEd.focus({ preventScroll: true });
  }
  function render() {
    if (draft && !railFits && !panelOpen()) setPanel(true, true);
    if (active && !railFits && !panelOpen()) setPanel(true, true);
    layoutBoxes(); renderPanel(); renderRail(); applyMarkState();
  }
  function refreshAll() { for (const el of railEls.values()) el._h = null; for (const el of panelEls.values()) el._h = null; render(); }
  function setPanel(open, quiet) {
    ui.classList.toggle('panel-open', open); HTML.classList.toggle('az-panel', open);
    if (!quiet) render();
    prime();
  }
  function activate(id, scroll) {
    active = id;
    try { history.replaceState(history.state, '', location.pathname + location.search + '#az=' + id); } catch (e) {}
    render();
    if (scroll) { const b = boxes[id] || content.querySelector('mark.az-hl[data-tid="' + id + '"]'); if (b) b.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }); }
  }
  function deactivate() {
    active = null;
    if (/#az=/.test(location.hash)) try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) {}
    render();
  }

  /* ===================== actions ===================== */
  function act(id, a, b) {
    const t = threads[id]; if (!t) return;
    if (a === 'resolve') {
      if (b.classList.contains('resolving')) return;
      b.classList.add('resolving');
      setTimeout(() => {
        t.resolved = true; persist(); if (active === id) deactivate(); else render();
        toast('Comment resolved', 'Undo', () => { t.resolved = false; persist(); render(); });
      }, reduced() ? 0 : 360);
    }
    if (a === 'reopen') { t.resolved = false; persist(); render(); toast('Comment reopened'); }
    if (a === 'delete') deleteThread(id);
  }
  function deleteThread(id) {
    delete threads[id]; delete drafts[id]; deletedIds.add(id); persist(); persistDeleted(); persistDrafts();
    if (active === id) active = null;
    if (boxes[id]) { boxes[id].remove(); delete boxes[id]; }
    syncMarks(); render(); toast('Deleted');
    // also remove it from the threads file, or a cleared browser would bring it back
    if (BRIDGE) fetch('/__annot/delete-thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: baseName(), id }) }).catch(() => {});
  }
  function submit(id, q) {
    if (!id) {
      if (!draft) return;
      id = uid();
      const d = draft;
      threads[id] = { type: d.anchor.type, anchor: d.anchor, label: d.label, messages: [] };
      content.querySelectorAll('mark.az-hl[data-tid="' + DRAFT + '"]').forEach(m => { m.dataset.tid = id; });
      if (d.box) { boxes[id] = d.box; d.box.dataset.tid = id; }
      if (d.target) targets[id] = d.target;
      const el = railEls.get(DRAFT);             // the new-comment card becomes the thread's card: same element, no jump
      if (el) { railEls.delete(DRAFT); el.dataset.t = id; railEls.set(id, el); el.querySelector('.slot').innerHTML = ''; el._h = null; }
      draft = null;
    }
    const t = threads[id];
    t.messages.push({ role: 'user', text: q, at: Date.now() });
    delete drafts[id]; persistDrafts(); persist();
    root.querySelectorAll('[data-t="' + id + '"] .slot .ed').forEach(ed => { ed.textContent = ''; ed.dispatchEvent(new Event('input')); });
    active = id;
    try { history.replaceState(history.state, '', location.pathname + location.search + '#az=' + id); } catch (e) {}
    render();
    if (BRIDGE) askBridge(id);
    else toast('Saved. Copy the questions from the Comments panel to ask Claude.', 'Copy', copyQuestions);
  }
  function cancelDraft() {
    const hadText = draft && draft.anchor.type === 'text';
    if (draft && draft.box) draft.box.remove();
    draft = null; active = null;
    if (hadText) syncMarks();
    render();
  }
  function startDraft(d) {
    if (draft) cancelDraft();
    active = null; draft = d;
    if (d.anchor.type === 'text') syncMarks();
    render(); prime();
  }

  /* ===================== selection → one Comment button ===================== */
  const selbar = $('selbar'); let pendingRange = null, suppressClick = 0;
  let mode = 'select';
  document.addEventListener('mouseup', e => {
    if (mode !== 'select' || fromUI(e)) return;
    setTimeout(() => {
      const s = document.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount) { selbar.classList.remove('show'); return; }
      const r = s.getRangeAt(0);
      if (!content.contains(r.commonAncestorContainer) || s.toString().trim().length < 2) { selbar.classList.remove('show'); return; }
      pendingRange = r.cloneRange();
      const rect = r.getBoundingClientRect();
      selbar.classList.add('show');
      const l = Math.max(8, Math.min(rect.left + rect.width / 2 - selbar.offsetWidth / 2, innerWidth - selbar.offsetWidth - 8));
      const above = rect.top - selbar.offsetHeight - 8;
      selbar.style.left = l + 'px'; selbar.style.top = Math.max(8, Math.min(innerHeight - selbar.offsetHeight - 8, above < 8 ? rect.bottom + 8 : above)) + 'px';
    });
  });
  document.addEventListener('selectionchange', () => { const s = document.getSelection(); if (s && s.isCollapsed) selbar.classList.remove('show'); });
  addEventListener('scroll', () => selbar.classList.remove('show'), { passive: true, capture: true });
  $('sbComment').addEventListener('mousedown', e => {
    e.preventDefault();
    // the bar hides on press, so the release lands on the page and fires a stray "click outside": ignore it
    suppressClick = Date.now();
    if (!pendingRange) return;
    const anchor = anchorFromRange(pendingRange); if (!anchor.exact) return;
    const rr = pendingRange.getBoundingClientRect();
    selbar.classList.remove('show'); document.getSelection().removeAllRanges(); pendingRange = null;
    startDraft({ anchor, label: anchor.exact.length > 140 ? anchor.exact.slice(0, 138) + '…' : anchor.exact, top: rr.top + scrollY, bottom: rr.bottom + scrollY });
  });

  /* ===================== draw a box ===================== */
  const band = $('band'); let drawing = null;
  document.addEventListener('mousedown', e => {
    if (mode !== 'region' || e.button !== 0 || fromUI(e)) return;
    const cr = content.getBoundingClientRect();
    // inside the doc column, or on anything that belongs to the doc (wide figures stick out past it)
    const inside = e.clientX >= cr.left && e.clientX <= cr.right && e.clientY >= cr.top && e.clientY <= cr.bottom;
    if (!inside && !(content.contains(e.target) && e.target !== content)) return;
    e.preventDefault();
    drawing ={ x: e.clientX, y: e.clientY, sx: scrollX, sy: scrollY };
    Object.assign(band.style, { display: 'block', left: e.clientX + 'px', top: e.clientY + 'px', width: '0px', height: '0px' });
  }, true);
  addEventListener('mousemove', e => {
    if (!drawing) return;
    const x0 = drawing.x - (scrollX - drawing.sx), y0 = drawing.y - (scrollY - drawing.sy);
    drawing.box = { left: Math.min(x0, e.clientX), top: Math.min(y0, e.clientY), right: Math.max(x0, e.clientX), bottom: Math.max(y0, e.clientY) };
    Object.assign(band.style, { left: drawing.box.left + 'px', top: drawing.box.top + 'px', width: (drawing.box.right - drawing.box.left) + 'px', height: (drawing.box.bottom - drawing.box.top) + 'px' });
  });
  addEventListener('mouseup', () => {
    if (!drawing) return;
    const b = drawing.box; drawing = null; band.style.display = 'none';
    suppressClick = Date.now();
    if (!b || b.right - b.left < 12 || b.bottom - b.top < 12) return;
    const cr = content.getBoundingClientRect(), W = content.offsetWidth, H = content.offsetHeight;
    const bx = cr.left + content.clientLeft, by = cr.top + content.clientTop, w = b.right - b.left, h = b.bottom - b.top;
    const anchor = Object.assign({ type: 'region', x: (b.left - bx) / W, y: (b.top - by) / H, w: w / W, h: h / H, cw: W, ch: H }, viewSize(), regionAnchorEls(b) || {});
    // drawn on a sideways-scrolling figure/table: remember which one and how far it was scrolled
    const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2, list = scrollers(true);
    const sc = list.find(s => { const r = s.getBoundingClientRect(); return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom; });
    if (sc) {
      const r = sc.getBoundingClientRect();
      anchor.scroll = { i: list.indexOf(sc), left: Math.round(sc.scrollLeft), x: Math.round(b.left - r.left - sc.clientLeft + sc.scrollLeft), y: Math.round(b.top - r.top - sc.clientTop + sc.scrollTop), w: Math.round(w), h: Math.round(h) };
    }
    const box = document.createElement('az-box');
    setMode('select');
    startDraft({ anchor, label: 'Box near “' + nearestHeading(b.top) + '”', box, top: b.top + scrollY, bottom: b.bottom + scrollY });
  });

  /* ===================== pick a block (↑/↓ to grow or shrink) ===================== */
  const BLOCKS = 'td,th,tr,table,p,li,ul,ol,dl,h1,h2,h3,h4,h5,blockquote,pre:not(.mermaid),img,figure,[data-annot],.node,.card,.step,.box,.prob';
  function svgNode(t) {
    const s = t.closest && t.closest('svg'); if (!s || !content.contains(s)) return null;
    // Mermaid draws each node as <g class="node">; other diagrams: the smallest group holding a shape and its label
    let g = t.closest('g.node, g.cluster, g.edgeLabel');
    if (!g) for (let e = t.closest('g'); e && e !== s && s.contains(e); e = e.parentElement && e.parentElement.closest('g')) {
      if (e.querySelector('text, foreignObject') && e.querySelector('rect, path, circle, ellipse, polygon')) { g = e; break; }
    }
    return g && s.contains(g) ? g : null;
  }
  function pickChain(t) {
    const chain = [], n = svgNode(t);
    if (n) chain.push(n);
    for (let e = n ? n.closest('svg') : t; e && e !== content; e = e.parentElement) {
      if (e.nodeType === 1 && !(e instanceof SVGElement && e.tagName.toLowerCase() !== 'svg') && e.matches && e.matches(BLOCKS + ',svg') && !chain.includes(e)) chain.push(e);
    }
    return chain.filter(e => content.contains(e) && !(e.tagName.toLowerCase() === 'svg' && e.closest('figure')));
  }
  function blockName(e) {
    if (e instanceof SVGElement) return e.tagName.toLowerCase() === 'svg' ? 'Diagram' : 'Node';
    const tag = e.tagName.toLowerCase();
    if (e.matches('figure')) return e.querySelector('svg,img,canvas') ? 'Diagram' : 'Figure';
    return { td: 'Cell', th: 'Header cell', tr: 'Row', table: 'Table', p: 'Paragraph', li: 'List item', ul: 'List', ol: 'List', dl: 'List', h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', blockquote: 'Quote', pre: 'Code', img: 'Image' }[tag] || 'Block';
  }
  const pickEl = $('pick'); let pick = { chain: [], level: 0 };
  function showPick() {
    const el = pick.chain[pick.level];
    if (mode !== 'element' || !el) { pickEl.classList.remove('show'); return; }
    let r = el.getBoundingClientRect();
    const sc = scrollerOf(el);
    if (sc) { const c = sc.getBoundingClientRect(); r = { left: Math.max(r.left, c.left), right: Math.min(r.right, c.right), top: r.top, bottom: r.bottom }; }
    Object.assign(pickEl.style, { left: (r.left - 3) + 'px', top: (r.top - 3) + 'px', width: (r.right - r.left + 6) + 'px', height: (r.bottom - r.top + 6) + 'px' });
    const more = pick.level < pick.chain.length - 1, less = pick.level > 0;
    pickEl.firstChild.innerHTML = blockName(el) + (more || less ? `<i>${more ? '↑ ' + blockName(pick.chain[pick.level + 1]).toLowerCase() : ''}${more && less ? '  ' : ''}${less ? '↓ smaller' : ''}</i>` : '');
    pickEl.classList.add('show');
  }
  document.addEventListener('mousemove', e => {
    if (mode !== 'element') return;
    const chain = !fromUI(e) && content.contains(e.target) ? pickChain(e.target) : [];
    if (chain[0] !== pick.chain[0]) pick = { chain, level: 0 }; else pick.chain = chain;
    showPick();
  }, { passive: true });
  addEventListener('scroll', () => { if (mode === 'element') showPick(); }, { passive: true, capture: true });
  content.addEventListener('click', e => {
    if (mode !== 'element' || fromUI(e)) return;
    const chain = pickChain(e.target); if (!chain.length) return;
    const el = chain[0] === pick.chain[0] ? chain[Math.min(pick.level, chain.length - 1)] : chain[0];
    e.preventDefault(); e.stopPropagation();
    suppressClick = Date.now();
    const r = el.getBoundingClientRect(), txt = normWS(el.textContent || '').trim(), name = blockName(el);
    setMode('select');
    startDraft({ anchor: { type: 'element', sel: selectorFor(el), tag: el.tagName.toLowerCase(), text: txt.slice(0, 120) },
      label: (/^(Table|Diagram|List|Figure|Image)$/.test(name) ? name + ': ' : '') + (txt.slice(0, 110) || name), target: el, box: document.createElement('az-box'), top: r.top + scrollY, bottom: r.bottom + scrollY });
  }, true);

  /* ===================== clicks, hover and keys on the page ===================== */
  content.addEventListener('mouseover', e => {
    const m = e.target.closest && e.target.closest('mark.az-hl'); if (!m || active) return;
    const t = threads[m.dataset.tid]; if (t && !t.resolved) applyMarkState(m.dataset.tid);
  });
  content.addEventListener('mouseout', e => { const m = e.target.closest && e.target.closest('mark.az-hl'); if (m && !active) applyMarkState(null); });
  let hoverBox = null;
  document.addEventListener('mousemove', e => {
    if (mode !== 'select' || drawing || fromUI(e)) return;
    const id = boxAt(e.clientX, e.clientY);
    if (id === hoverBox) return;
    hoverBox = id; HTML.style.cursor = id ? 'pointer' : '';
    if (!active) applyMarkState(id);
  }, { passive: true });
  document.addEventListener('click', e => {
    if (Date.now() - suppressClick < 400 || fromUI(e) || mode !== 'select') return;
    const s = document.getSelection(); if (s && !s.isCollapsed && s.toString().trim()) return;
    const m = e.target.closest && e.target.closest('mark.az-hl');
    const id = m ? m.dataset.tid : boxAt(e.clientX, e.clientY);
    if (id && id !== DRAFT && threads[id] && !threads[id].resolved) { draft = null; syncMarks(); activate(id, false); return; }
    if (draft) cancelDraft(); else if (active) deactivate();
  });
  document.addEventListener('keydown', e => {
    const t = e.composedPath()[0];
    if (e.key === 'Escape' && closeMenus()) return;
    if (t && (/^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;   // leave ⌘E, ⌘R, ⌘V to the browser
    if (mode === 'element' && pick.chain.length && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (e.key === 'ArrowUp' && pick.level < pick.chain.length - 1) pick.level++;
      if (e.key === 'ArrowDown' && pick.level > 0) pick.level--;
      e.preventDefault(); showPick(); return;
    }
    const k = e.key.toLowerCase();
    if (k === 'escape') { if (mode !== 'select') setMode('select'); else if (draft) cancelDraft(); else if (active) deactivate(); else if (panelOpen()) setPanel(false); return; }
    if (k === 'v') setMode('select'); else if (k === 'r') setMode('region'); else if (k === 'e') setMode('element');
  });

  /* ===================== toolbar, menus, panel ===================== */
  const MODES = [
    { id: 'select', label: 'Select text', sub: 'Comment on words', icon: I.cursor, key: 'V' },
    { id: 'region', label: 'Draw a box', sub: 'Over a diagram or anything', icon: I.box, key: 'R' },
    { id: 'element', label: 'Pick a block', sub: 'A node, cell or table · ↑ for bigger', icon: I.block, key: 'E' },
  ];
  function setMode(m) {
    mode = m;
    HTML.classList.toggle('az-mode-region', m === 'region');
    if (m !== 'element') { pickEl.classList.remove('show'); pick = { chain: [], level: 0 }; }
    const d = MODES.find(x => x.id === m);
    $('modeBtn').innerHTML = `${d.icon}${I.caret}`; $('modeBtn').title = `${d.label} (${d.key})`; $('modeBtn').setAttribute('aria-label', 'Mode: ' + d.label);
    if (m !== 'select') { selbar.classList.remove('show'); toast(m === 'region' ? 'Drag a box over anything' : 'Click a block · ↑ ↓ to pick bigger or smaller', 'Cancel', () => setMode('select')); }
  }
  let floating = null, onClose = null;
  function openMenu(btn, items, closed) {
    closeMenus();
    const m = document.createElement('div'); m.className = 'menu'; m.setAttribute('role', 'menu');
    if (!items.some(it => it && it.icon)) m.classList.add('noicons');
    m.innerHTML = items.map((it, i) => !it ? '<hr>' : it.head ? `<h5>${esc(it.head)}</h5>` : `<button role="menuitem" data-i="${i}" class="${it.sel ? 'sel' : ''} ${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}><span class="ic">${it.icon || ''}</span><span class="tx">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span><kbd>${it.key || ''}</kbd><span class="chk">${I.check}</span></button>`).join('');
    ui.appendChild(m);
    const r = btn.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth));
    const below = r.bottom + 6 + m.offsetHeight < innerHeight;
    Object.assign(m.style, { left: left + 'px', top: (below ? r.bottom + 6 : Math.max(8, r.top - 6 - m.offsetHeight)) + 'px', transformOrigin: below ? 'top right' : 'bottom right' });
    m.querySelectorAll('button').forEach(b => b.onclick = e => { e.stopPropagation(); const it = items[b.dataset.i]; closeMenus(); it.run && it.run(); });
    btn.setAttribute('aria-expanded', 'true');
    floating = { m, btn }; onClose = closed || null;
  }
  function closeMenus() {
    if (!floating) return false;
    floating.m.remove(); floating.btn.setAttribute('aria-expanded', 'false'); floating = null;
    if (onClose) { const f = onClose; onClose = null; f(); }
    return true;
  }
  document.addEventListener('mousedown', e => { if (floating && !e.composedPath().includes(floating.m) && !e.composedPath().includes(floating.btn)) closeMenus(); }, true);
  $('modeBtn').addEventListener('click', e => { e.stopPropagation(); if (floating && floating.btn === $('modeBtn')) { closeMenus(); return; } openMenu($('modeBtn'), MODES.map(x => ({ label: x.label, sub: x.sub, icon: x.icon, key: x.key, sel: x.id === mode, run: () => setMode(x.id) }))); });
  $('listBtn').addEventListener('click', () => setPanel(!panelOpen()));
  $('pclose').addEventListener('click', () => setPanel(false));
  $('filterBtn').addEventListener('click', e => { e.stopPropagation(); openMenu($('filterBtn'), ['open', 'resolved', 'all'].map(f => ({ label: f[0].toUpperCase() + f.slice(1), sel: filter === f, run: () => { filter = f; render(); } }))); });
  $('pmoreBtn').addEventListener('click', e => {
    e.stopPropagation();
    openMenu($('pmoreBtn'), [
      { label: 'Copy questions', sub: BRIDGE ? 'For a chat, as a paste-ready batch' : 'Paste into any Claude chat to get answers', icon: I.copy, run: copyQuestions },
      null,
      { label: BRIDGE ? 'Answers: automatic' : 'Answers: copy and paste', sub: BRIDGE ? 'Through the local helper · ' + modelLabel() : 'Open the doc through its launcher for automatic answers', disabled: true },
    ]);
  });

  /* ===================== copy questions (works without the bridge) ===================== */
  function baseName() { return decodeURIComponent(location.pathname.split('/').pop() || '').replace(/\.html?$/i, '') || 'page'; }
  function threadsFileName() { return baseName() + '-threads.js'; }
  function copyQuestions() {
    const batch = Object.entries(threads).filter(([, t]) => !t.resolved && pendingQuestions(t).length)
      .map(([id, t]) => ({ id, label: t.label, anchor: t.anchor, questions: pendingQuestions(t) }));
    if (!batch.length) { toast('No unanswered questions'); return; }
    const file = threadsFileName();
    const fullPath = location.protocol === 'file:' ? decodeURIComponent(location.pathname).replace(/[^/]+$/, file) : file + '  (sibling of this HTML file; page served from ' + location.href + ')';
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

When done, the reader reloads the page and the answers appear in the comment cards.

Shape to write per id:
  "<id>": { "label":"…", "anchor":{…}, "messages":[
      {"role":"user","text":"…"}, {"role":"claude","text":"…"} ] }

Questions to answer (${batch.length}):
${JSON.stringify(batch, null, 2)}`;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => toast('Copied ' + batch.length + ' question' + (batch.length > 1 ? 's' : '') + '. Paste into any Claude chat.'), () => {
        const ta = document.createElement('textarea'); ta.className = 'pastebox'; ta.value = text; ui.appendChild(ta); ta.select();
        ta.addEventListener('blur', () => ta.remove()); toast('Select all and copy, then click away');
      });
  }

  /* ===================== model choice ===================== */
  function modelInfo(c) { const b = MODELS && c && MODELS[c.backend]; return b && b.models.find(m => m.id === c.model); }
  function validChoice(c) { if (!MODELS || !c) return false; const b = MODELS[c.backend]; return !!(b && b.available && b.models.some(m => m.id === c.model)); }
  function defaultChoice() {
    if (!MODELS) return null;
    if (MODELS.claude && MODELS.claude.available) return { backend: 'claude', model: MODELS.claude.default };
    if (MODELS.codex && MODELS.codex.available) return { backend: 'codex', model: MODELS.codex.default, effort: MODELS.codex.defaultEffort };
    return null;
  }
  function modelLabel(c) { c = c || choice; const m = modelInfo(c); if (!m) return 'Claude'; return (c.backend === 'codex' ? 'Codex · ' : 'Claude · ') + m.label + (c.backend === 'codex' && c.effort ? ' (' + c.effort + ')' : ''); }
  function modelShort() { const m = modelInfo(choice); return m ? m.label + (choice.backend === 'codex' && choice.effort ? ' · ' + choice.effort : '') : 'Model'; }
  function openModelMenu(btn) {
    if (!MODELS) return;
    const items = [];
    for (const be of ['claude', 'codex']) {
      const b = MODELS[be]; if (!b) continue;
      items.push({ head: (be === 'claude' ? 'Claude' : 'Codex') + (b.available ? '' : ' · ' + (b.reason || 'unavailable')) });
      b.models.forEach(m => items.push({ label: m.label, sel: !!choice && choice.backend === be && choice.model === m.id, disabled: !b.available, run: () => {
        choice = { backend: be, model: m.id };
        if (be === 'codex') choice.effort = (m.efforts || []).includes(MODELS.codex.defaultEffort) ? MODELS.codex.defaultEffort : (m.efforts || [])[0];
        writeLS(CHOICEKEY, choice); primedFor = null; prime();
        root.querySelectorAll('.model').forEach(x => x.innerHTML = `${esc(modelShort())} ${I.caret}`);
      } }));
      const cur = be === 'codex' && choice && choice.backend === 'codex' && modelInfo(choice);
      if (cur && cur.efforts && cur.efforts.length) {
        items.push({ head: 'Effort' });
        cur.efforts.forEach(ef => items.push({ label: ef, sel: choice.effort === ef, run: () => { choice.effort = ef; writeLS(CHOICEKEY, choice); root.querySelectorAll('.model').forEach(x => x.innerHTML = `${esc(modelShort())} ${I.caret}`); } }));
      }
    }
    openMenu(btn, items);
  }

  /* ===================== auto-answer bridge (optional) ===================== */
  function shotUrl(id) { return '/.annot-snaps/' + encodeURIComponent(baseName()) + '/' + id + '.png'; }
  function ensureShot(id) {
    const t = threads[id];
    if (!BRIDGE || !t || t.type !== 'region' || shots[id]) return;
    shots[id] = 'probe';
    const done = v => { shots[id] = v; const el = panelEls.get(id); if (el) el._h = null; renderPanel(); };
    const img = new Image();
    img.onload = () => done('ok');
    img.onerror = () => {
      done('wait');
      fetch('/__annot/snap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: baseName(), id, anchor: t.anchor, view: viewSize() }) })
        .then(r => r.json()).then(j => done(j && j.ok ? 'ok' : 'none'), () => done('none'));
    };
    img.src = shotUrl(id);
  }
  let primedFor = null;
  function prime() {   // warm the doc's session when the reader starts commenting, not on every page view
    if (!BRIDGE || !choice) return;
    const key = choice.backend + '|' + choice.model; if (primedFor === key) return; primedFor = key;
    fetch('/__annot/prime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: baseName(), backend: choice.backend, model: choice.model, effort: choice.effort }) }).catch(() => {});
  }
  async function askBridge(id) {
    const t = threads[id]; if (!t || answering[id]) return;
    const questions = pendingQuestions(t); if (!questions.length) return;
    const by = modelLabel();
    answering[id] = { text: '', by }; render();
    let final = null, raf = 0;
    const paint = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
    try {
      const res = await fetch('/__annot/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: baseName(), id, label: t.label, anchor: t.anchor, view: viewSize(), questions, backend: choice && choice.backend, model: choice && choice.model, effort: choice && choice.effort, by, stream: true }) });
      if (!res.ok || !res.body) throw new Error('bridge returned ' + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
          if (ev.t === 'delta' && answering[id]) { answering[id].text += ev.text; paint(); }
          else if (ev.t === 'reset' && answering[id]) { answering[id].text = ''; paint(); }
          else if (ev.t === 'done') final = ev;
        }
      }
      if (!final || !final.ok) throw new Error((final && final.error) || 'no answer');
      if (threads[id] && final.entry) { mergeThread(id, final.entry); persist(); }
      if (final.warning) toast(final.warning);
    } catch (e) {
      toast('Answer failed: ' + String(e.message || e).slice(0, 100), 'Retry', () => askBridge(id));
    }
    delete answering[id];
    render();
    if (final && final.ok && threads[id] && pendingQuestions(threads[id]).length) askBridge(id);   // a follow-up typed meanwhile
  }
  async function detectBridge() {
    if (location.protocol === 'file:') return;
    try { const r = await fetch('/__annot/ping', { cache: 'no-store' }); BRIDGE = r.ok && !!(await r.json()).ok; } catch (e) { return; }
    if (!BRIDGE) return;
    try { const r = await fetch('/__annot/models', { cache: 'no-store' }); if (r.ok) MODELS = await r.json(); } catch (e) {}
    if (MODELS && !validChoice(choice)) { choice = defaultChoice(); if (choice) writeLS(CHOICEKEY, choice); }
  }

  /* ===================== boot ===================== */
  let relayout = 0;
  function scheduleLayout(full) {
    cancelAnimationFrame(relayout);
    relayout = requestAnimationFrame(() => { if (full) measureRoom(); render(); });
  }
  addEventListener('resize', () => scheduleLayout(true));
  addEventListener('scroll', () => { requestAnimationFrame(() => pin(true)); }, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(() => scheduleLayout(false)).observe(content);
  // diagrams (Mermaid etc.) render after load: re-anchor when an <svg> appears in the content
  new MutationObserver(ms => {
    if (ms.some(m => [...m.addedNodes].some(n => n.nodeType === 1 && (n.tagName.toLowerCase() === 'svg' || (n.querySelector && n.querySelector('svg')))))) { setTimeout(() => { syncMarks(); scheduleLayout(true); }, 60); }
  }).observe(content, { childList: true, subtree: true });
  document.fonts && document.fonts.ready && document.fonts.ready.then(() => scheduleLayout(true));
  addEventListener('load', () => scheduleLayout(true));

  async function boot() {
    setMode('select');
    measureRoom(); syncMarks(); render();
    await detectBridge();
    refreshAll();
    const m = location.hash.match(/#az=(\w+)/);
    if (m && threads[m[1]]) activate(m[1], true);
    if (!BRIDGE && location.protocol === 'file:' && !readLS('annot::seen-copy', false)) { writeLS('annot::seen-copy', true); toast('Copy-paste mode: open this doc through its launcher for automatic answers'); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
