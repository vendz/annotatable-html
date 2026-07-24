---
name: annotatable-html
description: Use when the user asks for documentation, a spec, an architecture write-up, an explainer, a report, notes, a dashboard, a diagram, or any HTML meant to be read or reviewed for their own reference — or says "make this annotatable", "let me ask questions on the page", or "add comment threads". Skip only for HTML not meant to be read (e.g. a pure test fixture) or if the user opts out.
---

# Annotatable HTML

## Overview

Read-oriented HTML deliverables should be **annotatable**: the user selects text, drags a box over a diagram, or clicks an element in the browser, pins a question to it, and Claude answers — a no-backend, cross-session Q&A layer. No API, no server (an optional local helper enables fully automatic answers).

**Default ON.** When a request produces an HTML file to be read/reviewed/discussed — especially docs, specs, architecture, reports, or reference pages the user builds for themselves — wire this in without being asked. If unsure whether an HTML qualifies, it does.

## When to use

- The user asks for a doc, spec, architecture write-up, explainer, report, notes, dashboard, or diagram as HTML for their own reference.
- The user says "make this annotatable", "add comment threads", "let me ask questions on the page", or references this feature.
- Any standalone HTML meant to be **read/reviewed/discussed**.

**When NOT to use:** HTML that isn't meant to be read (a pure test fixture, a machine target), or when the user explicitly opts out.

## Quick reference

