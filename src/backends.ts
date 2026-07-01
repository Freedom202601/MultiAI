// Backend adapters. Each wraps an *official* CLI in headless mode, so that all
// authentication (subscription OAuth or API key) is delegated to that tool.
// We never touch tokens ourselves — the user logs in once via `claude` / `codex`.
//
// Two capabilities beyond a plain call:
//   • token streaming  — Claude streams via stream-json; Codex returns whole.
//   • native sessions  — each result carries a `sessionId` the caller stores and
//                        passes back as `opts.resume` to continue the thread.

import { spawn } from "node:child_process";

export type Backend = "claude" | "codex";

export interface RunOptions {
  model?: string;
  cwd?: string;
  resume?: string; // continue a prior session/thread of this backend
  onToken?: (t: string) => void; // called with text deltas as they stream in
}

export interface RunResult {
  backend: Backend;
  text: string;
  ok: boolean;
  error?: string;
  ms: number;
  costUsd?: number;
  sessionId?: string; // pass back as opts.resume next turn to keep context
}

// Spawn a process, delivering each complete stdout line to `onLine` as it
// arrives (for streaming). Resolves with exit code and collected stderr.
function execLines(
  cmd: string,
  args: string[],
  opts: { cwd?: string },
  onLine: (line: string) => void,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? process.cwd(),
      // stdin closed so the CLIs never block waiting for piped input.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: -1, stderr: `${stderr}${String(e)}` }));
    child.on("close", (code) => {
      if (buf.trim()) onLine(buf);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

// --- Claude Code -----------------------------------------------------------
export async function runClaude(prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  const start = Date.now();
  const streaming = typeof opts.onToken === "function";
  const args = ["-p", prompt, "--output-format", streaming ? "stream-json" : "json"];
  if (streaming) args.push("--verbose", "--include-partial-messages");
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.model) args.push("--model", opts.model);

  let text = "";
  let sessionId: string | undefined;
  let costUsd: number | undefined;
  let isError = false;
  let errMsg = "";

  const { code, stderr } = await execLines("claude", args, { cwd: opts.cwd }, (line) => {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (
      j.type === "stream_event" &&
      j.event?.type === "content_block_delta" &&
      j.event.delta?.type === "text_delta"
    ) {
      const t: string = j.event.delta.text ?? "";
      text += t;
      opts.onToken?.(t);
    } else if (j.type === "result") {
      sessionId = j.session_id;
      if (typeof j.total_cost_usd === "number") costUsd = j.total_cost_usd;
      if (j.is_error) {
        isError = true;
        errMsg = String(j.result ?? "error");
      } else if (typeof j.result === "string") {
        text = j.result; // authoritative final text
      }
    }
  });
  const ms = Date.now() - start;

  if (isError) return { backend: "claude", text: "", ok: false, error: errMsg, ms, sessionId };
  if (code !== 0 && !text.trim())
    return { backend: "claude", text: "", ok: false, error: stderr.trim() || `exit ${code}`, ms };
  return { backend: "claude", text: text.trim(), ok: true, ms, costUsd, sessionId };
}

// --- Codex -----------------------------------------------------------------
// `codex exec --json` emits JSONL events: `thread.started` gives the thread id
// (for resume), and `item.completed` (agent_message) carries the final text.
// This version does not emit token deltas, so Codex answers arrive whole.
export async function runCodex(prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  const start = Date.now();
  // --json emits clean JSONL events, so no --color handling is needed; the
  // `resume` subcommand also rejects --color, so we omit it for both paths.
  const base = ["--skip-git-repo-check", "--json"];
  const args = opts.resume
    ? ["exec", "resume", opts.resume, prompt, ...base]
    : ["exec", prompt, ...base];
  if (opts.model) args.push("--model", opts.model);

  let text = "";
  let threadId: string | undefined;

  const { code, stderr } = await execLines("codex", args, { cwd: opts.cwd }, (line) => {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (j.type === "thread.started" && j.thread_id) threadId = j.thread_id;
    else if (j.type === "item.completed" && j.item?.type === "agent_message")
      text = j.item.text ?? text;
  });
  const ms = Date.now() - start;

  text = text.trim();
  if (!text) return { backend: "codex", text: "", ok: false, error: stderr.trim() || `exit ${code}`, ms };
  // On resume the thread id keeps its original value; caller retains it if undefined.
  return { backend: "codex", text, ok: true, ms, sessionId: threadId ?? opts.resume };
}

export function run(backend: Backend, prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  return backend === "claude" ? runClaude(prompt, opts) : runCodex(prompt, opts);
}
