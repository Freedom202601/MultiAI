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
  onActivity?: (label: string) => void; // called when a tool is invoked, e.g. "Read(x.ts)"
}

// Turn a tool_use name + its (streamed) input JSON into a compact one-line label.
function toolLabel(name: string, inputJson: string): string {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(inputJson || "{}");
  } catch {
    /* input may be incomplete on error */
  }
  const keys = ["file_path", "path", "command", "query", "url", "pattern", "description", "subagent_type"];
  let val: string | undefined;
  for (const k of keys) {
    if (typeof input[k] === "string") {
      val = input[k] as string;
      break;
    }
  }
  if (!val) return name;
  if (val.includes("/") && ["Read", "Edit", "Write", "Glob"].includes(name)) {
    val = val.split("/").pop() || val;
  }
  val = val.replace(/\s+/g, " ").trim();
  if (val.length > 60) val = `${val.slice(0, 57)}…`;
  return `${name}(${val})`;
}

export interface RunResult {
  backend: Backend;
  text: string;
  ok: boolean;
  error?: string;
  ms: number;
  costUsd?: number;
  sessionId?: string; // pass back as opts.resume next turn to keep context
  activities?: string[]; // tools/commands the backend ran (for buffered display)
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
  // Track in-flight tool_use blocks by index so we can label the tool + its args.
  const tools = new Map<number, { name: string; json: string }>();

  const { code, stderr } = await execLines("claude", args, { cwd: opts.cwd }, (line) => {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    const e = j.type === "stream_event" ? j.event : undefined;
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
      const t: string = e.delta.text ?? "";
      text += t;
      opts.onToken?.(t);
    } else if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
      tools.set(e.index, { name: e.content_block.name ?? "tool", json: "" });
    } else if (e?.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
      const b = tools.get(e.index);
      if (b) b.json += e.delta.partial_json ?? "";
    } else if (e?.type === "content_block_stop" && tools.has(e.index)) {
      const b = tools.get(e.index)!;
      tools.delete(e.index);
      opts.onActivity?.(toolLabel(b.name, b.json));
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
  const activities: string[] = [];

  const { code, stderr } = await execLines("codex", args, { cwd: opts.cwd }, (line) => {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (j.type === "thread.started" && j.thread_id) {
      threadId = j.thread_id;
    } else if (j.type === "item.started" && j.item?.type === "command_execution") {
      // Codex ran a shell command — strip the `/bin/<sh> -lc` wrapper for display.
      let cmd = String(j.item.command ?? "").replace(/^\/bin\/\w+\s+-lc\s+/, "");
      cmd = cmd.replace(/\s+/g, " ").trim();
      if (cmd.length > 60) cmd = `${cmd.slice(0, 57)}…`;
      const label = `$ ${cmd}`;
      activities.push(label);
      opts.onActivity?.(label);
    } else if (j.type === "item.completed" && j.item?.type === "agent_message") {
      // Intermediate narration and the final answer both arrive here; the last
      // one is the answer. Stream each live when a consumer is listening.
      const t: string = j.item.text ?? "";
      text = t;
      opts.onToken?.(`${t}\n`);
    }
  });
  const ms = Date.now() - start;

  text = text.trim();
  if (!text) return { backend: "codex", text: "", ok: false, error: stderr.trim() || `exit ${code}`, ms, activities };
  // On resume the thread id keeps its original value; caller retains it if undefined.
  return { backend: "codex", text, ok: true, ms, sessionId: threadId ?? opts.resume, activities };
}

export function run(backend: Backend, prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  return backend === "claude" ? runClaude(prompt, opts) : runCodex(prompt, opts);
}
