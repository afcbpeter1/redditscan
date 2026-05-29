#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// reddit-scan.js — Find product opportunities from real Reddit pain points
// Requires: Node 18+  |  ANTHROPIC_API_KEY env var
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node reddit-scan.js
//   ANTHROPIC_API_KEY=sk-ant-... node reddit-scan.js --topic "web accessibility"
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { resolve } from "path";

try {
  const env = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  for (const line of env.split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
} catch {}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("\n❌  Set ANTHROPIC_API_KEY in a .env file or environment variable first.\n");
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────

const SUBREDDITS = [
  // core startup / builder communities
  "entrepreneur", "SaaS",

  // dev & technical
  "webdev", "devops", "selfhosted",

  // work & business ops
  "productivity", "smallbusiness", "freelance", "consulting",
  "projectmanagement", "remotework", "sales", "recruiting",

  // marketing & growth
  "marketing", "SEO", "socialmediamarketing", "ecommerce", "shopify",

  // data & tools
  "nocode", "automation", "datascience", "excel",

  // niche high-signal verticals
  "digitalnomad", "accounting", "PropertyManagement", "realestateinvesting",
];

const PAIN_QUERIES = [
  "is there a tool that",
  "I wish there was",
  "frustrated with",
  "why is there no",
  "looking for something that",
  "does anyone know a way to",
  "wish someone would build",
  "hate how",
];

const TOPIC_ARG = process.argv.find((a, i) => process.argv[i - 1] === "--topic");

// ── Terminal colours (no deps) ────────────────────────────────────────────────

const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  cyan:   "\x1b[36m",
  white:  "\x1b[37m",
  orange: "\x1b[38;5;208m",
};

const fmt = (color, str) => `${color}${str}${c.reset}`;
const bold = str => fmt(c.bold, str);
const dim  = str => fmt(c.dim, str);
const grn  = str => fmt(c.green, str);
const yel  = str => fmt(c.yellow, str);
const red  = str => fmt(c.red, str);
const cyn  = str => fmt(c.cyan, str);
const org  = str => fmt(c.orange, str);

function scoreColor(n) {
  if (n >= 7) return grn(`${n}/10 ▓▓▓ HIGH`);
  if (n >= 4) return yel(`${n}/10 ▓▓░ MED`);
  return red(`${n}/10 ▓░░ LOW`);
}

function bar(n, max = 10, width = 20) {
  const filled = Math.round((n / max) * width);
  const empty  = width - filled;
  const color  = n >= 7 ? c.green : n >= 4 ? c.yellow : c.red;
  return `${color}${"█".repeat(filled)}${c.dim}${"░".repeat(empty)}${c.reset}`;
}

function log(msg)  { console.log(msg); }
function info(msg) { console.log(dim(`  › ${msg}`)); }
function ok(msg)   { console.log(grn(`  ✓ ${msg}`)); }
function warn(msg) { console.log(yel(`  ⚠ ${msg}`)); }
function section(title) {
  console.log(`\n${org("━".repeat(60))}`);
  console.log(bold(org(` ${title}`)));
  console.log(org("━".repeat(60)));
}

// ── Reddit API ────────────────────────────────────────────────────────────────

async function fetchRedditPosts(subreddit, query, limit = 20) {
  const params = new URLSearchParams({
    q: query,
    restrict_sr: "1",
    sort: "relevance",
    t: "year",
    limit: String(limit),
  });
  const url = `https://www.reddit.com/r/${subreddit}/search.json?${params}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Accept": "application/json",
    },
  });

  if (res.status === 429) throw new Error("Rate limited by Reddit — wait a moment and retry");
  if (!res.ok) throw new Error(`Reddit returned ${res.status} for r/${subreddit}`);

  const data = await res.json();
  return (data?.data?.children || []).map(c => ({
    title:    c.data.title,
    score:    c.data.score,
    comments: c.data.num_comments,
    sub:      c.data.subreddit,
    url:      `https://reddit.com${c.data.permalink}`,
    body:     (c.data.selftext || "").slice(0, 300).replace(/\n/g, " "),
  }));
}

