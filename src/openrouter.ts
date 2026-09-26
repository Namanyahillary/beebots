// OpenRouter-backed stand-in for the TypeSafe SystemOne client (JEV waitlisted; interim only).
// Implements the same SystemOne shape so the Jev class (caps, backoff, fail-closed, OFF_MENU)
// is reused untouched. Never synthesizes a choice: anything unexpected throws and Jev fails closed.

import type * as SDK from "@typesafe-ai/sdk" with { "resolution-mode": "require" };
import type { SystemOne } from "./jev.js";

export interface OpenRouterOpts {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** Probabilities must sum to 1 within this tolerance (renormalized); anything wider throws. */
const PROB_TOLERANCE = 0.05;

function fail(code: string, message: string, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...extra });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export class OpenRouterSystemOne implements SystemOne {
  constructor(private opts: OpenRouterOpts) {}

  async systemOne(req: SDK.SystemOneRequest, opts?: SDK.RequestOptions): Promise<SDK.SystemOneResult<SDK.Questions>> {
    const actionQ = req.questions["action"];
    const convQ = req.questions["conviction"];
    if (!actionQ || actionQ.type !== "choice") throw fail("OPENROUTER_BAD_REQUEST", "missing action choice question");
    if (!convQ || convQ.type !== "score") throw fail("OPENROUTER_BAD_REQUEST", "missing conviction score question");
    const keys = Object.keys(actionQ.criteria);
    const rubric = [...convQ.criteria];

    const model = req.model ?? this.opts.model;
    const timeoutMs = opts?.timeout ?? this.opts.timeoutMs;

    const system =
      "You are a trading decision engine. Return EXACTLY this JSON object and nothing else: " +
      '{"action":{"choice":"<one of the criteria keys verbatim>","confidence":0..1,"probabilities":{"<every key>":p summing to 1}},' +
      '"conviction":{"score":number,"confidence":0..1}}. ' +
      "Copy the choice key verbatim from the criteria keys; never invent one.";
    const user = JSON.stringify({
      strategy: actionQ.instructions ?? null,
      state: req.state,
      criteria: actionQ.criteria,
      convictionRubric: rubric,
      convictionInstructions: convQ.instructions ?? null,
    });

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onExternalAbort = () => ctrl.abort();
    if (opts?.signal?.aborted) ctrl.abort();
    else opts?.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      let res: Response;
      try {
        res = await globalThis.fetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            response_format: { type: "json_object" },
          }),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (timedOut || ctrl.signal.aborted) throw fail("OPENROUTER_TIMEOUT", `request timed out after ${timeoutMs}ms`);
        throw err;
      }
      // Jev backs off on 5xx by reading err.status, so every HTTP failure carries it.
      if (!res.ok) throw fail("OPENROUTER_HTTP", `OpenRouter HTTP ${res.status}`, { status: res.status });

      let data: unknown;
      try {
        data = await res.json();
      } catch {
        throw fail("OPENROUTER_BAD_JSON", "response body is not JSON");
      }
      const content = isRecord(data) && Array.isArray(data["choices"]) ? (data["choices"][0] as unknown) : undefined;
      const text = isRecord(content) && isRecord(content["message"]) && typeof content["message"]["content"] === "string" ? (content["message"]["content"] as string) : undefined;
      if (text === undefined) throw fail("OPENROUTER_BAD_RESPONSE", "missing message content");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw fail("OPENROUTER_BAD_JSON", "message content is not JSON");
      }
      const action = isRecord(parsed) ? parsed["action"] : undefined;
      const conviction = isRecord(parsed) ? parsed["conviction"] : undefined;
      const choice = isRecord(action) ? action["choice"] : undefined;
      const probs = isRecord(action) ? action["probabilities"] : undefined;
      const actionConf = isRecord(action) ? action["confidence"] : undefined;
      const score = isRecord(conviction) ? conviction["score"] : undefined;
      const convConf = isRecord(conviction) ? conviction["confidence"] : undefined;
      if (typeof choice !== "string" || !isRecord(probs) || typeof actionConf !== "number" || !Number.isFinite(actionConf) || typeof score !== "number" || !Number.isFinite(score) || typeof convConf !== "number" || !Number.isFinite(convConf)) {
        throw fail("OPENROUTER_BAD_JSON", "response missing action/conviction fields");
      }
      if (!keys.includes(choice)) throw fail("OFF_MENU", "choice not in menu");
      const weights = keys.map((k) => probs[k]);
      if (weights.some((p) => typeof p !== "number" || !Number.isFinite(p) || (p as number) < 0)) {
        throw fail("OPENROUTER_BAD_PROBABILITIES", "probabilities must be non-negative numbers for every key");
      }
      const sum = (weights as number[]).reduce((s, p) => s + p, 0);
      if (Math.abs(sum - 1) > PROB_TOLERANCE) throw fail("OPENROUTER_BAD_PROBABILITIES", `probabilities sum to ${sum}`);
      const probabilities: Record<string, number> = {};
      keys.forEach((k, i) => {
        probabilities[k] = (weights[i] as number) / sum;
      });

      const usage = isRecord(data) ? data["usage"] : undefined;
      const input_tokens = isRecord(usage) && typeof usage["prompt_tokens"] === "number" ? usage["prompt_tokens"] : 0;
      const output_tokens = isRecord(usage) && typeof usage["completion_tokens"] === "number" ? usage["completion_tokens"] : 0;

      // Structural wrappers the SDK type requires but Jev never reads (it consumes only
      // score/confidence): the rubric labels verbatim, and a point mass on the rounded score.
      const legend: Record<string, unknown> = {};
      rubric.forEach((label, i) => {
        legend[i] = label;
      });
      const rounded = Math.max(0, Math.min(rubric.length - 1, Math.round(score)));
      const convProbs: Record<string, number> = {};
      rubric.forEach((_, i) => {
        convProbs[i] = i === rounded ? 1 : 0;
      });

      return {
        model,
        answers: {
          action: { type: "choice", choice, confidence: actionConf, probabilities },
          conviction: { type: "score", score, confidence: convConf, legend, probabilities: convProbs },
        },
        usage: { input_tokens, output_tokens },
      } as SDK.SystemOneResult<SDK.Questions>;
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
