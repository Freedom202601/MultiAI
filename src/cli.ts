#!/usr/bin/env node
// MultiAI — a unified CLI shell that drives Claude Code and Codex side by side.
// Auth is delegated entirely to the official `claude` and `codex` CLIs.

import readline from "node:readline";
import { run, type Backend, type RunResult, type RunOptions } from "./backends.ts";
import { judge } from "./modes.ts";

// --- tiny ANSI helpers (no dependencies) -----------------------------------
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};
const badge = (b: Backend) =>
  b === "claude"
    ? `${C.magenta}${C.bold}claude${C.reset}`
    : `${C.cyan}${C.bold}codex${C.reset}`;

function spinner(label: string): () => void {
  if (!process.stderr.isTTY) return () => {};
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => {
    process.stderr.write(`\r${C.dim}${frames[i++ % frames.length]} ${label}${C.reset}\x1b[K`);
  }, 80);
  return () => {
    clearInterval(t);
    process.stderr.write("\r\x1b[K");
  };
}

function printResult(r: RunResult) {
  const meta = `${C.dim}(${(r.ms / 1000).toFixed(1)}s${
    r.costUsd !== undefined ? `, $${r.costUsd.toFixed(4)}` : ""
  })${C.reset}`;
  if (!r.ok) {
    console.log(`\n${badge(r.backend)} ${C.red}✗ error${C.reset} ${meta}\n${C.red}${r.error}${C.reset}`);
    return;
  }
  console.log(`\n${badge(r.backend)} ${meta}\n${r.text}`);
}

// --- session state ---------------------------------------------------------
// A "target" is where a bare message goes: one backend, or "both".
type Target = Backend | "both";

function resolveDefault(): Target {
  const env = (process.env.MULTIAI_DEFAULT ?? "").toLowerCase();
  return env === "claude" || env === "codex" || env === "both" ? env : "both";
}

const targetLabel = (t: Target) =>
  t === "both" ? `${badge("claude")}${C.dim}+${C.reset}${badge("codex")}` : badge(t);

// One conversation turn: what the user said, and each backend's reply.
interface HistoryEntry {
  user: string;
  answers: Partial<Record<Backend, string>>;
}

interface State {
  active: Target;
  models: { claude?: string; codex?: string };
  memory: boolean;
  history: HistoryEntry[];
}
const state: State = { active: resolveDefault(), models: {}, memory: true, history: [] };

const optsFor = (b: Backend): RunOptions => ({ model: state.models[b], cwd: process.cwd() });

// Prepend the conversation so far (as seen by this backend) to the new message.
// Each backend sees every user turn but only its OWN prior replies, so it stays
// self-consistent even in `both` mode where two models answer in parallel.
function buildPrompt(b: Backend, userInput: string): string {
  if (!state.memory || state.history.length === 0) return userInput;
  const lines = ["You are continuing an ongoing conversation. Earlier turns:", ""];
  for (const h of state.history) {
    lines.push(`[User]: ${h.user}`);
    if (h.answers[b]) lines.push(`[You]: ${h.answers[b]}`);
  }
  lines.push(
    "",
    `[User]: ${userInput}`,
    "",
    "Reply to the latest [User] message, using the earlier turns as context.",
  );
  return lines.join("\n");
}

// Append a turn to history (always logged; sending is gated by state.memory).
function record(userInput: string, results: RunResult[]) {
  const answers: Partial<Record<Backend, string>> = {};
  for (const r of results) if (r.ok) answers[r.backend] = r.text;
  state.history.push({ user: userInput, answers });
}

// Route a bare message to whatever the active target is.
async function dispatch(target: Target, prompt: string) {
  if (target === "both") await askBoth(prompt);
  else await askOne(target, prompt);
}

async function askOne(b: Backend, userInput: string) {
  const stop = spinner(`${b} thinking…`);
  const r = await run(b, buildPrompt(b, userInput), optsFor(b));
  stop();
  printResult(r);
  record(userInput, [r]);
}

async function askBoth(userInput: string) {
  const stop = spinner("claude + codex thinking…");
  const results = await Promise.all([
    run("claude", buildPrompt("claude", userInput), optsFor("claude")),
    run("codex", buildPrompt("codex", userInput), optsFor("codex")),
  ]);
  stop();
  for (const r of results) printResult(r);
  record(userInput, results);
}

async function askJudge(userInput: string, author: Backend) {
  const judgeBackend: Backend = author === "claude" ? "codex" : "claude";
  const stop = spinner(`${author} drafting → ${judgeBackend} reviewing…`);
  const { draft, review } = await judge(
    userInput,
    author,
    judgeBackend,
    optsFor(author),
    optsFor(judgeBackend),
    buildPrompt(author, userInput),
  );
  stop();
  console.log(`\n${C.dim}── draft by${C.reset} ${badge(author)} ${C.dim}──${C.reset}`);
  printResult(draft);
  console.log(`\n${C.dim}── review by${C.reset} ${badge(judgeBackend)} ${C.dim}──${C.reset}`);
  printResult(review);
  // Record the reviewed final answer as the author's turn so the thread continues.
  record(userInput, [{ ...review, backend: author }]);
}

