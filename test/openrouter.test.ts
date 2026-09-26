import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Jev } from "../src/jev.js";
import { OpenRouterSystemOne } from "../src/openrouter.js";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

type Req = Parameters<OpenRouterSystemOne["systemOne"]>[0];
interface Parsed {
  model: string;
  answers: {
    action: { type: string; choice: string; confidence: number; probabilities: Record<string, number> };
    conviction: { type: string; score: number; confidence: number; legend: Record<string, unknown>; probabilities: Record<string, number> };
  };
  usage: { input_tokens: number; output_tokens: number };
}

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const REQ_MODEL = "typesafe/jev-1.13";
const RES_MODEL = "typesafe/jev-1.13-20260917";

const req = (): Req =>
  ({
    model: REQ_MODEL,
    state: { x: 1 },
    questions: {
      action: { type: "choice", instructions: "Pick your next move.", criteria: { HOLD: "do nothing", BUY: "open long" } },
      conviction: { type: "score", instructions: "Signal strength?", criteria: ["flat", "weak", "strong"] },
    },
  }) as unknown as Req;

const decisionsBody = (
  answers: unknown,
  status = 200,
  usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 50, cost: 0.0000042 },
  model = RES_MODEL,
) => new Response(JSON.stringify({ model, answers, usage, provider: "TypeSafe" }), { status });

const validAnswers = {
  action: { type: "choice", choice: "BUY", confidence: 0.7, probabilities: { HOLD: 0.3, BUY: 0.7 } },
  conviction: {
    type: "score",
    score: 2.2,
    confidence: 0.6,
    legend: { 0: "flat", 1: "weak", 2: "strong" },
    probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
  },
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof globalThis.fetch;
  return calls;
}

const codeOf = (err: unknown) => (err as { code?: string }).code;

