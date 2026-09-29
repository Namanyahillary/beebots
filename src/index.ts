import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Alerts } from "./alerts.js";
import { BREEZY_COINS } from "./bees/breezy.js";
import { BEES, ConfigError, loadConfig, STYLES, type Config } from "./config.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { EventBus } from "./events.js";
import { hashPassword, MIN_PASSWORD } from "./gate.js";
import { Hive, hivePath } from "./hive.js";
import { OkxExecutor, SimExecutor, type Executor } from "./exec/executor.js";
import { AlpacaExecutor } from "./exec/alpaca.js";
import { Jev } from "./jev.js";
import { log, setLogLevel } from "./log.js";
import { OpenRouterSystemOne } from "./openrouter.js";
import { MarketFeed } from "./market/data.js";
import { createOkxCli } from "./okx/cli.js";
import { createNewsSource } from "./okx/news.js";
import { createPublicApi } from "./okx/public.js";
import { createOkxPublicRest } from "./okx/rest.js";
import { safeError } from "./redact.js";
import { startServer } from "./server.js";
import { loadSettings, STYLE_INFO } from "./settings.js";
import { imagePath, Setup } from "./setup.js";
import { UpdateCheck } from "./update.js";
import { Visitors } from "./visitors.js";

const SETTINGS_PATH = process.env.SETTINGS_PATH?.trim() || "./data/settings.json";
// Reference portraits for generated bees: the dashboard's default art (copied into the image by the Dockerfile).
const REF_DIR = process.env.REF_DIR?.trim() || "./dashboard/public/bees";

/** Names, rules, styles and pictures for the dashboard. */
/** Portrait URL for an official bee, keyed by wolf name (not style slot). Null = not painted yet (the dashboard shows the placeholder mark). */
const OFFICIAL_ART: Record<string, string | null> = { grim: "/bees/grim.jpg", blaze: "/bees/blaze.jpg", silver: "/bees/silver.jpg", dash: null, zip: null, rook: null, echo: null };
function officialArt(name: string, style: string): string | null {
  const key = name.trim().toLowerCase();
  if (key in OFFICIAL_ART) return OFFICIAL_ART[key]!;
  return `/bees/${style}.jpg`;
}

function profile(cfg: Config | null) {  return {
    setup: cfg === null,
    mode: cfg?.mode ?? "dry",
    links: cfg?.links ?? null,
    bees: cfg
      ? BEES.map((id) => {
          const s = cfg.slots[id];
          return {
            id,
            name: s.name,
            tagline: s.tagline,
            style: s.style,
            styleLabel: STYLE_INFO[s.style].label,
            rules: s.rules,
            coins: s.coins,
            // Official bees show their own portrait by name (names and art were once
            // swapped between slots, so style-keyed URLs show the wrong wolf).
            img: s.customImage && imagePath(cfg.settingsPath, id) ? `/bee-image/${id}` : s.fromSetup ? null : officialArt(s.name, s.style),
          };
        })
      : [],
  };
}

