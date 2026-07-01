# MultiAI

One CLI shell that drives **Claude Code** and **Codex** side by side. Auth is
delegated entirely to the official CLIs — you log in once with each tool, and
MultiAI just orchestrates them.

## How auth works

MultiAI never touches your tokens. It shells out to the official binaries in
headless mode:

- `claude -p <prompt> --output-format stream-json` (Claude Code)
- `codex exec <prompt> --json` (Codex)

So you authenticate the normal way, once, using either a subscription login or
an API key:

```bash
claude          # log in (Claude Pro/Max OAuth, or set ANTHROPIC_API_KEY)
codex           # log in (ChatGPT OAuth, or set OPENAI_API_KEY)
```

Whatever each tool is authorized to use, MultiAI reuses. Nothing to configure.

## Requirements

- `claude` and `codex` on your `PATH`, both logged in
- Node.js >= 20 to run the installed CLI (>= 23.6 to run the `.ts` sources
  directly without building)

## Install / run

```bash
# run without installing (builds on first use)
npx github:Freedom202601/MultiAI

# from source: interactive shell, no build step (needs Node >= 23.6)
node src/cli.ts

# or install a global `multiai` command from source
npm install && npm run build && npm link
multiai
```

## One-shot usage

```bash
multiai claude "explain this regex: ^\d{3}-\d{4}$"
multiai codex  "write a bash one-liner to dedupe lines"
multiai both   "what's the fastest way to reverse a linked list?"
multiai judge  "is this SQL injection safe? SELECT * FROM u WHERE id=$1"
```

## Interactive commands

The **default target is `both`** — a bare message is sent to Claude and Codex
at once. Override the startup default with `MULTIAI_DEFAULT=claude|codex|both`.

| command                  | what it does                                         |
| ------------------------ | ---------------------------------------------------- |
| `<text>`                 | send to the active target (default: both)            |
| `/use claude\|codex\|both`| switch the active target                             |
| `/both <text>`           | ask both models, show answers side by side           |
| `/judge <text>`          | one model drafts; the other reviews & improves it    |
| `/model <name>`          | set model for the active backend (needs a single one)|
| `/model clear`           | reset the active backend's model to default          |
| `/memory on\|off`        | continue the session vs. one-off turns (default: on) |
| `/reset`                 | start a fresh session (forget the conversation)      |
| `/history`               | show each backend's session status                   |
| `/status`                | show target, models, memory & sessions               |
| `/help`                  | show help                                            |
| `/exit`                  | quit (or Ctrl-D)                                     |

## Streaming & memory

- **Streaming:** Claude streams its answer token-by-token, and its tool calls
  show up live as dim `⚙ Read(file)` / `⚙ WebSearch(query)` / `⚙ Task(…)` lines
  so you can see it working during a long agentic run — not just a spinner. In
  `both` mode Codex runs in the background while Claude streams, then its answer
  is shown when ready (Codex returns whole — its `--json` mode emits no token
  deltas in the current version). Spinners show elapsed seconds. `/judge` runs to
  completion before printing.
- **Memory (on by default):** MultiAI uses each tool's *native* session — it
  stores the `session_id` / `thread_id` returned by a call and passes it back
  via `claude --resume` / `codex exec resume` on the next turn. Each backend
  keeps its own thread, so `both` mode continues two parallel conversations
  correctly, and long sessions don't re-send a growing transcript. `/memory off`
  makes turns one-off; `/reset` forgets everything.

## Architecture

```
src/
  backends.ts   # spawn the official CLIs headless; stream + capture session ids
  modes.ts      # both() and judge() orchestration
  cli.ts        # arg parsing + interactive REPL
```

## Publishing to npm

The package builds `dist/` from `src/` via `tsc` (the `prepare` script), so
`npm publish` ships compiled JS while the repo keeps only TypeScript. To publish
under your own account, set `name` in `package.json` (the unscoped `multiai` is
taken; this repo uses `multiai-cli`) and run `npm publish`.
