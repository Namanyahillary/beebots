// Single brand configuration for Wolfbots.
// Every user-facing UI string, palette token, and mascot noun reads from here.

export const BRAND = {
  appName: "Wolfbots",
  tagline: "three AI wolves hunting live",
  extendedTagline: "Three AI wolves hunting live on OKX X-Perps",
  description:
    "Three AI trading wolves, one decision model, paper trading on OKX X-Perps. Every decision, order, fee and funding payment, live. Not financial advice.",

  mascot: {
    singular: "wolf",
    plural: "wolves",
    collective: "pack",
    emoji: "🐺",
  },

  palette: {
    page: "#050907",
    card: "#0d1512",
    card2: "#141f1a",
    line: "rgba(200, 220, 215, 0.08)",
    text: "#e6edf3",
    text2: "#b0bac5",
    muted: "#687782",
    grid: "#16201b",
    axis: "#2d3b34",
    mutedBar: "#27352e",

    // Accent roles: green for gains, red for losses (conventional market semantics)
    good: "#16a34a",
    goodText: "#4ade80",
    warning: "#eab308",
    critical: "#b91c1c",
    criticalText: "#ff5555",

    // Wolf slot colors (tactical predator identities: amber stalker, frost alpha, crimson chaser)
    slot1: "#d97706",
    slot1Glow: "rgba(217, 119, 6, 0.45)",
    slot2: "#94a3b8",
    slot2Glow: "rgba(148, 163, 184, 0.45)",
    slot3: "#dc2626",
    slot3Glow: "rgba(220, 38, 38, 0.45)",
    slot4: "#8b5cf6",
    slot4Glow: "rgba(139, 92, 246, 0.45)",
  },

  /** Fragment for OpenAI image generator to create wolf character portraits in matching style */
  portraitPromptFragment:
    "a majestic 3D animated stylized wolf with intense expressive amber eyes, thick dark fur with silver highlights, disciplined predator poise, one or two character props, dramatic rim lighting and a dark misty forest background with glowing ember particles, square head-and-shoulders framing. It must be a different wolf from the references, clearly part of the same pack. No text, no letters, no logos.",

  defaultWolves: {
    bee1: {
      name: "Grim",
      tagline: "the patient stalker",
      styleLabel: "Breakout",
      blurb: "One volatility breakout a day on BTC, ETH, SOL or HYPE, ridden to the daily close. Sits in silence, then strikes at full size.",
      color: "var(--bizzy)",
      glow: "var(--bizzy-glow)",
      img: "/bees/grim.jpg",
    },
    bee2: {
      name: "Silver",
      tagline: "the alpha tracker",
      styleLabel: "Trend",
      blurb: "Trend following on BTC and ETH only. Few trades, rides winners, sized by volatility. Calm and unshakeable.",
      color: "var(--breezy)",
      glow: "var(--breezy-glow)",
      img: "/bees/silver.jpg",
    },
    bee3: {
      name: "Blaze",
      tagline: "the relentless chaser",
      styleLabel: "Momentum",
      blurb: "Chases the strongest 7-day mover across every liquid coin, and pyramids into winners. Fast and aggressive.",
      color: "var(--boozy)",
      glow: "var(--boozy-glow)",
      img: "/bees/blaze.jpg",
    },
    bee4: {
      name: "Dash",
      tagline: "the quick one",
      styleLabel: "Scalp",
      blurb: "Fast day-trader: fishes the 15-60 minute micro-breakout on BTC, ETH and SOL. Small, frequent, out fast.",
      color: "var(--scalpy)",
      glow: "var(--scalpy-glow)",
      img: "/bees/scalpy.jpg",
    },
  },

  hive: {
    buttonLabel: "🐺 Join the Pack",
    joinedLabel: "In the Pack ✓",
    title: "Join the Pack",
    joinedTitle: "In the Pack ✓",
    seeBoard: "See the pack on",
    paperOnlyNotice: "The Pack leaderboard is for paper trading only. This engine runs with real money, so it can't join.",
    disclaimer:
      "You're about to share your wolves' names, styles and paper-trading results on the public leaderboard at beebots.tech. The board shows % gain/loss only. No keys, no exchange account details, no IP address. Paper trading only. Not financial advice. You can leave any time.",
  },

  setup: {
    steps: ["The rules", "Password", "Jev", "OpenAI", "Your wolves", "The Pack", "Start"] as const,
    title: "Wolfbots setup",
    rulesTitle: "Before anything else",
    rulesIntro: "Wolfbots is an experiment and a piece of open-source software, not a trading product. Tick all three to carry on.",
    notAdvice: "Nothing the wolves do, and nothing in the video or the code, is a recommendation to buy or sell anything.",
    paperDefault: "My wolves trade on paper. They use real market prices and simulated money. Nothing touches an exchange account unless I change the server settings myself, on purpose.",
    ownRisk: "I use it at my own risk. The software comes with no warranty (MIT licence). Leveraged crypto trading can lose everything you put in, and if I ever switch it to real money, that's on me.",
    passwordTitle: "Pick an owner password",
    passwordP: "Your dashboard is public, so anything you change from it later (like joining or leaving the Pack board) asks for this password. Pick one only you know, at least 8 characters. The server keeps only a scrambled (hashed) copy, so write it down: to reset it, run Setup again (see the README).",
    openaiP: "Required. OpenAI designs each wolf's trading style from a sentence you write, and paints its portrait. A design is one quick, cheap ChatGPT call; a portrait takes about 40 seconds and a few cents. The key is only used on this page.",
    raiseTitle: "Raise your three wolves",
    raiseIntro: "Three wolves hunt side by side as a disciplined pack. For each one, say how you want it to hunt. OpenAI turns that into a name, a set of rules and the coins it may stalk, then you paint its portrait.",
    raiseAskLabel: "How do you want this wolf to trade?",
    createBtn: "Summon my wolf",
    createAgainBtn: "Summon again",
    paintBtn: "Generate your wolf's portrait",
    paintAgainBtn: "Repaint portrait",
    hintReady: "Create all three wolves and paint their portraits to carry on.",
    examples: [
      "a dark shadow wolf that only stalks bitcoin breakouts",
      "a calm alpha wolf that rides high-conviction trends on ETH and BTC",
      "an aggressive momentum predator that chases the hottest gainer of the week",
    ],
    hiveTitle: "Join the Pack board?",
    hiveIntro: "The Pack is a public leaderboard of everyone's wolves at beebots.tech. Your wolves hunt alongside everyone else's, and each fill is verified against OKX's public prices.",
    startingTitle: "Rallying your pack 🐺",
    startingP: "Saved. The engine is restarting in paper trading. This page opens the dashboard as soon as it's back, usually within a minute.",
    readySummary: "Each wolf starts with $333 of paper money, and trades OKX perpetuals at real prices. The engine saves your settings, restarts, and opens the live dashboard. The setup page then closes for good. To run it again later, see the README.",
    readyHiveOn: "Your wolves join the Pack board when the engine starts. You can leave any time from the dashboard.",
    readyHiveOff: "Your wolves stay off the Pack board. You can join later from the dashboard.",
  },
} as const;
