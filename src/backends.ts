// Backend adapters. Each wraps an *official* CLI in headless mode, so that all
// authentication (subscription OAuth or API key) is delegated to that tool.
// We never touch tokens ourselves — the user logs in once via `claude` / `codex`.

import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Backend = "claude" | "codex";

export interface RunOptions {
  model?: string;
  cwd?: string;
}

export interface RunResult {
  backend: Backend;
  text: string;
  ok: boolean;
  error?: string;
  ms: number;
  costUsd?: number;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? process.cwd(),
      // stdin is closed immediately (empty) so codex/claude never block waiting
      // for piped input when there is no TTY.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) =>
      resolve({ code: -1, stdout, stderr: `${stderr}${String(e)}` }),
    );
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// --- Claude Code -----------------------------------------------------------
// `claude -p <prompt> --output-format json` emits a single JSON object whose
// `.result` field holds the assistant's final text.
export async function runClaude(
  prompt: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const start = Date.now();
  const args = ["-p", prompt, "--output-format", "json"];
  if (opts.model) args.push("--model", opts.model);

  const { code, stdout, stderr } = await exec("claude", args, { cwd: opts.cwd });
  const ms = Date.now() - start;

  if (code !== 0 && !stdout.trim()) {
    return { backend: "claude", text: "", ok: false, error: stderr.trim() || `exit ${code}`, ms };
  }
  try {
    const json = JSON.parse(stdout);
    if (json.is_error) {
      return { backend: "claude", text: "", ok: false, error: String(json.result ?? "error"), ms };
    }
    return {
      backend: "claude",
      text: String(json.result ?? "").trim(),
      ok: true,
      ms,
      costUsd: typeof json.total_cost_usd === "number" ? json.total_cost_usd : undefined,
    };
  } catch {
    // Fallback: treat raw stdout as the answer.
    return { backend: "claude", text: stdout.trim(), ok: true, ms };
  }
}

// --- Codex -----------------------------------------------------------------
// `codex exec <prompt> -o <file>` writes the final assistant message to <file>.
// We read it back and clean up. `--skip-git-repo-check` avoids the trusted-dir
// prompt when running outside a git repo.
export async function runCodex(
  prompt: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const start = Date.now();
  const outFile = join(tmpdir(), `multiai-codex-${process.pid}-${start}.txt`);
  const args = [
    "exec",
    prompt,
    "--skip-git-repo-check",
    "--color",
    "never",
    "-o",
    outFile,
  ];
  if (opts.model) args.push("--model", opts.model);

  const { code, stderr } = await exec("codex", args, { cwd: opts.cwd });
  const ms = Date.now() - start;

  let text = "";
  try {
    text = (await readFile(outFile, "utf8")).trim();
  } catch {
    /* file may not exist on hard failure */
  } finally {
    await unlink(outFile).catch(() => {});
  }

  if (!text) {
    return { backend: "codex", text: "", ok: false, error: stderr.trim() || `exit ${code}`, ms };
  }
  return { backend: "codex", text, ok: true, ms };
}

export function run(
  backend: Backend,
  prompt: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  return backend === "claude" ? runClaude(prompt, opts) : runCodex(prompt, opts);
}
