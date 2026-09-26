# annotatable-html

Turn any doc Claude writes you into a page you can talk back to. Highlight a sentence, box a diagram, or click a component, ask your question right on the spot, and the answer streams into the margin — pinned there for next time. Answers come from Claude or Codex, whichever you pick. No API key, no server, no accounts; it runs on the [Claude Code](https://claude.com/claude-code) subscription (or Codex login) you already have.

![status: macOS · Chromium browsers](https://img.shields.io/badge/status-macOS%20%C2%B7%20Chromium-blue)

You've hit this before: you ask Claude for a spec or an architecture write-up, get back a clean doc, and start reading — then the questions pile up. *Why base62 and not a UUID? What does "read-through cache" mean here? Is this number still right?* Today those questions go one of two places: into a separate chat where you re-paste the paragraph and re-explain what you meant, or nowhere at all. The doc can't answer, so it quietly becomes one more file you skimmed and never fully trusted.

This keeps the question on the doc. You mark the exact spot that tripped you up, type what you want to know, and the answer lands right next to it — and it's still there tomorrow. A dead export turns into something you interrogate until you actually understand it.

![annotatable-html in action](docs/hero.png)

*A generated architecture doc: a highlighted phrase, a region box dragged over the diagram, and a pin on the "KV store" node — each holds its own Q&A thread. Green ✓ pins are answered, amber ones are still open; the sidebar shows Claude's answer as rendered markdown.*

And it rides the flow you already use — there's no new app to open:

1. **Ask** Claude Code for a doc, spec, or notes, and say "make it annotatable" (or add it to any HTML page you already have).
2. **Read** it in your browser. When a question hits, mark the spot — a phrase, a slice of a diagram, or a whole element — and type it. No context switch, no re-explaining.
3. **Answer.** Answers arrive automatically through a local helper you start with one double-click — usually in 3–6 seconds, streaming in as they're written — or you paste one self-contained block into any chat. Pick the model from the toolbar: Claude (Fable, Opus, Sonnet, Haiku) or Codex (the models your Codex account offers).
4. **Keep.** Every question and answer is saved in a plain file beside the doc, so it grows into a reference you trust instead of a snapshot you forget.

Everything stays on your machine: draft questions live in the browser, answers in a `<doc>-threads.js` file you own. Nothing is uploaded.

## Install

```
/plugin marketplace add vendz/annotatable-html
/plugin install annotatable-html@vendz
```

That's it. It's opt-in: ask Claude Code to "make this annotatable", "add comment threads" or "let me comment on it", for a new doc or any existing HTML page.

## Requirements

- **Claude Code** (this is a Claude Code skill).
- **A Chromium browser** (Chrome/Edge/Arc/Brave) for the auto-answer launcher; any browser works for the copy-paste path.
- **Node.js** — only for the optional auto-answer helper (`annotate-bridge.js`). The page itself needs nothing.
- The auto-answer helper uses `claude -p` on your **subscription** (no API key). It unsets `ANTHROPIC_API_KEY` for the child so it never bills the API.
- **Codex CLI** (optional) — logged in, if you want Codex answers. The toolbar greys out whichever side isn't installed or logged in.

## How it works

1. Claude writes `<name>.html` (with the self-mounting `annotate.js` engine) into a shared folder, `~/annotated-docs/`, plus a `<name>-threads.js` answers file.
2. You annotate in the browser. Questions and half-typed drafts are saved locally.
3. **Answers:** either paste the exported batch into any Claude chat, *or* run the tiny local bridge (double-click launcher). The bridge serves the folder, asks Claude (`claude -p`) or Codex (`codex exec`), streams the answer to the page, and saves it into the answers file itself.
4. Pins turn green and answers appear inline, labelled with the model that wrote them.

Answers are written in plain English: short, direct, no jargon, and no file or function names unless you ask. The bridge warms up each doc when you turn on Annotate, keeps one session per thread so follow-ups stay fast, and can be linked to a project folder so answers check the real code.

The engine self-mounts its own toolbar and sidebar inside a shadow root, so your page's CSS can't restyle it and it can't restyle your page. It re-locates marks across reloads by text phrase (with surrounding text, so repeated phrases land in the right place), region fractions, or element selector.

## Manual install (without the plugin system)

Copy the skill folder into your skills directory:

```bash
git clone https://github.com/vendz/annotatable-html
cp -r annotatable-html/plugins/annotatable-html/skills/annotatable-html ~/.claude/skills/
```

## License

MIT © 2026 vendz
