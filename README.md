# MultiAI

One CLI shell that drives **Claude Code** and **Codex** side by side. Auth is
delegated entirely to the official CLIs — you log in once with each tool, and
MultiAI just orchestrates them.

## How auth works

MultiAI never touches your tokens. It shells out to the official binaries in
headless mode:

- `claude -p <prompt> --output-format json` (Claude Code)
- `codex exec <prompt> -o <file>` (Codex)

So you authenticate the normal way, once, using either a subscription login or
an API key:

```bash
claude          # log in (Claude Pro/Max OAuth, or set ANTHROPIC_API_KEY)
codex           # log in (ChatGPT OAuth, or set OPENAI_API_KEY)
```

Whatever each tool is authorized to use, MultiAI reuses. Nothing to configure.

## Requirements

- Node.js >= 23.6 (runs TypeScript directly via type stripping — no build step)
- `claude` and `codex` on your `PATH`, both logged in

## Run

```bash
# interactive shell
node src/cli.ts

# or install a global `multiai` command
npm link
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
| `/memory on\|off`        | toggle sending prior turns as context (default: on)  |
| `/reset`                 | clear the conversation history                       |
| `/history`               | show how many turns are remembered                   |
| `/status`                | show current target, models & memory                 |
| `/help`                  | show help                                            |
| `/exit`                  | quit (or Ctrl-D)                                     |

## Conversation memory

Memory is **on by default**. MultiAI keeps a transcript of the session and
prepends it to each new message, so the models remember earlier turns. Each
backend sees every user turn but only its *own* prior replies, so it stays
self-consistent — even in `both` mode where Claude and Codex answer in parallel.
Turn it off with `/memory off` for one-off questions, or `/reset` to start fresh.

## Architecture

```
src/
  backends.ts   # spawn the official CLIs headless, normalize their output
  modes.ts      # both() and judge() orchestration
  cli.ts        # arg parsing + interactive REPL
```

## Known limitations (MVP)

- Memory is a client-side transcript replayed each turn, so long sessions grow
  the prompt. (A future option: switch to `claude --resume` / `codex exec
  resume` for native, server-side session continuity.)
- Output is captured whole, not streamed token-by-token.
- `/both` and `/judge` run to completion before printing.