/** No Jev key in the environment and no Setup file yet: serve only the Setup page until the owner fills it in. */
function runSetup() {
  const env = process.env;
  const setup = new Setup({
    settingsPath: SETTINGS_PATH,
    jevModel: env.JEV_MODEL?.trim() || "jev-1.13.0",
    openai: { apiKey: env.OPENAI_API_KEY?.trim() || undefined, textModel: env.OPENAI_TEXT_MODEL?.trim() || "gpt-5.4-nano", imageModel: env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2" },
    refDir: REF_DIR,
    windowMin: Math.max(1, Number(env.SETUP_WINDOW_MIN) || 120),
    okxApiBase: env.OKX_API_BASE?.trim().replace(/\/+$/, "") || "https://eea.okx.com",
    onSaved: () => {
      log.info("settings saved; exiting so Docker restarts the engine with them");
      process.exit(0);
    },
  });
  const port = Number(env.ENGINE_PORT) || 8080;
  startServer({ setup, profile: () => profile(null), beeImage: (b) => imagePath(SETTINGS_PATH, b) }, port, env.ENGINE_BIND?.trim() || "127.0.0.1");
  setup.announce();
}

async function main() {
  const settings = loadSettings(SETTINGS_PATH);
  // The Setup gate needs the key for the active reasoning backend (openrouter is interim until the TypeSafe key arrives).
  const setupBackend = (process.env.REASONING_BACKEND?.trim() || "jev").toLowerCase();
  const hasReasoningKey = setupBackend === "openrouter" ? !!process.env.OPENROUTER_API_KEY?.trim() : !!process.env.TYPESAFE_API_KEY?.trim();
  if (!settings && !hasReasoningKey) return runSetup();
  let cfg;
  try {
    cfg = loadConfig({ ...process.env, SETTINGS_PATH }, settings);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error("refusing to start", { reason: err.message });
      process.exit(1);
    }
    throw err;
  }
  setLogLevel(cfg.logLevel);
  log.info("beebots engine starting", { mode: cfg.mode, tickMs: cfg.tickMs, dataRefreshMs: cfg.dataRefreshMs, reasoningBackend: cfg.reasoning.backend, jevModel: cfg.jev.model });

  const db = new Db(cfg.dbPath);
  const bus = new EventBus(db);
  const alerts = new Alerts(cfg.alertWebhookUrl);
  const cli = createOkxCli({ site: cfg.okx.site, timeoutMs: cfg.okx.cliTimeoutMs });
  // Public market data runs in-process on the kit's REST client; the CLI (one child process per call) is kept for
  // the signed per-bee calls only.
  const api = createPublicApi(cfg.okx.apiBase, cfg.mode === "demo", createOkxPublicRest({ apiBase: cfg.okx.apiBase, timeoutMs: cfg.okx.cliTimeoutMs }));
  const demo = cfg.mode === "demo";

  let engine: Engine | null = null;
  const held = () => (engine ? BEES.map((id) => engine!.bees[id]?.position?.instId).filter((x): x is string => !!x) : []);
  // News needs a key: borrow the first Momentum bee's (demo/live only).
  const newsCreds = BEES.filter((b) => cfg.slots[b].style === "boozy").map((b) => cfg.creds[b]).find((c) => !!c);
  const news = cfg.mode !== "dry" && newsCreds ? createNewsSource(cli, newsCreds, demo) : null;
  const feed = new MarketFeed(
    api,
    {
      min24hVolUsd: cfg.universe.min24hVolUsd,
      allowNonCrypto: cfg.universe.allowNonCrypto,
      spreadGateBps: Math.max(...STYLES.map((s) => cfg.bees[s].spreadGateBps)),
      trendCoins: [...BREEZY_COINS],
    },
    news,
    held,
  );

  const exec: Executor =
    cfg.mode === "dry"
      ? new SimExecutor(() => feed.view(), cfg.risk.takerFeeRate)
      : cfg.mode === "paper"
        ? new AlpacaExecutor(cfg.paper.baseUrl, cfg.alpCreds, (id) => feed.view().instruments.get(id), () => feed.view().instruments)
        : new OkxExecutor(cli, cfg.creds, demo, (id) => feed.view().instruments.get(id), cfg.risk.maxLeverage);

  const startOfDay = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const jevOpts = { ...cfg.jev, spentTodayUsd: db.jevSpendSince(startOfDay) };
  // Interim backend: OpenRouter answers through the same Jev class (caps, backoff, fail-closed unchanged).
  // Per-decision r.model records the active model, so attribution distinguishes the backends.
  const jev =
    cfg.reasoning.backend === "openrouter"
      ? new Jev({ ...jevOpts, client: new OpenRouterSystemOne({ apiKey: cfg.jev.apiKey, model: cfg.jev.model, timeoutMs: cfg.jev.timeoutMs }) })
      : new Jev(jevOpts);

  // `deploy/close.sh` drops this file into the data volume to end the experiment cleanly (see Engine.windDown).
  const closeFlag = join(dirname(cfg.dbPath), `close-${cfg.mode}`);
  // Dry run only: `resume-last-dry` puts benched, flat bees back into their last position (consumed on use).
  const resumeFlag = join(dirname(cfg.dbPath), `resume-last-${cfg.mode}`);
  const takeResumeRequest = () => {
    if (cfg.mode !== "dry" || !existsSync(resumeFlag)) return false;
    unlinkSync(resumeFlag);
    return true;
  };
  engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts, closeRequested: () => existsSync(closeFlag), takeResumeRequest });
  await engine.start();

  // The owner password (picked on Setup) gates joining and leaving the Hive from the dashboard. Installs without one
  // (a Setup file from before it existed, or keys only in .env) can set OWNER_PASSWORD instead.
  const envPassword = process.env.OWNER_PASSWORD ?? "";
  if (envPassword && envPassword.length < MIN_PASSWORD) log.warn(`OWNER_PASSWORD is ignored: it needs at least ${MIN_PASSWORD} characters`);
  const ownerPasswordHash = settings?.ownerPasswordHash ?? (envPassword.length >= MIN_PASSWORD ? hashPassword(envPassword) : null);

  // The Hive (opt-in public leaderboard, paper only).
  const hive = new Hive({
    ownerPasswordHash: () => ownerPasswordHash,
    path: hivePath(cfg.settingsPath),
    url: cfg.hive.url,
    mode: cfg.mode,
    db,
    portrait: (slot) => (cfg.slots[slot as keyof typeof cfg.slots]?.customImage ? imagePath(cfg.settingsPath, slot) : null),
    source: () => {
      const snap = engine!.snapshot();
      return {
        startedAt: snap.startedAt,
        startEquityUsd: snap.startEquityUsd,
        bees: snap.bees.map((b) => {
          const s = cfg.slots[b.bee];
          return { slot: b.bee, name: s.name, style: s.style, tagline: s.tagline, rules: s.rules, coins: s.coins, equityUsd: b.equityUsd, fundingUsd: b.totals.fundingUsd, cap: b.cap, tradesToday: b.tradesToday };
        }),
      };
    },
  });
  hive.start(settings);

  // "Update available" on the dashboard (checks GitHub Releases; never installs anything).
  const updates = new UpdateCheck({ repo: cfg.update.repo, current: cfg.update.version, enabled: cfg.update.enabled });
  updates.start();

  const server = startServer(
    {
      engine: { bus, db, visitors: new Visitors(db), snapshot: () => engine!.snapshot(), health: () => engine!.health(), update: () => updates.status() },
      hive,
      profile: () => profile(cfg),
      beeImage: (b) => (cfg.slots[b as keyof typeof cfg.slots]?.customImage ? imagePath(cfg.settingsPath, b) : null),
    },
    cfg.server.port,
    cfg.server.bind,
  );

  const shutdown = (sig: string) => {
    log.info("shutting down", { sig });
    engine?.stop();
    hive.stop();
    updates.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { err: safeError(err) });
  process.exit(1);
});