describe("OpenRouterSystemOne (Decisions API)", () => {
  it("parses native choice+score shapes, maps usage incl. cost, returns response model", async () => {
    const calls = stubFetch(() => decisionsBody(validAnswers));
    const r = (await new OpenRouterSystemOne({ apiKey: "k", model: REQ_MODEL, timeoutMs: 8000 }).systemOne(req())) as unknown as Parsed;
    expect(r.model).toBe(RES_MODEL);
    expect(r.answers.action).toMatchObject({ type: "choice", choice: "BUY", confidence: 0.7, probabilities: { HOLD: 0.3, BUY: 0.7 } });
    expect(r.answers.conviction).toMatchObject({ type: "score", score: 2.2, confidence: 0.6 });
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 50 });

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(DECISIONS_URL);
    const init = calls[0]!.init!;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer k");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init.body)) as { model: string; state: unknown; questions: unknown };
    // Pass-through verbatim: model/state/questions, no chat/completions/message wrapping.
    expect(body.model).toBe(REQ_MODEL);
    expect(body.state).toEqual({ x: 1 });
    expect(body.questions).toEqual(req().questions);
    expect(String(init.body)).not.toMatch(/messages/);
    expect(String(init.body)).not.toMatch(/response_format/);
  });

  it("renormalizes probabilities within tolerance", async () => {
    stubFetch(() =>
      decisionsBody({
        action: { type: "choice", choice: "BUY", confidence: 0.7, probabilities: { HOLD: 0.31, BUY: 0.72 } },
        conviction: { type: "score", score: 1, confidence: 0.5 },
      }),
    );
    const r = (await new OpenRouterSystemOne({ apiKey: "k", model: REQ_MODEL, timeoutMs: 8000 }).systemOne(req())) as unknown as Parsed;
    const sum = r.answers.action.probabilities["HOLD"]! + r.answers.action.probabilities["BUY"]!;
    expect(sum).toBeCloseTo(1, 12);
  });

  it("throws OFF_MENU on an off-menu choice and never substitutes one", async () => {
    stubFetch(() =>
      decisionsBody({
        action: { type: "choice", choice: "YOLO", confidence: 0.9, probabilities: { HOLD: 0.5, BUY: 0.5 } },
        conviction: { type: "score", score: 1, confidence: 0.5 },
      }),
    );
    try {
      await new OpenRouterSystemOne({ apiKey: "k", model: REQ_MODEL, timeoutMs: 8000 }).systemOne(req());
      expect.unreachable("should throw");
    } catch (err) {
      expect(codeOf(err)).toBe("OFF_MENU");
    }
  });

  it("throws on a malformed envelope", async () => {
    for (const bad of [
      { wrong: "shape" },
      { model: RES_MODEL, usage: { input_tokens: 1, output_tokens: 1 } }, // missing answers
      { model: RES_MODEL, answers: validAnswers }, // missing usage
      { model: RES_MODEL, answers: { action: validAnswers.action }, usage: { input_tokens: 1, output_tokens: 1 } }, // missing conviction
      { model: RES_MODEL, answers: { action: { type: "choice", choice: "BUY" }, conviction: validAnswers.conviction }, usage: { input_tokens: 1, output_tokens: 1 } }, // missing confidence/probabilities
      { model: RES_MODEL, answers: { action: validAnswers.action, conviction: { type: "score", score: NaN, confidence: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } },
    ]) {
      stubFetch(() => new Response(JSON.stringify({ ...bad, provider: "TypeSafe" }), { status: 200 }));
      try {
        await new OpenRouterSystemOne({ apiKey: "k", model: REQ_MODEL, timeoutMs: 8000 }).systemOne(req());
        expect.unreachable("should throw");
      } catch (err) {
        expect(codeOf(err)).toMatch(/OPENROUTER_BAD_RESPONSE|OPENROUTER_BAD_PROBABILITIES/);
      }
    }
  });

  it("throws with status on non-2xx", async () => {
    stubFetch(() => new Response("server blew up", { status: 500 }));
    try {
      await new OpenRouterSystemOne({ apiKey: "k", model: REQ_MODEL, timeoutMs: 8000 }).systemOne(req());
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(500);
      expect(codeOf(err)).toMatch(/OPENROUTER_HTTP/);
    }
  });

  it("throws when probabilities do not sum near 1", async () => {
    stubFetch(() =>
      decisionsBody({
        action: { type: "choice", choice: "BUY", confidence: 0.7, probabilities: { HOLD: 0.3, BUY: 0.3 } },
        conviction: { type: "score", score: 1, confidence: 0.5 },
      }),
    );
    try {
      await new OpenRouterSystemOne({ apiKey: "k", model: REQ_MODEL, timeoutMs: 8000 }).systemOne(req());
      expect.unreachable("should throw");
    } catch (err) {
      expect(codeOf(err)).toBe("OPENROUTER_BAD_PROBABILITIES");
    }
  });

  it("aborts on timeout", async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      throw new Error("unreachable");
    }) as typeof globalThis.fetch;
    try {
      await new OpenRouterSystemOne({ apiKey: "k", model: REQ_MODEL, timeoutMs: 30 }).systemOne(req(), { timeout: 30 });
      expect.unreachable("should throw");
    } catch (err) {
      expect(codeOf(err)).toBe("OPENROUTER_TIMEOUT");
    }
  });

  it("plugs into the untouched Jev class with OpenRouter-routed Jev pricing", async () => {
    stubFetch(() => decisionsBody(validAnswers, 200, { input_tokens: 1_000_000, output_tokens: 10, cost: 0.042 }));
    const menu = { HOLD: { desc: "do nothing", intent: { kind: "hold" as const } }, BUY: { desc: "open long", intent: { kind: "hold" as const } } };
    const j = new Jev({
      apiKey: "ork",
      model: REQ_MODEL,
      timeoutMs: 8000,
      dailyUsdCap: 5,
      usdPerMTok: 0.042,
      client: new OpenRouterSystemOne({ apiKey: "ork", model: REQ_MODEL, timeoutMs: 8000 }),
    });
    const r = await j.decide({ strategy: "You are boozy.", state: { x: 1 }, menu, convictionLabels: ["flat", "weak", "strong"] });
    expect(r).toMatchObject({ ok: true, choice: "BUY", model: RES_MODEL });
    expect(r.ok && r.costUsd).toBeCloseTo(0.042, 12);
  });
});

describe("reasoning backend config", () => {
  it("defaults to jev with jev pricing", () => {
    const c = loadConfig({ TYPESAFE_API_KEY: "k" });
    expect(c.reasoning.backend).toBe("jev");
    expect(c.jev).toMatchObject({ apiKey: "k", model: "jev-1.13.0", usdPerMTok: 0.042 });
  });

  it("backend=openrouter requires OPENROUTER_API_KEY and resolves model/pricing", () => {
    expect(() => loadConfig({ REASONING_BACKEND: "openrouter" })).toThrow(/OPENROUTER_API_KEY/);
    const c = loadConfig({ REASONING_BACKEND: "openrouter", OPENROUTER_API_KEY: "ork" });
    expect(c.reasoning.backend).toBe("openrouter");
    expect(c.jev).toMatchObject({ apiKey: "ork", model: "typesafe/jev-1.13", usdPerMTok: 0.042 });
  });
});