async function gatherPosts(topicHint) {
  const allPosts = [];
  const seen     = new Set();

  let subs    = SUBREDDITS;
  let queries = PAIN_QUERIES;

  if (topicHint) {
    queries = [`${topicHint} problem`, `${topicHint} wish there was`, `${topicHint} frustrated`, `${topicHint} looking for tool`];
    subs    = SUBREDDITS.slice(0, 6);
  }

  let total = 0;

  for (const sub of subs) {
    for (const q of queries.slice(0, 3)) {
      info(`r/${sub} ← "${q}"`);
      try {
        const posts = await fetchRedditPosts(sub, q, 15);
        for (const p of posts) {
          const aiNoise = /\b(chatgpt|gpt-?[0-9]|llm|claude|gemini|copilot|ai tool|ai can|using ai|with ai|openai|midjourney|stable diffusion|dall-?e)\b/i;
          if (!seen.has(p.url) && p.title.length > 20 && !aiNoise.test(p.title)) {
            seen.add(p.url);
            allPosts.push(p);
            total++;
          }
        }
        await sleep(4000 + Math.random() * 3000); // 4–7s random delay, looks human
      } catch (e) {
        warn(`Skipped r/${sub}: ${e.message}`);
      }
    }
  }

  ok(`Collected ${total} unique posts`);

  // Sort by engagement
  return allPosts.sort((a, b) => (b.score + b.comments * 3) - (a.score + a.comments * 3));
}

// ── Claude API ────────────────────────────────────────────────────────────────

async function claudeJSON(system, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "x-api-key":     ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-opus-4-5",
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${data.error?.message || JSON.stringify(data)}`);

  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
  const clean = text.replace(/^```json\s*/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  const s = clean.indexOf("["), e = clean.lastIndexOf("]");
  if (s === -1) throw new Error("Claude didn't return a JSON array.\n\nGot:\n" + clean.slice(0, 400));
  return JSON.parse(clean.slice(s, e + 1));
}

async function analyseThemes(posts) {
  const postList = posts.slice(0, 60).map((p, i) =>
    `[${i + 1}] r/${p.sub} ↑${p.score} 💬${p.comments}\n"${p.title}"${p.body ? `\n${p.body.slice(0, 150)}` : ""}`
  ).join("\n\n");

  return claudeJSON(
    `You are a product market researcher. You receive real Reddit posts and identify recurring pain point themes. Return ONLY a raw JSON array. No markdown fences, no preamble.`,
    `Here are ${posts.slice(0, 60).length} real Reddit posts found by searching for pain-point language:

${postList}

Identify 6-8 distinct product opportunity themes. For each theme include the post numbers that support it.

Return ONLY this JSON array:
[
  {
    "id": 1,
    "topic": "Theme title (4-6 words)",
    "summary": "One sentence: the core pain people feel",
    "subreddits": ["r/example"],
    "signal_strength": 8,
    "signal_reason": "Why demand is high",
    "post_indices": [1, 4, 7, 12],
    "category": "productivity",
    "example_post": "Paraphrased title of the strongest post you found"
  }
]

category must be one of: productivity | dev-tools | marketing | finance | automation | design | hiring | other

RETURN ONLY THE JSON ARRAY.`
  );
}

async function drillTheme(theme, posts) {
  const relevant = (theme.post_indices || [])
    .map(i => posts[i - 1]).filter(Boolean);
  const pool = relevant.length >= 3 ? relevant : posts.slice(0, 25);

  const postList = pool.map(p =>
    `• r/${p.sub} ↑${p.score} 💬${p.comments} | "${p.title}" | ${p.url}`
  ).join("\n");

  return claudeJSON(
    `You are a product market researcher turning Reddit pain points into buildable product ideas. Return ONLY a raw JSON array. No markdown fences, no preamble.`,
    `Topic: "${theme.topic}"
Pain: ${theme.summary}

Supporting Reddit posts:
${postList}

Generate 5 specific, buildable product opportunities from these real posts.

Return ONLY this JSON array:
[
  {
    "id": 1,
    "title": "Problem title (max 8 words)",
    "problem": "2-3 sentences describing the pain",
    "subreddit": "r/most_relevant",
    "demand_score": 8,
    "demand_reason": "Why demand is strong",
    "product_angle": "Specific product or feature that solves this — be concrete",
    "quote": "Paraphrased version of something from the actual posts above",
    "monetisation": "How you'd charge for this",
    "build_effort": "low | medium | high"
  }
]

RETURN ONLY THE JSON ARRAY.`
  );
}

// ── Output formatting ─────────────────────────────────────────────────────────

