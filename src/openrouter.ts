// OpenRouter routing to the real TypeSafe Jev 1.13 via the Decisions API (interim routing, not imitation).
// Implements the same SystemOne shape so the Jev class (caps, backoff, fail-closed, OFF_MENU)
// is reused untouched. Never synthesizes a choice: anything unexpected throws and Jev fails closed.

import type * as SDK from "@typesafe-ai/sdk" with { "resolution-mode": "require" };
import type { SystemOne } from "./jev.js";

export interface OpenRouterOpts {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
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
    const model = req.model ?? this.opts.model;
    const timeoutMs = opts?.timeout ?? this.opts.timeoutMs;

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
          // TypeSafe's native SystemOne schema, passed through verbatim: same real model,
          // choices keyed how the engine already builds them.
          body: JSON.stringify({ model, state: req.state, questions: req.questions }),
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
        throw fail("OPENROUTER_BAD_RESPONSE", "response body is not JSON");
      }
      if (!isRecord(data)) throw fail("OPENROUTER_BAD_RESPONSE", "response envelope is not an object");
      if (typeof data["model"] !== "string" || (data["model"] as string).length === 0) {
        throw fail("OPENROUTER_BAD_RESPONSE", "response envelope missing model");
      }
      const responseModel = data["model"] as string;
      const answersRaw = data["answers"];
      if (!isRecord(answersRaw)) throw fail("OPENROUTER_BAD_RESPONSE", "response envelope missing answers");
      const usageRaw = data["usage"];
      const input_tokens =
        isRecord(usageRaw) && typeof usageRaw["input_tokens"] === "number" && Number.isFinite(usageRaw["input_tokens"])
          ? (usageRaw["input_tokens"] as number)
          : undefined;
      const output_tokens =
        isRecord(usageRaw) && typeof usageRaw["output_tokens"] === "number" && Number.isFinite(usageRaw["output_tokens"])
          ? (usageRaw["output_tokens"] as number)
          : undefined;
      if (input_tokens === undefined || output_tokens === undefined) {
        throw fail("OPENROUTER_BAD_RESPONSE", "response envelope missing usage.input_tokens/output_tokens");
      }

      const mapped: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(req.questions)) {
        const q = question as SDK.Question;
        const a: unknown = (answersRaw as Record<string, unknown>)[name];
        if (!isRecord(a)) throw fail("OPENROUTER_BAD_RESPONSE", `response envelope missing answer for "${name}"`);
        if (q.type === "choice") {
          const criteria = (q as SDK.ChoiceQuestion).criteria as Record<string, unknown>;
          const keys = Object.keys(criteria);
          const choice = a["choice"];
          const confidence = a["confidence"];
          const probs = a["probabilities"];
          if (typeof choice !== "string") throw fail("OPENROUTER_BAD_RESPONSE", `answer "${name}" missing choice`);
          if (!keys.includes(choice)) throw fail("OFF_MENU", "choice not in menu");
          if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
            throw fail("OPENROUTER_BAD_RESPONSE", `answer "${name}" missing finite confidence`);
          }
          if (!isRecord(probs)) throw fail("OPENROUTER_BAD_RESPONSE", `answer "${name}" missing probabilities`);
          const weights = keys.map((k) => (probs as Record<string, unknown>)[k]);
          if (weights.some((p) => typeof p !== "number" || !Number.isFinite(p) || (p as number) < 0)) {
            throw fail("OPENROUTER_BAD_PROBABILITIES", `answer "${name}" probabilities must be non-negative numbers for every key`);
          }
          const sum = (weights as number[]).reduce((s, p) => s + p, 0);
          if (Math.abs(sum - 1) > PROB_TOLERANCE) throw fail("OPENROUTER_BAD_PROBABILITIES", `answer "${name}" probabilities sum to ${sum}`);
          const probabilities: Record<string, number> = {};
          keys.forEach((k, i) => {
            probabilities[k] = (weights[i] as number) / sum;
          });
          mapped[name] = { type: "choice", choice, confidence, probabilities };
        } else if (q.type === "score") {
          const rubric = [...((q as SDK.ScoreQuestion).criteria as readonly unknown[])];
          const score = a["score"];
          const confidence = a["confidence"];
          if (typeof score !== "number" || !Number.isFinite(score)) {
            throw fail("OPENROUTER_BAD_RESPONSE", `answer "${name}" missing finite score`);
          }
          if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
            throw fail("OPENROUTER_BAD_RESPONSE", `answer "${name}" missing finite confidence`);
          }
          // Native score answers already carry legend/probabilities; rebuild them only when absent
          // (Jev never reads them — it consumes only score/confidence — but the SDK type requires them).
          let legend: Record<string, unknown>;
          if (isRecord(a["legend"])) legend = a["legend"] as Record<string, unknown>;
          else {
            legend = {};
            rubric.forEach((label, i) => {
              legend[i] = label;
            });
          }
          let probabilities: Record<string, number>;
          if (isRecord(a["probabilities"])) {
            const raw = a["probabilities"] as Record<string, unknown>;
            probabilities = {};
            for (const [k, v] of Object.entries(raw)) {
              if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
                throw fail("OPENROUTER_BAD_PROBABILITIES", `answer "${name}" probabilities must be non-negative numbers`);
              }
              probabilities[k] = v;
            }
            const sum = Object.values(probabilities).reduce((s, p) => s + p, 0);
            if (Math.abs(sum - 1) > PROB_TOLERANCE) {
              throw fail("OPENROUTER_BAD_PROBABILITIES", `answer "${name}" probabilities sum to ${sum}`);
            }
            for (const k of Object.keys(probabilities)) probabilities[k]! /= sum;
          } else {
            const rounded = Math.max(0, Math.min(rubric.length - 1, Math.round(score)));
            probabilities = {};
            rubric.forEach((_, i) => {
              probabilities[i] = i === rounded ? 1 : 0;
            });
          }
          mapped[name] = { type: "score", score, confidence, legend, probabilities };
        } else if (q.type === "noul") {
          if (a["type"] !== "noul" || typeof a["noul"] !== "number" || !Number.isFinite(a["noul"] as number)) {
            throw fail("OPENROUTER_BAD_RESPONSE", `answer "${name}" missing finite noul`);
          }
          mapped[name] = { type: "noul", noul: a["noul"] };
        } else {
          throw fail("OPENROUTER_BAD_REQUEST", `unsupported question type for "${name}"`);
        }
      }

      return {
        model: responseModel,
        answers: mapped,
        usage: { input_tokens, output_tokens },
      } as SDK.SystemOneResult<SDK.Questions>;
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
