#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// reddit-scan.js — Find product opportunities from real pain points
// Sources: Hacker News, Stack Exchange, and (optionally) GitHub Issues.
// Reddit's unauthenticated endpoints are blocked as of 2026 — see README notes.
// Requires: Node 18+  |  ANTHROPIC_API_KEY env var  |  optional GITHUB_TOKEN
//
// Usage:
//   node reddit-scan.js
//   node reddit-scan.js --topic "web accessibility"
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
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!ANTHROPIC_API_KEY) {
  console.error("\n❌  Set ANTHROPIC_API_KEY in a .env file or environment variable first.\n");
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────

// Stack Exchange sites (subdomain form, no ".stackexchange.com")
// stackoverflow deliberately excluded — it's Q&A about writing code, not "does a tool for X exist"
const SE_SITES = ["softwarerecs", "webapps", "superuser", "workplace", "ux"];

// Discourse-powered community forums — /search.json is a built-in, documented
// feature of the Discourse platform (not scraping), verified reachable below.
const DISCOURSE_FORUMS = [
  "https://community.n8n.io",            // automation
  "https://forum.bubble.io",             // no-code
  "https://community.home-assistant.io", // self-hosted / smart home
  "https://discuss.python.org",          // dev / data
  "https://community.retool.com",        // internal tools / no-code
  "https://forum.freecodecamp.org",      // dev learning / career
  "https://community.latenode.com",      // automation
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

const aiNoise = /\b(chatgpt|gpt-?[0-9]|llm|claude|gemini|copilot|ai tool|ai can|using ai|with ai|openai|midjourney|stable diffusion|dall-?e)\b/i;

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

// ── Shared fetch helper (handles 429 with backoff) ──────────────────────────────

async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, opts);
    if (res.status === 429) {
      if (attempt === retries) throw new Error(`Rate limited (429) after ${retries} retries`);
      const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt * 2;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
}

function decodeHTML(str) {
  if (!str) return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripHTML(str) {
  return decodeHTML((str || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// ── Hacker News (Algolia Search API — public, no auth) ──────────────────────────

async function fetchHN(query, limit = 25) {
  const params = new URLSearchParams({ query, hitsPerPage: String(limit) });
  const data = await fetchWithRetry(`https://hn.algolia.com/api/v1/search?${params}`);

  return (data.hits || []).map(h => {
    const isComment = !!h.comment_text;
    return {
      title:    isComment ? (h.story_title || "(HN comment)") : (h.title || h.story_title || ""),
      score:    h.points || 0,
      comments: h.num_comments || 0,
      sub:      "Hacker News",
      url:      h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      body:     stripHTML(isComment ? h.comment_text : h.story_text).slice(0, 300),
    };
  });
}

// ── Stack Exchange (public API, no auth needed for read) ────────────────────────

async function fetchStackExchange(site, query, limit = 20) {
  const params = new URLSearchParams({
    q: query, site, order: "desc", sort: "relevance", pagesize: String(limit), filter: "default",
  });
  const data = await fetchWithRetry(`https://api.stackexchange.com/2.3/search/advanced?${params}`);
  if (data.error_id) throw new Error(data.error_message || `error_id ${data.error_id}`);

  const posts = (data.items || []).map(it => ({
    title:    decodeHTML(it.title || ""),
    score:    it.score || 0,
    comments: it.answer_count || 0,
    sub:      site,
    url:      it.link,
    body:     "",
  }));

  return { posts, quotaRemaining: data.quota_remaining, backoff: data.backoff };
}

// ── Discourse forums (built-in /search.json — public, no auth) ──────────────────

async function fetchDiscourse(forumBase, query, limit = 20) {
  const params = new URLSearchParams({ q: query });
  const data = await fetchWithRetry(`${forumBase}/search.json?${params}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; signal-scanner/1.0)" },
  });

  const posts  = data.posts  || [];
  const topics = data.topics || [];
  const n = Math.min(posts.length, topics.length, limit);
  const host = new URL(forumBase).hostname;

  const out = [];
  for (let i = 0; i < n; i++) {
    const t = topics[i], p = posts[i];
    if (!t || !p) continue;
    out.push({
      title:    t.title || "",
      score:    p.like_count || 0,
      comments: t.reply_count || 0,
      sub:      host,
      url:      `${forumBase}/t/${t.slug}/${t.id}`,
      body:     stripHTML(p.blurb).slice(0, 300),
    });
  }
  return out;
}

// ── GitHub Issues (optional — only runs if GITHUB_TOKEN is set) ─────────────────

async function fetchGitHubIssues(query, limit = 15) {
  const params = new URLSearchParams({
    q: `${query} in:title,body is:issue`, sort: "reactions", order: "desc", per_page: String(limit),
  });
  const data = await fetchWithRetry(`https://api.github.com/search/issues?${params}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });

  return (data.items || []).map(it => ({
    title:    it.title || "",
    score:    it.reactions?.total_count || 0,
    comments: it.comments || 0,
    sub:      (it.repository_url || "").split("/").slice(-2).join("/") || "GitHub",
    url:      it.html_url,
    body:     stripHTML(it.body).slice(0, 300),
  }));
}

// ── Gather + merge ────────────────────────────────────────────────────────────

async function gatherPosts(topicHint) {
  const allPosts = [];
  const seen     = new Set();

  const add = posts => {
    let n = 0;
    for (const p of posts) {
      if (p.url && p.title && p.title.length > 15 && !seen.has(p.url) && !aiNoise.test(p.title)) {
        seen.add(p.url);
        allPosts.push(p);
        n++;
      }
    }
    return n;
  };

  const hnQueries = topicHint
    ? [`${topicHint} problem`, `${topicHint} wish there was`, `${topicHint} frustrated`, `${topicHint} looking for tool`]
    : PAIN_QUERIES;
  const seQueries = hnQueries.slice(0, 3);

  // Hacker News
  for (const q of hnQueries) {
    info(`Hacker News ← "${q}"`);
    try {
      add(await fetchHN(q));
    } catch (e) {
      warn(`Hacker News skipped: ${e.message}`);
    }
    await sleep(800);
  }

  // Stack Exchange
  let seQuotaLow = false;
  seLoop: for (const site of SE_SITES) {
    if (seQuotaLow) break;
    for (const q of seQueries) {
      info(`${site}.stackexchange ← "${q}"`);
      try {
        const { posts, quotaRemaining, backoff } = await fetchStackExchange(site, q);
        add(posts);
        if (backoff) await sleep(backoff * 1000);
        if (quotaRemaining !== undefined && quotaRemaining < 5) {
          warn("Stack Exchange daily quota nearly exhausted — stopping Stack Exchange fetches");
          seQuotaLow = true;
          break seLoop;
        }
      } catch (e) {
        warn(`${site} skipped: ${e.message}`);
      }
      await sleep(1200);
    }
  }

  // Discourse forums
  for (const forum of DISCOURSE_FORUMS) {
    const host = new URL(forum).hostname;
    for (const q of seQueries) {
      info(`${host} ← "${q}"`);
      try {
        add(await fetchDiscourse(forum, q));
      } catch (e) {
        warn(`${host} skipped: ${e.message}`);
      }
      await sleep(1200);
    }
  }

  // GitHub Issues (optional)
  if (GITHUB_TOKEN) {
    for (const q of seQueries) {
      info(`GitHub issues ← "${q}"`);
      try {
        add(await fetchGitHubIssues(q));
      } catch (e) {
        warn(`GitHub skipped: ${e.message}`);
      }
      await sleep(2500);
    }
  } else {
    info("Skipping GitHub Issues — set GITHUB_TOKEN in .env to include this source");
  }

  ok(`Collected ${allPosts.length} unique posts`);

  return allPosts.sort((a, b) => (b.score + b.comments * 3) - (a.score + a.comments * 3));
}

// Raw score/comment scales differ wildly by platform (HN points run 10-100x
// higher than Discourse likes or SE scores), so a flat top-N slice would let
// one source crowd out everyone else. Cap posts per source instead.
function diversify(posts, perSourceCap = 5, total = 60) {
  const perSource = new Map();
  const pool = [];
  for (const p of posts) {
    const n = perSource.get(p.sub) || 0;
    if (n >= perSourceCap) continue;
    perSource.set(p.sub, n + 1);
    pool.push(p);
    if (pool.length >= total) break;
  }
  return pool;
}

// ── Claude API ────────────────────────────────────────────────────────────────

async function claudeJSON(system, user, retries = 2) {
  let res, data;
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await fetch("https://api.anthropic.com/v1/messages", {
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

    if (res.status === 429 || res.status === 529) {
      if (attempt === retries) break;
      await sleep((2 ** attempt) * 2000);
      continue;
    }
    break;
  }

  data = await res.json();
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${data.error?.message || JSON.stringify(data)}`);

  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
  const clean = text.replace(/^```json\s*/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  const s = clean.indexOf("["), e = clean.lastIndexOf("]");
  if (s === -1) throw new Error("Claude didn't return a JSON array.\n\nGot:\n" + clean.slice(0, 400));
  return JSON.parse(clean.slice(s, e + 1));
}

async function analyseThemes(posts) {
  const postList = posts.slice(0, 60).map((p, i) =>
    `[${i + 1}] ${p.sub} ↑${p.score} 💬${p.comments}\n"${p.title}"${p.body ? `\n${p.body.slice(0, 150)}` : ""}`
  ).join("\n\n");

  return claudeJSON(
    `You are a product market researcher. You receive real posts from tech/business communities (Hacker News, Stack Exchange, GitHub Issues) and identify recurring pain point themes. Return ONLY a raw JSON array. No markdown fences, no preamble.`,
    `Here are ${posts.slice(0, 60).length} real posts found by searching for pain-point language:

${postList}

Identify 6-8 distinct product opportunity themes. For each theme include the post numbers that support it.

Return ONLY this JSON array:
[
  {
    "id": 1,
    "topic": "Theme title (4-6 words)",
    "summary": "One sentence: the core pain people feel",
    "sources": ["Hacker News", "softwarerecs"],
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
    `• ${p.sub} ↑${p.score} 💬${p.comments} | "${p.title}" | ${p.url}`
  ).join("\n");

  return claudeJSON(
    `You are a product market researcher turning real pain points into buildable product ideas. Return ONLY a raw JSON array. No markdown fences, no preamble.`,
    `Topic: "${theme.topic}"
Pain: ${theme.summary}

Supporting posts:
${postList}

Generate 5 specific, buildable product opportunities from these real posts.

Return ONLY this JSON array:
[
  {
    "id": 1,
    "title": "Problem title (max 8 words)",
    "problem": "2-3 sentences describing the pain",
    "source": "most relevant source, e.g. Hacker News or softwarerecs",
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
    log(`      ${cc(`[${t.category}]`)}  ${dim(t.sources?.join(" · ") || "")}`);
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
    log(`      ${dim(o.source)}  ·  Demand: ${bar(o.demand_score, 10, 12)} ${scoreColor(o.demand_score)}  ·  Build effort: ${effortColor(o.build_effort || "?")}`);
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
    log(`     ${dim(`${p.sub}  →  ${p.url}`)}`);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  log(`\n${org("█")} ${bold("SIGNAL SCANNER")}`);
  log(`${dim("  Finds real product opportunities from pain points across Hacker News, Stack Exchange & GitHub")}\n`);

  if (TOPIC_ARG) {
    log(`${cyn(`  Topic filter: "${TOPIC_ARG}"`)}\n`);
  }

  // Step 1: gather posts
  section("STEP 1 — FETCHING POSTS");
  const posts = await gatherPosts(TOPIC_ARG);

  if (posts.length < 5) {
    log(red("\n  Too few posts returned. Try again in a moment, or broaden --topic.\n"));
    process.exit(1);
  }

  printTopPosts(posts);

  // Build a source-balanced pool so one loud source (e.g. Hacker News' point
  // scale) can't crowd out the others — same pool is used for numbering AND
  // for resolving post_indices back to posts, so they must stay in sync.
  const pool = diversify(posts);

  // Step 2: analyse themes
  section("STEP 2 — CLUSTERING INTO THEMES (Claude)");
  info(`Sending ${pool.length} source-balanced posts to Claude for analysis…`);
  const themes = await analyseThemes(pool);
  ok(`Found ${themes.length} themes`);
  themes.sort((a, b) => b.signal_strength - a.signal_strength);
  printThemes(themes);

  // Step 3: drill top 3 themes
  section("STEP 3 — DRILLING TOP 3 THEMES FOR PRODUCT IDEAS");

  for (const theme of themes.slice(0, 3)) {
    info(`Drilling: "${theme.topic}"…`);
    try {
      const opps = await drillTheme(theme, pool);
      opps.sort((a, b) => b.demand_score - a.demand_score);
      printOpportunities(theme, opps);
    } catch (e) {
      warn(`Failed to drill "${theme.topic}": ${e.message}`);
    }
    await sleep(500);
  }

  section("DONE");
  log(`  ${grn("✓")} Scan complete. ${dim(`${posts.length} posts analysed across Hacker News, ${SE_SITES.length} Stack Exchange communities, ${DISCOURSE_FORUMS.length} forums${GITHUB_TOKEN ? ", and GitHub Issues" : ""}.`)}`);
  log(`  ${dim("Run again for fresh results — signal changes daily.")}\n`);
}

main().catch(e => {
  console.error(`\n${red("Fatal error:")} ${e.message}\n`);
  process.exit(1);
});
