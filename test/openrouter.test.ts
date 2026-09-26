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
    action: { choice: string; confidence: number; probabilities: Record<string, number> };
    conviction: { score: number; confidence: number };
  };
  usage: { input_tokens: number; output_tokens: number };
}

const req = (): Req =>
  ({
    model: "openai/gpt-4o-mini",
    state: { x: 1 },
    questions: {
      action: { type: "choice", instructions: "Pick your next move.", criteria: { HOLD: "do nothing", BUY: "open long" } },
      conviction: { type: "score", instructions: "Signal strength?", criteria: ["flat", "weak", "strong"] },
    },
  }) as unknown as Req;

const chatBody = (content: string, status = 200, usage = { prompt_tokens: 100, completion_tokens: 50 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status });

const validContent = JSON.stringify({
  action: { choice: "BUY", confidence: 0.7, probabilities: { HOLD: 0.3, BUY: 0.7 } },
  conviction: { score: 2.2, confidence: 0.6 },
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof globalThis.fetch;
  return calls;
}

const codeOf = (err: unknown) => (err as { code?: string }).code;

describe("OpenRouterSystemOne", () => {
  it("parses a valid response (choice/confidence/probabilities/score/usage mapping)", async () => {
    const calls = stubFetch(() => chatBody(validContent));
    const r = (await new OpenRouterSystemOne({ apiKey: "k", model: "openai/gpt-4o-mini", timeoutMs: 2000 }).systemOne(req())) as unknown as Parsed;
    expect(r.model).toBe("openai/gpt-4o-mini");
    expect(r.answers.action).toMatchObject({ choice: "BUY", confidence: 0.7, probabilities: { HOLD: 0.3, BUY: 0.7 } });
    expect(r.answers.conviction).toMatchObject({ score: 2.2, confidence: 0.6 });
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 50 });

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(calls[0]!.init?.body)) as { model: string; messages: Array<{ role: string; content: string }>; response_format: { type: string } };
    expect(body.model).toBe("openai/gpt-4o-mini");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]!.content).toMatch(/EXACTLY/);
    expect(body.messages[0]!.content).toMatch(/verbatim/);
    const userMsg = JSON.parse(body.messages[1]!.content) as { state: unknown; criteria: unknown; convictionRubric: unknown };
    expect(userMsg.state).toEqual({ x: 1 });
    expect(userMsg.criteria).toEqual({ HOLD: "do nothing", BUY: "open long" });
    expect(userMsg.convictionRubric).toEqual(["flat", "weak", "strong"]);
  });

  it("renormalizes probabilities within tolerance", async () => {
    stubFetch(() =>
      chatBody(
        JSON.stringify({ action: { choice: "BUY", confidence: 0.7, probabilities: { HOLD: 0.31, BUY: 0.72 } }, conviction: { score: 1, confidence: 0.5 } }),
      ),
    );
    const r = (await new OpenRouterSystemOne({ apiKey: "k", model: "m", timeoutMs: 2000 }).systemOne(req())) as unknown as Parsed;
    const sum = r.answers.action.probabilities["HOLD"]! + r.answers.action.probabilities["BUY"]!;
    expect(sum).toBeCloseTo(1, 12);
  });

  it("throws on an off-menu choice and never substitutes one", async () => {
    stubFetch(() =>
      chatBody(JSON.stringify({ action: { choice: "YOLO", confidence: 0.9, probabilities: { HOLD: 0.5, BUY: 0.5 } }, conviction: { score: 1, confidence: 0.5 } })),
    );
    try {
      await new OpenRouterSystemOne({ apiKey: "k", model: "m", timeoutMs: 2000 }).systemOne(req());
      expect.unreachable("should throw");
    } catch (err) {
      expect(codeOf(err)).toBe("OFF_MENU");
    }
  });

  it("throws on malformed JSON", async () => {
    stubFetch(() => chatBody("not json{{"));
    try {
      await new OpenRouterSystemOne({ apiKey: "k", model: "m", timeoutMs: 2000 }).systemOne(req());
      expect.unreachable("should throw");
    } catch (err) {
      expect(codeOf(err)).toBe("OPENROUTER_BAD_JSON");
    }
  });

  it("throws with status on non-2xx", async () => {
    stubFetch(() => new Response("server blew up", { status: 500 }));
    try {
      await new OpenRouterSystemOne({ apiKey: "k", model: "m", timeoutMs: 2000 }).systemOne(req());
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(500);
      expect(codeOf(err)).toMatch(/OPENROUTER_HTTP/);
    }
  });

  it("throws when probabilities do not sum near 1", async () => {
    stubFetch(() =>
      chatBody(JSON.stringify({ action: { choice: "BUY", confidence: 0.7, probabilities: { HOLD: 0.3, BUY: 0.3 } }, conviction: { score: 1, confidence: 0.5 } })),
    );
    try {
      await new OpenRouterSystemOne({ apiKey: "k", model: "m", timeoutMs: 2000 }).systemOne(req());
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
      await new OpenRouterSystemOne({ apiKey: "k", model: "m", timeoutMs: 30 }).systemOne(req(), { timeout: 30 });
      expect.unreachable("should throw");
    } catch (err) {
      expect(codeOf(err)).toBe("OPENROUTER_TIMEOUT");
    }
  });

  it("plugs into the untouched Jev class with openrouter pricing", async () => {
    stubFetch(() => chatBody(validContent, 200, { prompt_tokens: 1_000_000, completion_tokens: 10 }));
    const menu = { HOLD: { desc: "do nothing", intent: { kind: "hold" as const } }, BUY: { desc: "open long", intent: { kind: "hold" as const } } };
    const j = new Jev({
      apiKey: "ork",
      model: "openai/gpt-4o-mini",
      timeoutMs: 2000,
      dailyUsdCap: 5,
      usdPerMTok: 0.15,
      client: new OpenRouterSystemOne({ apiKey: "ork", model: "openai/gpt-4o-mini", timeoutMs: 2000 }),
    });
    const r = await j.decide({ strategy: "You are boozy.", state: { x: 1 }, menu, convictionLabels: ["flat", "weak", "strong"] });
    expect(r).toMatchObject({ ok: true, choice: "BUY", model: "openai/gpt-4o-mini" });
    expect(r.ok && r.costUsd).toBeCloseTo(0.15, 12);
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
    expect(c.jev).toMatchObject({ apiKey: "ork", model: "openai/gpt-4o-mini", usdPerMTok: 0.15 });
  });
});
