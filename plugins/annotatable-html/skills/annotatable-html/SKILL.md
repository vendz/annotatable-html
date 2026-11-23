---
name: annotatable-html
description: An addon that adds pinned comment threads to any HTML page or site, new or existing. Use when the user asks for it, in words like "make this annotatable", "add annotations", "add comment threads", "let me comment on this page", or "let me ask questions on the page", or on every HTML page you make when the user's own instructions (CLAUDE.md, AGENTS.md) make it the default. Without either, do not add it just because the output is a doc, spec, report, dashboard, diagram, or other HTML meant to be read.
---

# Annotatable HTML

## Overview

An addon that makes an HTML page **annotatable**: the user selects words, draws a box over a diagram, or picks a block (a paragraph, a table, a node inside a Mermaid or SVG diagram), asks a question, and Claude or Codex answers in a card beside it: a cross-session Q&A layer. No API key; an optional local helper (the bridge) makes answers automatic.

Version 2.0 looks and moves like the comments in claude.ai docs: margin cards next to what they point at, a Comments panel, a flat amber highlight, no pins or dock.

**Opt-in, unless the user made it the default.** Add it when the user asks ("make this annotatable", "let me comment on it", "add threads", "annotate this"), or on every HTML page you make when their own instructions say it is the default. Otherwise a doc, spec or report is not by itself a reason to add it.

## When to use

- The user says "make this annotatable", "add comment threads", "let me comment on it", "let me ask questions on the page", or names this feature, for a new page or an existing one.
- The user's instructions make it the default: then add it to every new HTML page or site you make, without being asked.

**When NOT to use:** any HTML the user did not ask to annotate and whose instructions do not make it the default, however doc-like it is. Also not on pages published to claude.ai, because the local bridge cannot reach them.

## Quick reference

| Anchor | How the user makes it | Re-located on reload by |
|--------|-----------------------|--------------------------|
| Text | select words → one **Comment** button | exact phrase + 32 chars either side |
| Box (region) | **`R`** → drag a box over anything | the blocks it covers (edges saved relative to them), or its spot inside a sideways-scrolling figure/table, else content fractions; the bridge saves a picture of the box |
| Block (element) | **`E`** → click; **↑/↓** grow or shrink (cell → row → table, node → diagram) | selector, then tag + text; when the doc was rewritten, the block at the same position, and its card says the block's text has changed since the question was asked |

- **Keys:** `V` select text · `R` draw a box · `E` pick a block · `↑/↓` bigger/smaller block while picking · `Esc` cancel/close · `Enter` send · `Shift+Enter` new line. The same modes are in the toolbar's mode menu (top right).
- **Margin cards:** each open thread is a card in a column at the right edge, level with its anchor. The focused card slides 8px left, stays on screen while its anchor is on screen (cards below are pushed along, never overlapped), scrolls long threads inside itself with a **See more** pill, and shows a quiet **Reply…** field that grows and gets a focus ring when clicked. Resting cards are short faded previews. Cards are one element for their whole life, so they glide; nothing jumps or rebuilds.
- **New comment:** a lifted card with **Ask Claude…** and a model picker (bridge only). There is no @Claude tag and no "send to Claude" toggle: every comment goes to Claude.
- **Hover:** hovering a card lights its highlight (45% amber + 2px underline) and vice versa. Hovering the first message shows **Resolve** only (the check draws, fills, then the card slides out; a toast offers Undo). Resolved threads show **Reopen** and **Delete**. There is no per-thread "more" menu.
- **Comments panel** (count button, top right): every thread in page order, filter Open / Resolved / All, `⋯` → **Copy questions** (the paste-ready batch for any chat). Opening it pushes the page left by 320px. On windows too narrow for margin cards, threads open in the panel instead.
- **Answers:** stream in word by word, labelled with who wrote them ("Claude · Sonnet", "Codex · GPT-6-Luna · high") on one line. Markdown, tables, math (KaTeX) and highlighted code (highlight.js) render; both libraries load from jsDelivr only when an answer needs them.
- **The page never moves when comments come and go.** To make room for the card column the engine pushes the page with `padding-right` on `<html>`, computed from the window width only (a centred column moves half the push; a fluid page gets the whole column).
- **Theme** follows the doc's own background (light or dark), not the OS. Override with `ANNOTATE_CONFIG = { theme: 'light' | 'dark' }`.
- **Deep link:** focusing a thread sets `#az=<id>` in the URL; opening that link focuses the thread.
- Answer style: plain English, concise, no jargon, no file/function names unless the reader asks. The rules live in the bridge's answer prompt and in the Copy batch text.
- Assets live in this skill's `assets/`: `annotate.js` (self-mounting engine), `annotate-bridge.js` (Node helper), `threads.template.js`, `open-docs.command.template` (shared launcher), `open-doc.command.template` (per-doc launcher).