// --- interactive REPL ------------------------------------------------------
const HELP = `
${C.bold}MultiAI — commands${C.reset}
  ${C.cyan}<text>${C.reset}                  send to the active target (${C.dim}shown in prompt; default: both${C.reset})
  ${C.cyan}/use claude|codex|both${C.reset}   switch the active target
  ${C.cyan}/both <text>${C.reset}            ask BOTH models and show answers side by side
  ${C.cyan}/judge <text>${C.reset}           one model drafts, the other reviews & improves
  ${C.cyan}/model <name>${C.reset}           set model for the active backend (e.g. haiku, gpt-5)
  ${C.cyan}/model clear${C.reset}            reset the active backend's model to default
  ${C.cyan}/memory on|off${C.reset}          toggle whether prior turns are sent as context
  ${C.cyan}/reset${C.reset}                  clear the conversation history
  ${C.cyan}/history${C.reset}                show how many turns are remembered
  ${C.cyan}/status${C.reset}                 show current target, models & memory
  ${C.cyan}/help${C.reset}                   show this help
  ${C.cyan}/exit${C.reset} (or Ctrl-D)       quit
${C.dim}Memory is on by default: each backend sees its own prior replies as context.${C.reset}
`;

function promptStr(): string {
  const m = state.active !== "both" ? state.models[state.active] : undefined;
  return `${targetLabel(state.active)}${m ? C.dim + ":" + m + C.reset : ""} ${C.bold}▸${C.reset} `;
}

async function handleLine(line: string, rl: readline.Interface): Promise<boolean> {
  const input = line.trim();
  if (!input) return true;

  if (input.startsWith("/")) {
    const [cmd, ...rest] = input.slice(1).split(/\s+/);
    const arg = input.slice(1 + cmd.length).trim();
    switch (cmd) {
      case "exit":
      case "quit":
        return false;
      case "help":
        console.log(HELP);
        return true;
      case "status":
        console.log(
          `active=${targetLabel(state.active)}  ` +
            `claude model=${state.models.claude ?? "default"}  ` +
            `codex model=${state.models.codex ?? "default"}  ` +
            `memory=${state.memory ? "on" : "off"} (${state.history.length} turns)`,
        );
        return true;
      case "memory":
        if (rest[0] === "on" || rest[0] === "off") {
          state.memory = rest[0] === "on";
          console.log(`${C.green}✓${C.reset} memory → ${rest[0]}`);
        } else console.log(`${C.yellow}usage: /memory on|off${C.reset}`);
        return true;
      case "reset":
        state.history = [];
        console.log(`${C.green}✓${C.reset} conversation history cleared`);
        return true;
      case "history":
        console.log(`${C.dim}${state.history.length} turn(s) remembered; memory ${state.memory ? "on" : "off"}${C.reset}`);
        return true;
      case "use":
        if (rest[0] === "claude" || rest[0] === "codex" || rest[0] === "both") {
          state.active = rest[0];
          console.log(`${C.green}✓${C.reset} active target → ${targetLabel(state.active)}`);
        } else console.log(`${C.yellow}usage: /use claude|codex|both${C.reset}`);
        return true;
      case "model": {
        if (state.active === "both") {
          console.log(`${C.yellow}/model needs a single backend — run /use claude|codex first${C.reset}`);
          return true;
        }
        const active = state.active;
        if (!arg) console.log(`${C.yellow}usage: /model <name> | /model clear${C.reset}`);
        else if (arg === "clear") {
          delete state.models[active];
          console.log(`${C.green}✓${C.reset} ${badge(active)} model reset to default`);
        } else {
          state.models[active] = arg;
          console.log(`${C.green}✓${C.reset} ${badge(active)} model → ${arg}`);
        }
        return true;
      }
      case "both":
        if (arg) await askBoth(arg);
        else console.log(`${C.yellow}usage: /both <question>${C.reset}`);
        return true;
      case "judge":
        if (arg) await askJudge(arg, state.active === "codex" ? "codex" : "claude");
        else console.log(`${C.yellow}usage: /judge <question>${C.reset}`);
        return true;
      default:
        console.log(`${C.yellow}unknown command: /${cmd} — try /help${C.reset}`);
        return true;
    }
  }

  await dispatch(state.active, input);
  return true;
}

async function repl() {
  console.log(
    `${C.bold}MultiAI${C.reset} ${C.dim}— one shell, two brains (claude + codex). /help for commands.${C.reset}`,
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // The async iterator pulls the next line only after this loop body finishes,
  // which serializes handling and avoids resume-after-close races on piped input.
  process.stdout.write(promptStr());
  for await (const line of rl) {
    let keepGoing = true;
    try {
      keepGoing = await handleLine(line, rl);
    } catch (e) {
      console.log(`${C.red}error: ${String(e)}${C.reset}`);
    }
    if (!keepGoing) break;
    process.stdout.write(`\n${promptStr()}`);
  }
  rl.close();
  console.log(`\n${C.dim}bye.${C.reset}`);
}

// --- one-shot subcommands --------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    await repl();
    return;
  }

  const cmd = argv[0];
  const rest = argv.slice(1).join(" ");

  switch (cmd) {
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      break;
    case "claude":
      await askOne("claude", rest);
      break;
    case "codex":
      await askOne("codex", rest);
      break;
    case "ask":
      await dispatch(state.active, rest);
      break;
    case "both":
      await askBoth(rest);
      break;
    case "judge":
      await askJudge(rest, "claude");
      break;
    default:
      // treat the whole argv as a prompt to the default target (both by default)
      await dispatch(state.active, argv.join(" "));
  }
}

main().catch((e) => {
  console.error(`${C.red}fatal: ${String(e)}${C.reset}`);
  process.exit(1);
});
