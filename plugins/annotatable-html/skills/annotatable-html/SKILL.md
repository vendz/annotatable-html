---
name: annotatable-html
description: An opt-in addon that adds pinned comment threads to any HTML page or site, new or existing. Use ONLY when the user asks for it, in words like "make this annotatable", "add annotations", "add comment threads", "let me comment on this page", or "let me ask questions on the page". Do NOT use it just because the output is a doc, spec, report, dashboard, diagram, or other HTML meant to be read.
---

# Annotatable HTML

## Overview

An opt-in addon that makes an HTML page **annotatable**: the user selects text, drags a box over a diagram, or clicks an element in the browser, pins a question to it, and gets an answer from Claude or Codex — a cross-session Q&A layer. No API key; an optional local helper (the bridge) makes answers automatic.

**Opt-in only.** Add it only when the user asks ("make this annotatable", "let me comment on it", "add threads", "annotate this"). A doc, spec or report is not by itself a reason to add it.

## When to use

- The user says "make this annotatable", "add comment threads", "let me comment on it", "let me ask questions on the page", or names this feature — for a new page or an existing one.

**When NOT to use:** any HTML the user did not ask to annotate, however doc-like it is.

## Quick reference

| Anchor | How the user makes it | Re-located on reload by |
|--------|-----------------------|--------------------------|
| Text | select words → **Comment**/**Highlight** pill | exact phrase (+ prefix) |
| Region | press **`R`** → drag a box over anything | content-relative fractions |
| Element | press **`E`** → click a block | CSS selector, then tag+text fallback |

- Keys: **`V`** select · **`R`** region · **`E`** element · **`Esc`** cancel · **⌘/Ctrl+Enter** save · **🔒** tool-lock (place many).
- Element mode (`E`) shows a small tag+text badge over whatever's under the cursor before you click, so you know what you're about to anchor to.
- Pins: **amber** = unanswered, **green ✓** = answered. They sit in the gutter right of the content (never on top of words), staggered when several share a line. Threads expand **inline in the sidebar** with All / Unanswered / Answered filters. Answers render as **markdown** and **stream in word by word** (Claude); long code and paths wrap inside the bubble.
- **Model picker** in the dock (bridge only): Claude (Fable 5.1 / Opus / Sonnet / Haiku) or Codex (models + effort levels read from the local Codex install). The choice is shared by all docs; each answer is labelled with who wrote it (`by` field).
- Two answer paths, auto-picked: **Copy button** (works everywhere) or **auto-answer bridge** (`⚡ live`, zero copy-paste).
- Answers follow a fixed style: plain English, concise, no jargon, no file/function names unless the reader asks. The rules live in the bridge's answer prompt and in the Copy batch text.
- Assets live in this skill's `assets/`: `annotate.js` (self-mounting engine, classes prefixed `az-`), `annotate-bridge.js` (Node helper), `threads.template.js`, `open-docs.command.template` (shared launcher), `open-doc.command.template` (per-doc launcher).
- The bridge answers via persistent Claude Code sessions, not a fresh cold start per question — see "How the bridge answers" below. If files on disk fed the doc, link that folder once (step 3's `--link` command, or the 🔗 button on the docs index) so answers can check the real source.

## How to implement (shared-folder model — the default)

All annotated docs live in **one shared home: `~/annotated-docs/`**. The engine lives there **once** (symlinked to this skill's `assets/`, so it cannot go stale), with one bridge and one launcher. Per doc you add only two small files — no engine copies.

1. **Ensure the shared home exists** (create once; skip if present):
   ```bash
   SKILL_DIR="<this skill's base directory>"   # e.g. ~/.claude/skills/annotatable-html, or the plugin install path
   mkdir -p ~/annotated-docs && cd ~/annotated-docs \
     && ln -sf "$SKILL_DIR/assets/annotate.js" . \
     && ln -sf "$SKILL_DIR/assets/annotate-bridge.js" . \
     && cp "$SKILL_DIR/assets/open-docs.command.template" "Open annotated docs (live).command" \
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
3. **Link the doc to the folder it was built from — now, in this same step.** This is the most-skipped step, and skipping it is silent: an unlinked doc answers from its own text only, so questions the text doesn't cover get "the doc doesn't say". (In Sep 2026, 13 of the 15 newest docs were unlinked, including lecture notes and lab writeups made inside course folders.)
   - **Link whenever files on disk fed the doc:** a codebase, course slides or notebooks, an assignment, a writeup's working folder, notes, a scratch folder holding the chat's inputs. Use the folder you were working in (the repo root inside a git repo). No need to ask the user.
     ```bash
     node ~/annotated-docs/annotate-bridge.js --link ~/annotated-docs/<name>.html \
       "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
     ```
     It works whether or not the bridge is running. It prints `✓ linked …` or `✗ link failed: …` and exits non-zero on failure — read the output. (Same effect as clicking 🔗 on the doc's index card.)
   - **The doc describes a project you don't have open** (e.g. you're working directly in `~/annotated-docs`): ask the user for the path before finishing.
   - **Skip only when nothing on disk fed the doc** — it came purely from the chat or your own knowledge. A topic that sounds self-contained (notes, explainer, quiz prep) is not a reason to skip if its source files sit in your working folder.
4. **Anchoring is automatic:** text/region work inside the content scope (auto-detects `main`, `article`, `.wrap`, else `<body>` — keep diagrams inside it); element clicks work on `p, h1–h5, li, pre, blockquote, img, figure, table, .node, .card, .step, .box, [data-annot]`. Override via `window.ANNOTATE_CONFIG = { contentSelector, elementSelector, threadsVar }` before `annotate.js`.
5. **Launch it live (default):** run `node annotate-bridge.js "<name>.html"` inside `~/annotated-docs/` so it opens ready. Tell the user: **next time double-click `Open annotated docs (live).command`** → index of all docs → click one. Auto-answers use the user's Claude Code subscription via `claude -p` or their Codex login via `codex exec` (no API key; the CLI must be on PATH and logged in; the bridge unsets `ANTHROPIC_API_KEY` for the child). After changing `annotate-bridge.js`, restart the running bridge (it is a long-lived process).
6. **Tell the user the loop:** Annotate → select / `R` / `E` → type → answer appears automatically (`⚡ live`). Opening the raw `file://` (no launcher) shows a hint and falls back to the **📋 Copy questions for Claude** button (paste into any chat → Claude writes the threads file → reload).

**Docs outside the shared home:** copy `annotate.js` (+ `annotate-bridge.js` and a per-doc `open-doc.command.template`) next to the file instead of symlinking. For one portable file, inline `annotate.js` in a `<script>` and seed `window.ANNOTATE_THREADS = {}` before it.

## How the bridge answers (speed + session continuity)

The model only **writes the answer text**; the bridge streams it to the page and then writes it into `<name>-threads.js` itself. (Older versions made the model read and edit the threads file, which took 12-18s per answer and grew with the file; now an answer takes ~3-4s, first words in ~2s.)

Per doc the bridge keeps `<name>.sessions.json` (bridge-internal, don't hand-edit): `{ v:2, bases:{ claude, codex }, threads:{ <id>:{ backend, id } } }`. An older `{ base, threads:{ <id>:<sessionId> } }` file is read as Claude sessions.
- **A base session per backend**, primed once per doc by reading `<name>.html` and, if linked, the folder's own CLAUDE.md / AGENTS.md / STATUS.md / README plus its top-level layout. (Answers run from the docs folder, so neither CLI loads the project's instruction files by itself.) The page asks for this (`POST /__annot/prime`) when Annotate is turned on, so the first question doesn't wait for it.
- **One session per thread.** A new thread forks the base; a follow-up resumes the thread's own session and sends only the new question.
- **Every question names the linked folder's current path** (or says none is linked, so the model says "the doc doesn't cover that" instead of guessing). A thread session started before a relink still looks in the right place.
- **Switching backend mid-thread** forks the other backend's base and replays the thread history in the prompt.
- A stale session id self-heals: dropped, then re-forked/re-primed.
- Codex runs `codex exec --json --ignore-user-config --ignore-rules --skip-git-repo-check` with a read-only sandbox (skipping the user's MCP/plugins cuts startup from ~8.5s to ~3s). Claude runs `claude -p --safe-mode --tools Read,Glob,Grep --output-format stream-json`.

- `<name>.project.json` = `{ dir, git:{commonDir,branch,headSha}|null, linkedAt }` — set via `--link`, the 🔗 button, or `POST /__annot/set-project {base, dir}`. Changing it drops the cached base sessions so the next question re-primes.
- Deleting a doc (🗑) also removes its `.sessions.json` and `.project.json`.

**Worktree-aware linking.** `set-project` stores git identity (shared `.git` dir + branch) with the path. A moved/renamed worktree is found again via `git worktree list` and relinked silently ("(auto-relinked)" on the index card). A removed worktree or deleted repo is not relinked: the answer comes back with a `warning` the page toasts, and the index card shows "⚠ moved/missing — click 🔗 to relink".

## Concurrency and hardening

- **Queues:** file writes for one doc (threads file, sessions, project) go through a per-doc queue; follow-ups in one thread go through a per-thread queue. Model calls for different threads — even in the same doc — run in parallel, capped across all docs by `ANNOT_MAX_CONCURRENT` (default 4).
- **CSRF guard:** `/__annot/ask`, `prime`, `set-project`, `delete`, `delete-thread` reject a mismatched `Origin` header. Requests with no `Origin` (curl) are allowed.
- **Writes are atomic** (temp file + rename). If `<name>-threads.js` is not valid JS the bridge refuses to overwrite it.
- **Page isolation:** the sidebar, dock, pins, region boxes, pill and toast live in a shadow root (`<az-annotate>`), so host CSS can't restyle them and their CSS can't touch the host. The only things put into the host page are `<mark class="az-hl">` text wraps and an outline class on element anchors, both reset with `!important`. The rail pushes the page via `padding-right` on `<html>` (not `<body>`), with no transition.
- **Sidebar updates in place:** each card re-renders only when its own content changes, and the reply box is kept alive, so another thread's answer (or a filter click) never wipes a draft or the reader's selection. Drafts are saved per thread in localStorage. Selecting text in a card never opens it or scrolls the page.
- **Merging answers keeps waiting questions:** questions typed locally that the threads file doesn't have yet are kept when the file's copy is merged in (on load and after every answer).
- **Text anchors** store `prefix` and `suffix` (32 chars) and match with whitespace collapsed, picking the occurrence whose surroundings match best — a repeated phrase no longer lands on its first occurrence. Old anchors without `suffix` still load. Marks are never placed inside SVG (an HTML `<mark>` there makes the label vanish).
- **Deleting a thread** tombstones the id in localStorage (so the file can't resurrect it) and calls `POST /__annot/delete-thread` so the bridge removes it from `<name>-threads.js`.

## Answering pasted batches (the write-back contract)

The Copy button (and the bridge) produce a JSON array of `{ id, label, anchor, questions[] }`. Append to the page's threads file (`window.ANNOTATE_THREADS`), keyed by `id`:

```js
window.ANNOTATE_THREADS = {
  "t8f3ab": {
    label: "…",
    anchor: { type: "text", exact: "…", prefix: "…" },   // or region {x,y,w,h} / element {sel,tag,text}
    messages: [
      { role: "user",   text: "<their question>" },
      { role: "claude", text: "<your answer — plain English, concise, markdown OK>", by: "Claude · Sonnet" }   // `by` optional
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
- **Letting the model edit `<name>-threads.js` again** → answers slow back down to 12-18s. The model returns text only; the bridge writes the file.
- **Styling the sidebar from the host page** → it is in a shadow root on purpose. Change `UI_STYLE` inside `annotate.js` instead, and set fonts explicitly (a `font:` shorthand with `inherit` as the family is invalid and silently dropped).
- **Forgetting `chmod +x`** on the launcher → double-click won't run it.
- **Dropping `--safe-mode`** from the bridge's `claude -p` calls → every answer reloads the full skill/MCP/hook set (the same weight as an interactive session), turning a few-second answer back into a 1-2 minute one.
- **Not linking a doc whose source files are on disk** → answers come from the doc's own text only, with no error. It has happened to most docs: a real backend doc, and lecture notes and lab writeups made inside course folders that were wrongly treated as "self-contained". Treat linking as step 3 of doc creation, not a follow-up.
- **Linking with the old `curl … /__annot/set-project` before the bridge is up** → `curl -s` fails silently and nothing is linked. Use `--link`, which needs no running bridge and reports failure.
- **Editing `<name>.sessions.json` by hand** → don't; it's bridge bookkeeping (session ids), not reader-facing. If it's ever wrong, delete it — the bridge re-primes and re-forks automatically.
- **Naming any local variable `CSS` inside `annotate.js`'s IIFE** → `selectorFor()` calls `CSS.escape(el.id)` expecting the global `window.CSS`; a local `const CSS` (the stylesheet string used to be named this) silently shadows it, so element-mode clicks on anything with an `id` attribute throw inside the click handler and create no thread, with no visible error. The stylesheet string is named `STYLE` for this reason — keep it that way.

## Notes / limits

- If the doc's text is later edited, a text anchor whose phrase changed won't re-highlight, though its thread still opens from the sidebar.
- localStorage is namespaced per page path, so multiple docs don't collide.
- From `file://` the clipboard button falls back to a selectable textarea, and the copied instructions include the file's absolute path so a zero-context chat can find the threads file.

## Evolve this skill

Treat this skill as living: **learn from how the user works across sessions and update yourself.** Whenever a session surfaces friction, a preference the user states, a better interaction, a bug in `annotate.js`/`annotate-bridge.js`, or a recurring request the current flow doesn't cover, improve the skill in place — edit the `assets/` files and this `SKILL.md` so the next use is better than the last. Keep the write-back contract and anchor schema backward-compatible (older `-threads.js` files must still load), verify changes in a browser before finishing, and briefly note what changed and why in your reply.