## How to implement (shared-folder model, the default)

All annotated docs live in **one shared home: `~/annotated-docs/`**. The engine lives there **once** (symlinked to this skill's `assets/`, so it cannot go stale), with one bridge and one launcher. Per doc you add only two small files, no engine copies.

1. **Ensure the shared home exists** (create once; skip if present):
   ```bash
   mkdir -p ~/annotated-docs && cd ~/annotated-docs \
     && ln -sf ~/.claude/skills/annotatable-html/assets/annotate.js . \
     && ln -sf ~/.claude/skills/annotatable-html/assets/annotate-bridge.js . \
     && cp ~/.claude/skills/annotatable-html/assets/open-docs.command.template "Open annotated docs (live).command" \
     && chmod +x "Open annotated docs (live).command"
   ```
2. **Add the doc**: write two files into that folder:
   - `<name>.html`: **put the readable content inside a `<main>`** (or `<article>`, or an element with `class="wrap"`) so anchoring has a scope; end the body with the two scripts (**threads file FIRST**):
     ```html
     <main>… your content …</main>
     <script src="<name>-threads.js"></script>
     <script src="annotate.js"></script>
     ```
     Wide tables and diagrams: wrap them in an element with `overflow-x:auto` so they scroll sideways; boxes drawn on them then scroll with them. For Mermaid, render with `flowchart: { useMaxWidth: false }` and don't put the diagram in a flex container that can shrink it; a squeezed diagram has unreadable labels.
   - `<name>-threads.js`: copy `assets/threads.template.js` to this name. Only the `window.ANNOTATE_THREADS = {}` line matters.
   The bridge auto-lists every `<name>.html` on its index; no per-doc launcher needed.
3. **Link the doc to the folder it was built from, now, in this same step.** This is the most-skipped step, and skipping it is silent: an unlinked doc answers from its own text only, so questions the text doesn't cover get "the doc doesn't say".
   - **Link whenever files on disk fed the doc:** a codebase, course slides or notebooks, an assignment, a writeup's working folder, notes, a scratch folder holding the chat's inputs. Use the folder you were working in (the repo root inside a git repo). No need to ask the user.
     ```bash
     node ~/annotated-docs/annotate-bridge.js --link ~/annotated-docs/<name>.html \
       "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
     ```
     It works whether or not the bridge is running. It prints `✓ linked …` or `✗ link failed: …` and exits non-zero on failure. Read the output.
   - **The doc describes a project you don't have open** (e.g. you're working directly in `~/annotated-docs`): ask the user for the path before finishing.
   - **Skip only when nothing on disk fed the doc**: it came purely from the chat or your own knowledge.
4. **Anchoring is automatic:** the content scope is `main`, `article`, `.wrap`, else `<body>`. Picking works on paragraphs, headings, list items, table cells/rows/tables, figures, images, `[data-annot]`, `.node/.card/.step/.box`, and nodes inside SVG diagrams (Mermaid `g.node`, or the smallest group holding a shape and its label). Override via `window.ANNOTATE_CONFIG = { contentSelector, threadsVar, theme }` before `annotate.js`.
5. **Launch it live (default):** run `node annotate-bridge.js "<name>.html"` inside `~/annotated-docs/` so it opens ready. Tell the user: **next time double-click `Open annotated docs (live).command`** → index of all docs → click one. Auto-answers use the user's Claude Code subscription via `claude -p` or their Codex login via `codex exec` (no API key; the CLI must be on PATH and logged in; the bridge unsets `ANTHROPIC_API_KEY` for the child). After changing `annotate-bridge.js`, restart the running bridge (it is a long-lived process).
6. **Tell the user the loop:** select words → **Comment**, or `R` to box something, `E` to pick a block → type → the answer streams into the card. Opening the raw `file://` (no launcher) is copy-paste mode: questions are saved, the card says how to get an answer, and the Comments panel's `⋯` → **Copy questions** gives a block to paste into any chat (Claude writes the threads file → reload).