| Anchor | How the user makes it | Re-located on reload by |
|--------|-----------------------|--------------------------|
| Text | select words → **Comment**/**Highlight** pill | exact phrase (+ prefix) |
| Region | press **`R`** → drag a box over anything | content-relative fractions |
| Element | press **`E`** → click a block | CSS selector, then tag+text fallback |

- Keys: **`V`** select · **`R`** region · **`E`** element · **`Esc`** cancel · **⌘/Ctrl+Enter** save · **🔒** tool-lock (place many).
- Pins: **amber** = unanswered, **green ✓** = answered. Threads expand **inline in the sidebar** with All / Unanswered / Answered filters. Answers render as **markdown**.
- Two answer paths, auto-picked: **Copy button** (works everywhere) or **auto-answer bridge** (`⚡ live`, zero copy-paste).
- Assets live in this skill's `assets/`: `annotate.js` (self-mounting engine, classes prefixed `az-`), `annotate-bridge.js` (Node helper), `threads.template.js`, `open-docs.command.template` (shared launcher), `open-doc.command.template` (per-doc launcher).

## How to implement (shared-folder model — the default)

All annotated docs live in **one shared home: `~/.claude/annotated-docs/`**. The engine lives there **once** (symlinked to this skill's `assets/`, so it can't go stale), with one bridge and one launcher. Per doc you add only two small files — no engine copies.

1. **Ensure the shared home exists** (create once; skip if present):
   ```bash
   mkdir -p ~/.claude/annotated-docs && cd ~/.claude/annotated-docs \
     && ln -sf ../skills/annotatable-html/assets/annotate.js . \
     && ln -sf ../skills/annotatable-html/assets/annotate-bridge.js . \
     && cp ../skills/annotatable-html/assets/open-docs.command.template "Open annotated docs (live).command" \
     && chmod +x "Open annotated docs (live).command"
   ```
2. **Add the doc** — write two files into that folder:
   - `<name>.html` — **put the readable content inside a `<main>`** (or `<article>`, or an element with `class="wrap"`) so text/region anchoring has a scope; end the body with the two scripts (**threads file FIRST**):
     ```html
     <main>… your content …</main>
     <script src="<name>-threads.js"></script>
     <script src="annotate.js"></script>
     ```
   - `<name>-threads.js` — copy `assets/threads.template.js` to this name. Only the `window.ANNOTATE_THREADS = {}` line matters; keeping or trimming the header comment is fine.
   The bridge auto-lists every `<name>.html` on its index; no per-doc launcher needed.
3. **Anchoring is automatic:** text/region work inside the content scope (auto-detects `main`, `article`, `.wrap`, else `<body>` — keep diagrams inside it); element clicks work on `p, h1–h5, li, pre, blockquote, img, figure, table, .node, .card, .step, .box, [data-annot]`. Override via `window.ANNOTATE_CONFIG = { contentSelector, elementSelector, threadsVar }` before `annotate.js`.
4. **Launch it live (default):** run `node annotate-bridge.js "<name>.html"` inside `~/.claude/annotated-docs/` so it opens ready. Tell the user: **next time double-click `Open annotated docs (live).command`** → index of all docs → click one. Auto-answers use their Claude Code subscription via `claude -p` (no API key; `claude` must be on PATH and logged in; the bridge unsets `ANTHROPIC_API_KEY` for the child).
5. **Tell the user the loop:** Annotate → select / `R` / `E` → type → answer appears automatically (`⚡ live`). Opening the raw `file://` (no launcher) shows a hint and falls back to the **📋 Copy questions for Claude** button (paste into any chat → Claude writes the threads file → reload).

**Docs outside the shared home:** copy `annotate.js` (+ `annotate-bridge.js` and a per-doc `open-doc.command.template`) next to the file instead of symlinking. For one portable file, inline `annotate.js` in a `<script>` and seed `window.ANNOTATE_THREADS = {}` before it.

## Answering pasted batches (the write-back contract)

The Copy button (and the bridge) produce a JSON array of `{ id, label, anchor, questions[] }`. Append to the page's threads file (`window.ANNOTATE_THREADS`), keyed by `id`:

```js
window.ANNOTATE_THREADS = {
  "t8f3ab": {
    label: "…",
    anchor: { type: "text", exact: "…", prefix: "…" },   // or region {x,y,w,h} / element {sel,tag,text}
    messages: [
      { role: "user",   text: "<their question>" },
      { role: "claude", text: "<your answer — markdown OK: **bold**, lists, `code`, fences>" }
    ]
  }
};
```

- Copy `id`, `label`, and `anchor` **verbatim** — that's how the page re-locates the mark.
- **Append, don't replace** — a follow-up adds another user/claude pair to the same `id`'s `messages[]`.
- Plain file edit — never commit/push unless asked.

## Common mistakes

- **Copying the engine into each doc's folder** instead of using the shared symlinked home → duplication and stale copies (a fixed engine won't reach old docs). Use the shared home.
- **Opening the doc by double-clicking the `.html`** (`file://`) → no auto-answer. Use the launcher so it's served from `127.0.0.1`.
- **Putting `annotate.js` before the threads file** → answers won't load. Threads file goes **first**.
- **Editing `label`/`anchor` when answering** → the mark won't re-locate. Copy them exactly; only append to `messages[]`.
- **Using `--permission-mode acceptEdits` for the bridge's `claude -p`** → it still prompts and never writes. The bridge uses `bypassPermissions`; keep it.
- **Forgetting `chmod +x`** on the launcher → double-click won't run it.

## Notes / limits

- If the doc's text is later edited, a text anchor whose phrase changed won't re-highlight, though its thread still opens from the sidebar.
- localStorage is namespaced per page path, so multiple docs don't collide.
- From `file://` the clipboard button falls back to a selectable textarea, and the copied instructions include the file's absolute path so a zero-context chat can find the threads file.

## Evolve this skill

Treat this skill as living: **learn from how the user works across sessions and update yourself.** Whenever a session surfaces friction, a preference the user states, a better interaction, a bug in `annotate.js`/`annotate-bridge.js`, or a recurring request the current flow doesn't cover, improve the skill in place — edit the `assets/` files and this `SKILL.md` so the next use is better than the last. Keep the write-back contract and anchor schema backward-compatible (older `-threads.js` files must still load), verify changes in a browser before finishing, and briefly note what changed and why in your reply.
