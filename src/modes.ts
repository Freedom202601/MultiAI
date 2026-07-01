// Higher-level orchestration modes built on top of the two backends.

import { run, runClaude, runCodex, type Backend, type RunOptions, type RunResult } from "./backends.ts";

// Ask both models the same thing, concurrently.
export async function both(prompt: string, opts: RunOptions = {}): Promise<RunResult[]> {
  return Promise.all([runClaude(prompt, opts), runCodex(prompt, opts)]);
}

export interface JudgeResult {
  draft: RunResult;
  review: RunResult;
  author: Backend;
  judge: Backend;
}

// Collaboration / judge: `author` answers first, then `judge` critiques that
// answer and produces an improved final version.
export async function judge(
  prompt: string,
  author: Backend,
  judgeBackend: Backend,
  authorOpts: RunOptions = {},
  judgeOpts: RunOptions = {},
  draftPrompt?: string,
): Promise<JudgeResult> {
  // `draftPrompt` may carry conversation history; `prompt` is the plain
  // user request shown to the reviewer.
  const draft = await run(author, draftPrompt ?? prompt, authorOpts);

  const reviewPrompt = [
    "You are reviewing another AI assistant's answer to a user's request.",
    "",
    "## Original request",
    prompt,
    "",
    `## Answer from the other assistant (${author})`,
    draft.ok ? draft.text : `[the other assistant failed: ${draft.error}]`,
    "",
    "## Your task",
    "1. Briefly critique the answer above: note any errors, gaps, or risky assumptions.",
    "2. Then output an improved, final answer under a heading `## Final answer`.",
    "Be concise. If the original answer is already correct, say so and refine only if useful.",
  ].join("\n");

  const review = await run(judgeBackend, reviewPrompt, judgeOpts);
  return { draft, review, author, judge: judgeBackend };
}