**Docs outside the shared home:** copy `annotate.js` (+ `annotate-bridge.js` and a per-doc `open-doc.command.template`) next to the file instead of symlinking. For one portable file, inline `annotate.js` in a `<script>` and seed `window.ANNOTATE_THREADS = {}` before it.

## How the bridge answers (speed + session continuity)

The model only **writes the answer text**; the bridge streams it to the page and then writes it into `<name>-threads.js` itself (~3–4s per answer, first words in ~1–2s).

Per doc the bridge keeps `<name>.sessions.json` (bridge-internal, don't hand-edit): `{ v:2, bases:{ claude, codex }, threads:{ <id>:{ backend, id } } }`.
- **A base session per backend**, primed once per doc by reading `<name>.html` and, if linked, the folder's own CLAUDE.md / AGENTS.md / STATUS.md / README plus its top-level layout. The page asks for this (`POST /__annot/prime`) when the reader starts a comment or opens the panel, not on every page view.
- **One session per thread.** A new thread forks the base; a follow-up resumes the thread's own session and sends only the new question.
- **Every question names the linked folder's current path** (or says none is linked).
- **Switching backend mid-thread** forks the other backend's base and replays the thread history in the prompt.
- A stale session id self-heals: dropped, then re-forked/re-primed.
- **Boxes are sent as a picture.** The bridge opens the doc in a hidden Chrome (`?az-snap`, the engine stays off), lays it out at the same window size and page push, and (for a box drawn on a sideways-scrolling figure or table) scrolls that block to where it was (`&scroll=i:left`, from the anchor's `scroll` field). It saves `.annot-snaps/<name>/<id>.png`; the Comments panel shows it as the thread's quote, and the model gets the same file. Browser lookup: `ANNOT_CHROME` (if set, the only choice; `off` disables pictures), then Chrome / Chromium / Edge / Brave, then Playwright's Chromium cache. No browser → the question goes out with the label only.
- Codex runs `codex exec --json --ignore-user-config --ignore-rules --skip-git-repo-check` with a read-only sandbox. Claude runs `claude -p --safe-mode --tools Read,Glob,Grep --output-format stream-json`.

- `<name>.project.json` = `{ dir, git:{commonDir,branch,headSha}|null, linkedAt }`, set via `--link`, the 🔗 button on the docs index, or `POST /__annot/set-project {base, dir}`. Changing it drops the cached base sessions so the next question re-primes.
- Deleting a doc (🗑 on the index) also removes its `.sessions.json`, `.project.json` and pictures; deleting a resolved thread removes it from the threads file and its picture.

**Worktree-aware linking.** `set-project` stores git identity (shared `.git` dir + branch) with the path. A moved/renamed worktree is found again via `git worktree list` and relinked silently. A removed worktree or deleted repo is not relinked: the answer comes back with a `warning` the page toasts, and the index card shows "⚠ moved/missing: … Click 🔗 to relink".

## Concurrency and hardening

- **Queues:** file writes for one doc go through a per-doc queue; follow-ups in one thread go through a per-thread queue. Model calls for different threads run in parallel, capped across all docs by `ANNOT_MAX_CONCURRENT` (default 4).
- **CSRF guard:** `/__annot/ask`, `prime`, `snap`, `set-project`, `delete`, `delete-thread` reject a mismatched `Origin` header. Requests with no `Origin` (curl) are allowed.
- **Writes are atomic** (temp file + rename). If `<name>-threads.js` is not valid JS the bridge refuses to overwrite it.
- **Page isolation:** the toolbar, cards, panel, menus and toast live in a shadow root (`<az-annotate>`). The host page gets only `<mark class="az-hl">` text wraps, `<az-box>` outlines for boxes and picked blocks (inside the scrolling block they belong to, `pointer-events:none` so scrolling over them works; clicks and hover find them by position), `padding-right` on `<html>`, and `position:relative` on a sideways-scrolling block that hosts a box, all with `!important` resets.
- **Cards update in place:** one element per thread, re-rendered only when its content changes; the reply box survives other threads' answers streaming in. Reply drafts are saved per thread in localStorage. A ResizeObserver re-spaces the column when a card grows (reply box opening, an answer arriving).
- **Merging answers keeps waiting questions** and local details (message times, resolved state).
- **Text anchors** store `prefix` and `suffix` and match with whitespace collapsed, picking the best-matching occurrence. Offsets are counted in the same text the index walks, which skips `<style>`/`<script>`. Mermaid SVGs carry a `<style>` block, and counting it shifted every selection below a diagram (selections came out empty).
- **Diagrams rendered after load** (Mermaid etc.): a MutationObserver re-anchors when an `<svg>` appears in the content.
- **Deleting a thread** tombstones the id in localStorage (so the file can't resurrect it) and calls `POST /__annot/delete-thread`.

## Answering pasted batches (the write-back contract)

The Copy button (and the bridge) produce a JSON array of `{ id, label, anchor, questions[] }`. Append to the page's threads file (`window.ANNOTATE_THREADS`), keyed by `id`:

```js
window.ANNOTATE_THREADS = {
  "t8f3ab": {
    label: "…",
    anchor: { type: "text", exact: "…", prefix: "…", suffix: "…" },   // or region {x,y,w,h,cw,ch,vw,vh,pad,els?,f?,m?,scroll?} / element {sel,tag,text}
    messages: [
      { role: "user",   text: "<their question>" },
      { role: "claude", text: "<your answer: plain English, concise, markdown OK>", by: "Claude · Sonnet" }   // `by` optional
    ]
  }
};
```

- Copy `id`, `label`, and `anchor` **verbatim**. That's how the page re-locates the mark.
- **Append, don't replace**: a follow-up adds another user/claude pair to the same `id`'s `messages[]`.
- Plain file edit. Never commit/push unless asked.
- Threads files from 1.x load unchanged in 2.0.

## Common mistakes

- **Copying the engine into each doc's folder** instead of using the shared symlinked home → stale copies. Use the shared home.
- **Opening the doc by double-clicking the `.html`** (`file://`) → copy-paste mode, no auto-answer. Use the launcher so it's served from `127.0.0.1`.
- **Putting `annotate.js` before the threads file** → answers won't load. Threads file goes **first**.
- **Editing `label`/`anchor` when answering** → the mark won't re-locate. Copy them exactly; only append to `messages[]`.
- **Letting the model edit `<name>-threads.js`** in the bridge path → answers slow back down to 12–18s. The model returns text only; the bridge writes the file.
- **Styling the cards from the host page** → they are in a shadow root on purpose. Change `UI_STYLE` inside `annotate.js`, and set fonts explicitly (a `font:` shorthand with `inherit` as the family is invalid and silently dropped).
- **Re-adding a doc-moving layout** (shifting the content only once a card exists) → the first comment shoves the page. The push depends on window width only.
- **Rebuilding cards with `innerHTML` on every update** → cards jump instead of gliding and drafts get wiped. Keep one element per thread.
- **Counting text offsets with `Range.toString()`** → includes `<style>` text (Mermaid) and breaks every selection below a diagram. Count in the text index.
- **Forgetting `chmod +x`** on the launcher → double-click won't run it.
- **Dropping `--safe-mode`** from the bridge's `claude -p` calls → every answer reloads the full skill/MCP/hook set and takes minutes.
- **Not linking a doc whose source files are on disk** → answers come from the doc's own text only, with no error. Treat linking as step 3 of doc creation.
- **Editing `<name>.sessions.json` by hand** → don't; delete it if it's ever wrong.
- **Naming any local variable `CSS` inside `annotate.js`'s IIFE** → `selectorFor()` calls `CSS.escape()` expecting the global; a local `const CSS` silently shadows it and picking a block with an `id` throws. The stylesheet strings are named `UI_STYLE` / `pageStyle` for this reason.

## Notes / limits

- If the doc's text is later edited, a text anchor whose phrase changed won't re-highlight, though its thread still shows in the Comments panel.
- localStorage is namespaced per page path, so multiple docs don't collide. Resolved state and message times are local to the browser.
- From `file://` the clipboard button falls back to a selectable textarea, and the copied instructions include the file's absolute path so a zero-context chat can find the threads file.

## Evolve this skill

Treat this skill as living: **learn from how the user works across sessions and update yourself.** Whenever a session surfaces friction, a preference the user states, a better interaction, a bug in `annotate.js`/`annotate-bridge.js`, or a recurring request the current flow doesn't cover, improve the skill in place: edit the `assets/` files and this `SKILL.md` so the next use is better than the last. Keep the write-back contract and anchor schema backward-compatible (older `-threads.js` files must still load), verify changes in a browser before finishing, and briefly note what changed and why in your reply.