function printThemes(themes) {
  section(`PAIN POINT THEMES (${themes.length} found)`);
  themes.forEach((t, i) => {
    const cc = {
      productivity: cyn, "dev-tools": grn, marketing: str => fmt(c.blue, str),
      finance: yel, automation: cyn, design: org, hiring: str => fmt("\x1b[35m", str), other: dim,
    }[t.category] || dim;

    log(`\n  ${bold(`#${i + 1}`)}  ${bold(t.topic)}`);
    log(`      ${cc(`[${t.category}]`)}  ${dim(t.subreddits?.join(" · ") || "")}`);
    log(`      ${bar(t.signal_strength)} ${scoreColor(t.signal_strength)}`);
    log(`      ${t.summary}`);
    log(`      ${dim(t.signal_reason)}`);
    log(`      ${dim(`Supporting posts: ${(t.post_indices || []).length}`)}`);
  });
}

function printOpportunities(theme, opps) {
  section(`PRODUCT OPPORTUNITIES: "${theme.topic.toUpperCase()}"`);

  opps.forEach((o, i) => {
    const effortColor = o.build_effort === "low" ? grn : o.build_effort === "high" ? red : yel;

    log(`\n  ${bold(`#${i + 1}  ${o.title}`)}`);
    log(`      ${dim(o.subreddit)}  ·  Demand: ${bar(o.demand_score, 10, 12)} ${scoreColor(o.demand_score)}  ·  Build effort: ${effortColor(o.build_effort || "?")}`);
    log("");
    log(`      ${c.bold}Problem${c.reset}`);
    log(`      ${o.problem}`);
    log("");
    log(`      ${c.bold}Product angle${c.reset}`);
    log(`      ${grn(o.product_angle)}`);
    log("");
    log(`      ${c.bold}Monetisation${c.reset}`);
    log(`      ${yel(o.monetisation)}`);
    log("");
    log(`      ${c.bold}What they say${c.reset}`);
    log(`      ${dim(`"${o.quote}"`)}`);
    log(`      ${dim(`Why ${o.demand_score}/10: ${o.demand_reason}`)}`);
    log(`  ${dim("─".repeat(56))}`);
  });
}

function printTopPosts(posts) {
  section(`TOP POSTS BY ENGAGEMENT (showing 15)`);
  posts.slice(0, 15).forEach((p, i) => {
    log(`  ${dim(`${i + 1}.`)} ${bold(`↑${p.score}`)} ${dim(`💬${p.comments}`)}  ${p.title.slice(0, 80)}${p.title.length > 80 ? "…" : ""}`);
    log(`     ${dim(`r/${p.sub}  →  ${p.url}`)}`);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  log(`\n${org("█")} ${bold("REDDIT SIGNAL SCANNER")}`);
  log(`${dim("  Finds real product opportunities from Reddit pain points")}\n`);

  if (TOPIC_ARG) {
    log(`${cyn(`  Topic filter: "${TOPIC_ARG}"`)}\n`);
  }

  // Step 1: gather posts
  section("STEP 1 — FETCHING REDDIT POSTS");
  const posts = await gatherPosts(TOPIC_ARG);

  if (posts.length < 5) {
    log(red("\n  Too few posts returned. Reddit may be rate-limiting. Try again in a moment.\n"));
    process.exit(1);
  }

  printTopPosts(posts);

  // Step 2: analyse themes
  section("STEP 2 — CLUSTERING INTO THEMES (Claude)");
  info("Sending posts to Claude for analysis…");
  const themes = await analyseThemes(posts);
  ok(`Found ${themes.length} themes`);
  themes.sort((a, b) => b.signal_strength - a.signal_strength);
  printThemes(themes);

  // Step 3: drill top 3 themes
  section("STEP 3 — DRILLING TOP 3 THEMES FOR PRODUCT IDEAS");

  for (const theme of themes.slice(0, 3)) {
    info(`Drilling: "${theme.topic}"…`);
    try {
      const opps = await drillTheme(theme, posts);
      opps.sort((a, b) => b.demand_score - a.demand_score);
      printOpportunities(theme, opps);
    } catch (e) {
      warn(`Failed to drill "${theme.topic}": ${e.message}`);
    }
    await sleep(500);
  }

  section("DONE");
  log(`  ${grn("✓")} Scan complete. ${dim(`${posts.length} posts analysed across ${SUBREDDITS.length} subreddits.`)}`);
  log(`  ${dim("Run again for fresh results — Reddit data changes daily.")}\n`);
}

main().catch(e => {
  console.error(`\n${red("Fatal error:")} ${e.message}\n`);
  process.exit(1);
});
