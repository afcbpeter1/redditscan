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

import { readFileSync, writeFileSync, mkdirSync } from "fs";
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
// money/parenting/law/diy/expatriates added to widen the net beyond dev/SaaS —
// after four runs of tech-forum scanning kept surfacing already-solved or
// already-crowded categories, these reach non-technical pain (finance,
// household/family, bureaucracy, legal admin) via the exact same API, with
// no new infrastructure. (Non-tech community platforms with no comparable
// public API — Mumsnet, Netmums, UK Business Forums, TrustPilot reviews,
// app-store reviews — were evaluated and are not reachable this way: they
// either block non-browser requests outright or require a paid partner API.
// Reddit is deliberately excluded — see git history and README notes.)
const SE_SITES = ["softwarerecs", "webapps", "superuser", "workplace", "ux", "money", "parenting", "law", "diy", "expatriates"];

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
  "https://forum.obsidian.md",           // note-taking / productivity
  "https://community.make.com",          // automation
];

// Phrases that signal someone already searched and came up empty-handed —
// added after a review pass found the original PAIN_QUERIES surfaced mostly
// well-answered reference questions rather than genuinely unmet needs.
// Posts matching these get an EXPLICIT_GAP ranking boost (see gatherPosts).
const UNMET_NEED_QUERIES = [
  "tried everything and nothing",
  "closest thing I've found is",
  "everything out there sucks",
  "still doesn't exist",
  "nothing does this well",
  "gave up looking for",
  "settled for because nothing better",
];
const explicitGapRe = /\b(tried everything|closest (thing|option) i(?:'ve| have) found|still doesn'?t exist|nothing (does|works|solves|handles) this|gave up (looking|trying to find)|settled for (?:it )?because nothing)\b/i;

// Phrases correlating with actual willingness to pay, not just venting —
// per the follow-up review, this is a stronger buy-signal than raw frustration.
const commercialIntentRe = /\b(currently pay(?:ing)? for|we'?d (?:happily |gladly )?pay for|would (?:happily |gladly )?pay for|willing to pay|paying customer of|switched away from .+ because|costs (?:us|me) \d+\s*(?:hours?|hrs?)\s*(?:a|per|\/)\s*(?:week|month|day)|sick of paying)\b/i;

// Non-technical phrasing for the same underlying signals — added after four
// runs scanning only dev/SaaS forums kept re-discovering already-solved or
// already-crowded categories. Loud complaints on ANY forum tend to be already
// solved or contested; these queries aim outside the tech-forum pool.
const NONTECH_QUERIES = [
  "does anyone know how to actually",
  "why is it so hard to find someone who",
  "so sick of doing this by hand",
  "surely someone's built an app for this",
  "ended up just making my own spreadsheet for",
  "I've called four different",
];

// Someone who built their own workaround (a spreadsheet, a manual process, an
// internal script) has a validated problem AND has implicitly confirmed no
// product satisfies it — arguably a stronger "real gap" signal than any
// complaint language, since it's evidence of behavior, not just venting.
const workaroundRe = /\b(we (?:built|made|wrote) (?:our own|a) (?:script|tool|spreadsheet|macro)|i (?:built|made|wrote) (?:my own|a) (?:spreadsheet|script|tool|macro) (?:for|to)|maintain(?:ing)? a spreadsheet (?:for|because)|(?:just )?do(?:es)? (?:it|this) manually|ended up (?:just )?making (?:my|our) own|we do this (?:all )?manually|do it by hand every)\b/i;

// Announcement/changelog/release noise that isn't a pain signal but can carry
// high engagement (a big plugin release, a changelog) — dropped before it can
// contaminate clustering the way it did in an earlier run.
const announcementRe = /^\s*\[(new|updated?)\s+\w+\]|^(release notes|changelog|announcing|introducing)\b|\b(is now available|just released|proud to (announce|present))\b/i;

// How far back to prefer results from. Older SO/HN threads tend to be
// FAQ-tier questions that were already solved years ago — biasing toward
// recent activity surfaces gaps that are still open today.
const RECENT_MONTHS = 24;
const RECENT_SINCE_UNIX = Math.floor(Date.now() / 1000) - RECENT_MONTHS * 30 * 24 * 3600;

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

// Long runs scroll past a terminal's visible window (or its scrollback limit)
// before they finish — capture every console.log line here so the full run
// can always be saved to disk afterward, regardless of what the terminal
// still shows. Wraps console.log once, globally, rather than touching every
// helper above individually.
const logBuffer = [];
const stripAnsi = str => str.replace(/\x1b\[[0-9;]*m/g, "");
const rawConsoleLog = console.log.bind(console);
console.log = (...args) => {
  rawConsoleLog(...args);
  logBuffer.push(stripAnsi(args.map(String).join(" ")));
};

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

async function fetchHN(query, limit = 25, sinceUnix = null) {
  const params = new URLSearchParams({ query, hitsPerPage: String(limit) });
  if (sinceUnix) params.set("numericFilters", `created_at_i>${sinceUnix}`);
  const data = await fetchWithRetry(`https://hn.algolia.com/api/v1/search?${params}`);

  return (data.hits || []).map(h => {
    const isComment = !!h.comment_text;
    const body = stripHTML(isComment ? h.comment_text : h.story_text).slice(0, 300);
    return {
      title:    isComment ? (h.story_title || "(HN comment)") : (h.title || h.story_title || ""),
      score:    h.points || 0,
      comments: h.num_comments || 0,
      sub:      "Hacker News",
      url:      h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      body,
      explicitGap: explicitGapRe.test(body) || explicitGapRe.test(h.title || ""),
      commercialIntent: commercialIntentRe.test(body) || commercialIntentRe.test(h.title || ""),
      workaround: workaroundRe.test(body) || workaroundRe.test(h.title || ""),
    };
  });
}

// ── Stack Exchange (public API, no auth needed for read) ────────────────────────

async function fetchStackExchange(site, query, limit = 20, sinceUnix = null) {
  const params = new URLSearchParams({
    q: query, site, order: "desc", sort: "relevance", pagesize: String(limit), filter: "default",
  });
  if (sinceUnix) params.set("fromdate", String(sinceUnix));
  const data = await fetchWithRetry(`https://api.stackexchange.com/2.3/search/advanced?${params}`);
  if (data.error_id) throw new Error(data.error_message || `error_id ${data.error_id}`);

  const posts = (data.items || []).map(it => ({
    title:      decodeHTML(it.title || ""),
    score:      it.score || 0,
    comments:   it.answer_count || 0,
    sub:        site,
    url:        it.link,
    body:       "",
    // No accepted/settled answer, or only one contested answer — a proxy for
    // "this is still an open gap" rather than a solved reference question.
    unresolved: it.is_answered === false || (it.answer_count || 0) <= 1,
  }));

  return { posts, quotaRemaining: data.quota_remaining, backoff: data.backoff };
}

// ── Discourse forums (built-in /search.json — public, no auth) ──────────────────

async function fetchDiscourse(forumBase, query, limit = 20, sinceDate = null) {
  // Discourse's own search grammar supports "after:YYYY-MM-DD" inline in q —
  // there's no separate date param on this endpoint.
  const q = sinceDate ? `${query} after:${sinceDate}` : query;
  const params = new URLSearchParams({ q });
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
    const body = stripHTML(p.blurb).slice(0, 300);
    out.push({
      title:    t.title || "",
      score:    p.like_count || 0,
      comments: t.reply_count || 0,
      sub:      host,
      url:      `${forumBase}/t/${t.slug}/${t.id}`,
      body,
      explicitGap: explicitGapRe.test(body) || explicitGapRe.test(t.title || ""),
      commercialIntent: commercialIntentRe.test(body) || commercialIntentRe.test(t.title || ""),
      workaround: workaroundRe.test(body) || workaroundRe.test(t.title || ""),
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

  return (data.items || []).map(it => {
    const body = stripHTML(it.body).slice(0, 300);
    return {
      title:    it.title || "",
      score:    it.reactions?.total_count || 0,
      comments: it.comments || 0,
      sub:      (it.repository_url || "").split("/").slice(-2).join("/") || "GitHub",
      url:      it.html_url,
      body,
      explicitGap: explicitGapRe.test(body) || explicitGapRe.test(it.title || ""),
      commercialIntent: commercialIntentRe.test(body) || commercialIntentRe.test(it.title || ""),
      workaround: workaroundRe.test(body) || workaroundRe.test(it.title || ""),
    };
  });
}

// ── Gather + merge ────────────────────────────────────────────────────────────

async function gatherPosts(topicHint) {
  const allPosts = [];
  const seen     = new Set();

  const add = posts => {
    let n = 0;
    for (const p of posts) {
      if (p.url && p.title && p.title.length > 15 && !seen.has(p.url) && !aiNoise.test(p.title) && !announcementRe.test(p.title)) {
        // Also catch explicit "nothing works" / "would pay for" language in
        // bodies fetched without their own detection (e.g. Stack Exchange,
        // which has no body text, or Discourse posts predating this field).
        if (p.explicitGap === undefined) {
          p.explicitGap = explicitGapRe.test(p.body || "") || explicitGapRe.test(p.title || "");
        }
        if (p.commercialIntent === undefined) {
          p.commercialIntent = commercialIntentRe.test(p.body || "") || commercialIntentRe.test(p.title || "");
        }
        if (p.workaround === undefined) {
          p.workaround = workaroundRe.test(p.body || "") || workaroundRe.test(p.title || "");
        }
        seen.add(p.url);
        allPosts.push(p);
        n++;
      }
    }
    return n;
  };

  const hnQueries = topicHint
    ? [`${topicHint} problem`, `${topicHint} wish there was`, `${topicHint} frustrated`, `${topicHint} looking for tool`]
    : [...PAIN_QUERIES, ...UNMET_NEED_QUERIES, ...NONTECH_QUERIES];
  const seQueries = (topicHint ? hnQueries : [...PAIN_QUERIES.slice(0, 2), ...UNMET_NEED_QUERIES.slice(0, 2), ...NONTECH_QUERIES.slice(0, 2)]);

  const sinceDateStr = new Date(RECENT_SINCE_UNIX * 1000).toISOString().slice(0, 10);

  // Hacker News
  for (const q of hnQueries) {
    info(`Hacker News ← "${q}"`);
    try {
      add(await fetchHN(q, 25, RECENT_SINCE_UNIX));
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
        const { posts, quotaRemaining, backoff } = await fetchStackExchange(site, q, 20, RECENT_SINCE_UNIX);
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
        add(await fetchDiscourse(forum, q, 20, sinceDateStr));
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

  const unresolvedCount = allPosts.filter(p => p.unresolved).length;
  const explicitGapCount = allPosts.filter(p => p.explicitGap).length;
  const payCount = allPosts.filter(p => p.commercialIntent).length;
  const workaroundCount = allPosts.filter(p => p.workaround).length;
  ok(`Collected ${allPosts.length} unique posts (${unresolvedCount} unresolved, ${explicitGapCount} explicit-gap, ${payCount} willingness-to-pay, ${workaroundCount} workaround-built)`);

  // Base relevance is raw engagement, plus bonuses for signals that this is a
  // still-open, monetizable gap rather than a well-answered reference question.
  // Someone who built their own workaround (spreadsheet/script/manual process)
  // has proven the problem is real AND that nothing satisfies it — behavior,
  // not just venting — so it's weighted just under willingness-to-pay.
  const relevance = p => (p.score + p.comments * 3) + (p.unresolved ? 8 : 0) + (p.explicitGap ? 12 : 0) + (p.workaround ? 14 : 0) + (p.commercialIntent ? 15 : 0);
  return allPosts.sort((a, b) => relevance(b) - relevance(a));
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

// opts.tools / opts.model / opts.shape / opts.effort / opts.meta are optional
// extensions — omitted, every existing call site behaves exactly as before
// (array-shaped JSON from claude-opus-4-5, no tools, default effort, plain
// parsed-JSON return value).
async function claudeJSON(system, user, retries = 2, opts = {}) {
  const { tools = null, shape = "array", model = "claude-opus-4-5", effort = null, meta = false } = opts;
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
        model,
        max_tokens: 4000,
        system,
        messages: [{ role: "user", content: user }],
        ...(tools ? { tools } : {}),
        ...(effort ? { output_config: { effort } } : {}),
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
  const [open, close] = shape === "object" ? ["{", "}"] : ["[", "]"];
  const s = clean.indexOf(open), e = clean.lastIndexOf(close);
  if (s === -1) throw new Error(`Claude didn't return a JSON ${shape}.\n\nGot:\n` + clean.slice(0, 400));
  const parsed = JSON.parse(clean.slice(s, e + 1));
  return meta ? { result: parsed, content: data.content } : parsed;
}

async function analyseThemes(posts) {
  const postList = posts.slice(0, 60).map((p, i) => {
    const flags = [p.unresolved && "UNRESOLVED", p.explicitGap && "EXPLICIT-GAP", p.workaround && "WORKAROUND-BUILT", p.commercialIntent && "WOULD-PAY"].filter(Boolean).join(" ");
    return `[${i + 1}] ${p.sub} ↑${p.score} 💬${p.comments}${flags ? ` [${flags}]` : ""}\n"${p.title}"${p.body ? `\n${p.body.slice(0, 150)}` : ""}`;
  }).join("\n\n");

  return claudeJSON(
    `You are a product market researcher. You receive real posts from tech and non-technical communities (Hacker News, Stack Exchange incl. money/parenting/law/diy, GitHub Issues) and identify recurring pain point themes. Weight posts tagged UNRESOLVED (no accepted/settled answer) or EXPLICIT-GAP (someone said outright that nothing they found works) higher than plain high-score posts — those tags mean the need is still genuinely open, whereas an untagged high-score post is often just a well-answered reference question. Weight WORKAROUND-BUILT posts (someone built their own spreadsheet/script/manual process) highly — that's behavioral proof the problem is real and unsolved, not just venting. Weight WOULD-PAY tagged posts (explicit willingness-to-pay language, e.g. "currently paying for X and hate it", "we'd pay for") highest of all — it's the strongest predictor of a real buyer. Avoid surfacing themes that are really just "I forgot the syntax" or "how do I use X" questions with a known answer. Return ONLY a raw JSON array. No markdown fences, no preamble.`,
    `Here are ${posts.slice(0, 60).length} real posts found by searching for pain-point language:

${postList}

Identify 6-8 distinct product opportunity themes, prioritizing ones backed by WOULD-PAY, WORKAROUND-BUILT, UNRESOLVED, or EXPLICIT-GAP posts over ones backed only by high engagement. For each theme include the post numbers that support it.

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

  const postList = pool.map(p => {
    const flags = [p.unresolved && "UNRESOLVED", p.explicitGap && "EXPLICIT-GAP", p.workaround && "WORKAROUND-BUILT", p.commercialIntent && "WOULD-PAY"].filter(Boolean).join(" ");
    return `• ${p.sub} ↑${p.score} 💬${p.comments}${flags ? ` [${flags}]` : ""} | "${p.title}" | ${p.url}`;
  }).join("\n");

  return claudeJSON(
    `You are a product market researcher turning real pain points into buildable opportunities — not all of which are software. Return ONLY a raw JSON array. No markdown fences, no preamble.`,
    `Topic: "${theme.topic}"
Pain: ${theme.summary}

Supporting posts:
${postList}

Generate 5 specific, buildable opportunities from these real posts. Some gaps (especially outside dev/SaaS communities) are better solved by a directory, a matching/marketplace service, a calculator, or automating something currently done by phone calls and admin — not necessarily a piece of software a solo developer codes. Pick whichever product_type actually fits the pain.

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
    "product_type": "technical-saas | non-technical-ops",
    "quote": "Paraphrased version of something from the actual posts above",
    "monetisation": "How you'd charge for this",
    "build_effort": "low | medium | high"
  }
]

product_type: "technical-saas" for something a developer builds and ships as software; "non-technical-ops" for a directory, marketplace, matching service, or workflow that doesn't require deep engineering.

RETURN ONLY THE JSON ARRAY.`
  );
}

// Checks whether a theme has already been solved BEFORE it gets scored/drilled
// — added after a review found that every "high demand" theme in a prior run
// already had a live solution a single search would have caught (e.g. a
// workflow-monitoring theme that flowatch.xyz already solves). Someone posting
// about a pain point usually just means THEY personally haven't found a
// solution, not that one doesn't exist — so this asks the plain question
// ("has this been solved?") rather than counting competitors: even one real
// existing solution is enough to disqualify a theme, no "crowded market"
// threshold needed. Uses Anthropic's server-side web_search tool, which
// requires claude-opus-5 — claude-opus-4-5 (used elsewhere in this file)
// doesn't support it. effort:"low" + a small max_uses keep this cheap, since
// it's a quick lookup, not a hard reasoning task.
//
// A follow-up review of a real run found this check has a real false-positive
// mode: it was pattern-matching "a tool with this general description exists"
// rather than "an existing tool kills THIS specific complaint" — e.g. citing
// n8n's built-in error handling for a theme about SILENT failures that throw
// no error at all, or citing SmartThings/Google Home as solving Home
// Assistant's complexity when people choose HA specifically because those
// alternatives lack HA's power. The prompt below now asks explicitly for that
// distinction, and treats new/recent competitors launching for the same gap
// as evidence of live contested demand, not a solved problem.
async function checkCompetition(theme) {
  const { result, content } = await claudeJSON(
    `You are a skeptical market researcher whose job is to kill weak product ideas before anyone builds them — but you're equally skeptical of lazy category-matching. Someone posting about a pain point usually just means they personally haven't found a solution — not that one doesn't exist. Use web search to check whether this SPECIFIC complaint has already been solved, not just whether tools exist in the same general category. Return ONLY a raw JSON object — no markdown fences, no preamble.`,
    `Product opportunity: "${theme.topic}"
Pain point: ${theme.summary}

Search the web (try queries like "${theme.topic} tool", "${theme.topic} alternative", "${theme.topic} app") to answer: does an existing product, open-source tool, or service solve THIS EXACT complaint — not just something in the same general category?

Be skeptical of category-level matches. A tool with a similar name or general purpose does NOT count as "already solved" unless it demonstrably addresses the specific pain described — read the pain point carefully and check the candidate solution actually covers it (e.g. a workflow tool's built-in error handling doesn't solve a complaint about SILENT failures that throw no error). Two signals this is NOT actually solved even though older tools exist in the space: (1) people are still voicing this exact complaint despite those tools having existed for years, or (2) new competing products have launched recently specifically targeting this same gap — that's evidence of live, contested demand, not a solved problem.

Return ONLY this JSON object:
{
  "already_solved": false,
  "existing_solution": "Name — one-line description of what solves this AND how it addresses the specific complaint (empty string if nothing found)",
  "verdict_reason": "One sentence on what you found and why it does or doesn't count as already solved"
}

RETURN ONLY THE JSON OBJECT.`,
    2,
    {
      model: "claude-opus-5",
      shape: "object",
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
      effort: "low",
      meta: true,
    }
  );

  // Don't trust the model's own claim that it searched — check the actual
  // response content for a successful web_search_tool_result block. A quota
  // error or other tool failure returns an error object (not a list) in
  // .content, and the model can silently fall back to answering from
  // training data while still writing a confident verdict_reason.
  const searchBlocks = content.filter(b => b.type === "web_search_tool_result");
  result.search_verified = searchBlocks.length > 0 && searchBlocks.some(b => Array.isArray(b.content));
  return result;
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
    const unverified = t.already_solved !== undefined && t.search_verified === false;
    if (t.already_solved) {
      log(`      ${red(`⚠ ALREADY SOLVED${t.blocklisted ? " (blocklisted — reused from a prior run)" : ""}`)} ${dim(`(raw signal was ${t.raw_signal_strength}/10)`)} — ${dim(t.competition_reason || "")}`);
      if (t.existing_solution) log(`      ${dim(`Existing: ${t.existing_solution}`)}`);
    } else if (t.already_solved !== undefined) {
      log(`      ${grn("✓ No existing solution found")}`);
    }
    if (unverified) log(`      ${yel("⚠ unverified — web search failed for this check; verdict is from the model's training data, not a live lookup")}`);
    log(`      ${t.summary}`);
    log(`      ${dim(t.signal_reason)}`);
    log(`      ${dim(`Supporting posts: ${(t.post_indices || []).length}`)}`);
  });
}

function printOpportunities(theme, opps) {
  section(`PRODUCT OPPORTUNITIES: "${theme.topic.toUpperCase()}"`);

  opps.forEach((o, i) => {
    const effortColor = o.build_effort === "low" ? grn : o.build_effort === "high" ? red : yel;

    const na = "(not specified — missing from Claude's response)";
    const typeTag = o.product_type === "non-technical-ops" ? cyn("[NON-TECHNICAL/OPS]") : o.product_type ? dim("[TECHNICAL/SAAS]") : "";
    log(`\n  ${bold(`#${i + 1}  ${o.title || "(untitled)"}`)} ${typeTag}`);
    log(`      ${dim(o.source || "?")}  ·  Demand: ${bar(o.demand_score || 0, 10, 12)} ${scoreColor(o.demand_score || 0)}  ·  Build effort: ${effortColor(o.build_effort || "?")}`);
    log("");
    log(`      ${c.bold}Problem${c.reset}`);
    log(`      ${o.problem || na}`);
    log("");
    log(`      ${c.bold}Product angle${c.reset}`);
    log(`      ${grn(o.product_angle || na)}`);
    log("");
    log(`      ${c.bold}Monetisation${c.reset}`);
    log(`      ${yel(o.monetisation || na)}`);
    log("");
    log(`      ${c.bold}What they say${c.reset}`);
    log(`      ${dim(`"${o.quote || na}"`)}`);
    log(`      ${dim(`Why ${o.demand_score || 0}/10: ${o.demand_reason || na}`)}`);
    log(`  ${dim("─".repeat(56))}`);
  });
}

function printTopPosts(posts) {
  section(`TOP POSTS BY ENGAGEMENT (showing 15)`);
  posts.slice(0, 15).forEach((p, i) => {
    const badges = [p.unresolved && yel("[UNRESOLVED]"), p.explicitGap && grn("[EXPLICIT-GAP]"), p.workaround && cyn("[WORKAROUND-BUILT]"), p.commercialIntent && org("[WOULD-PAY]")].filter(Boolean).join(" ");
    log(`  ${dim(`${i + 1}.`)} ${bold(`↑${p.score}`)} ${dim(`💬${p.comments}`)}  ${p.title.slice(0, 80)}${p.title.length > 80 ? "…" : ""} ${badges}`);
    log(`     ${dim(`${p.sub}  →  ${p.url}`)}`);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Saves the full run — terminal output can scroll out of view (or past a
// terminal's scrollback limit) long before a run this long finishes; this
// guarantees a readable copy survives regardless. Called from main()'s
// finally block, so a partial run (error, Ctrl+C-adjacent failure) still
// saves whatever was collected so far.
function saveRun(stamp, report, logLines) {
  try {
    const dir = resolve(process.cwd(), "runs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `scan-${stamp}.json`), JSON.stringify(report, null, 2));
    writeFileSync(resolve(dir, `scan-${stamp}.log`), logLines.join("\n"));
    rawConsoleLog(dim(`  Saved full output: runs/scan-${stamp}.json and runs/scan-${stamp}.log`));
  } catch (e) {
    rawConsoleLog(red(`  Failed to save run output: ${e.message}`));
  }
}

// ── Blocklist (persisted across runs) ────────────────────────────────────────
// Across four runs this pipeline (and manual review) has independently killed
// the same categories repeatedly — budgeting, git tooling, Docker tooling,
// no-code workflow monitoring, markdown editors, P2P streaming. Persisting
// what's already been confirmed already_solved means future runs skip the
// live search-verification call entirely for a repeat match (saving cost)
// instead of re-discovering the same rejection every time.
const BLOCKLIST_PATH = resolve(process.cwd(), "blocklist.json");
const BLOCKLIST_STOPWORDS = new Set(["the", "a", "an", "for", "of", "to", "and", "or", "is", "are", "in", "on", "with", "that", "this", "tool", "app", "apps"]);

function loadBlocklist() {
  try {
    return JSON.parse(readFileSync(BLOCKLIST_PATH, "utf8"));
  } catch {
    return [];
  }
}

function saveBlocklist(list) {
  try {
    writeFileSync(BLOCKLIST_PATH, JSON.stringify(list, null, 2));
  } catch (e) {
    warn(`Failed to save blocklist: ${e.message}`);
  }
}

function significantWords(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 2 && !BLOCKLIST_STOPWORDS.has(w));
}

// Fuzzy match, not exact — themes are freshly-generated topic titles that
// won't match a stored blocklist entry verbatim. Two-or-more shared
// significant words (or the entry's words being fully contained) is treated
// as the same underlying category.
function blocklistMatch(topic, blocklist) {
  const themeWords = new Set(significantWords(topic));
  for (const entry of blocklist) {
    const entryWords = significantWords(entry.topic);
    if (entryWords.length === 0) continue;
    const overlap = entryWords.filter(w => themeWords.has(w)).length;
    if (overlap >= 2 || overlap === entryWords.length) return entry;
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = {
    generated_at: new Date().toISOString(),
    topic_filter: TOPIC_ARG || null,
    recent_months: RECENT_MONTHS,
    top_posts: [],
    themes: [],
    opportunities: [],
  };

  try {
    log(`\n${org("█")} ${bold("SIGNAL SCANNER")}`);
    log(`${dim("  Finds real product opportunities from pain points across Hacker News, Stack Exchange & GitHub")}\n`);

    if (TOPIC_ARG) {
      log(`${cyn(`  Topic filter: "${TOPIC_ARG}"`)}\n`);
    }
    log(`${dim(`  Biasing toward posts from the last ${RECENT_MONTHS} months, and boosting UNRESOLVED / EXPLICIT-GAP signals over raw engagement.`)}\n`);

    // Step 1: gather posts
    section("STEP 1 — FETCHING POSTS");
    const posts = await gatherPosts(TOPIC_ARG);

    if (posts.length < 5) {
      throw new Error("Too few posts returned. Try again in a moment, or broaden --topic.");
    }

    printTopPosts(posts);
    report.top_posts = posts.slice(0, 15).map(p => ({
      title: p.title, url: p.url, source: p.sub, score: p.score, comments: p.comments,
      unresolved: !!p.unresolved, explicit_gap: !!p.explicitGap, workaround: !!p.workaround, would_pay: !!p.commercialIntent,
    }));

    // Build a source-balanced pool so one loud source (e.g. Hacker News'
    // point scale) can't crowd out the others — same pool is used for
    // numbering AND for resolving post_indices back to posts, so they must
    // stay in sync.
    const pool = diversify(posts);

    // Step 2: analyse themes
    section("STEP 2 — CLUSTERING INTO THEMES (Claude)");
    info(`Sending ${pool.length} source-balanced posts to Claude for analysis…`);
    const themes = await analyseThemes(pool);
    ok(`Found ${themes.length} themes`);

    // Step 2b: check each theme against the live web BEFORE ranking — if
    // even one real solution already exists, this isn't an open gap,
    // regardless of how strong its raw signal_strength looked.
    section("STEP 2B — CHECKING WHETHER THIS IS ALREADY SOLVED (web search)");
    const blocklist = loadBlocklist();
    for (const theme of themes) {
      const blocked = blocklistMatch(theme.topic, blocklist);
      if (blocked) {
        theme.already_solved = true;
        theme.existing_solution = blocked.existing_solution || "(see blocklist)";
        theme.competition_reason = `Blocklisted — matches previously confirmed "${blocked.topic}" (added ${(blocked.added_at || "").slice(0, 10) || "earlier"})`;
        theme.search_verified = true;
        theme.blocklisted = true;
        theme.raw_signal_strength = theme.signal_strength;
        theme.signal_strength = Math.min(theme.signal_strength, 3);
        warn(`"${theme.topic}" — blocklisted (matches "${blocked.topic}"), skipping live check`);
        continue;
      }
      info(`Checking "${theme.topic}"…`);
      try {
        const comp = await checkCompetition(theme);
        theme.already_solved = !!comp.already_solved;
        theme.existing_solution = comp.existing_solution || "";
        theme.competition_reason = comp.verdict_reason || "";
        theme.search_verified = comp.search_verified !== false;
        if (theme.already_solved) {
          theme.raw_signal_strength = theme.signal_strength;
          theme.signal_strength = Math.min(theme.signal_strength, 3);
          warn(`"${theme.topic}" already solved — ${theme.existing_solution}${theme.search_verified ? "" : " (⚠ unverified — search failed, answered from training data)"}`);
          blocklist.push({ topic: theme.topic, existing_solution: theme.existing_solution, added_at: new Date().toISOString() });
        } else {
          ok(`"${theme.topic}" — no existing solution found${theme.search_verified ? "" : " (⚠ unverified — search failed, answered from training data)"}`);
        }
      } catch (e) {
        warn(`Competition check failed for "${theme.topic}": ${e.message}`);
      }
      await sleep(500);
    }
    saveBlocklist(blocklist);

    themes.sort((a, b) => b.signal_strength - a.signal_strength);
    printThemes(themes);
    report.themes = themes;

    // Step 3: drill top 3 themes that actually cleared Step 2B — drilling a
    // theme Step 2B just flagged already_solved would silently re-inflate it
    // back into a fake "HIGH demand" opportunity with no record it was ever
    // rejected. This is the gate that was missing before: Step 2B's verdict
    // must exclude a theme from drilling, not just cap a number nothing else
    // reads.
    section("STEP 3 — DRILLING TOP 3 THEMES FOR PRODUCT IDEAS");
    const clearedThemes = themes.filter(t => !t.already_solved);

    if (clearedThemes.length === 0) {
      warn("0 themes cleared the already-solved filter this run — nothing to drill.");
      log(`  ${dim("Every theme in Step 2 already has an existing solution per Step 2B. Try a different --topic, or rerun for a fresh source pool.")}`);
    }

    for (const theme of clearedThemes.slice(0, 3)) {
      info(`Drilling: "${theme.topic}"…`);
      try {
        const opps = await drillTheme(theme, pool);
        opps.sort((a, b) => b.demand_score - a.demand_score);
        printOpportunities(theme, opps);
        report.opportunities.push({ theme, ideas: opps });
      } catch (e) {
        warn(`Failed to drill "${theme.topic}": ${e.message}`);
      }
      await sleep(500);
    }

    section("DONE");
    log(`  ${grn("✓")} Scan complete. ${dim(`${posts.length} posts analysed across Hacker News, ${SE_SITES.length} Stack Exchange communities, ${DISCOURSE_FORUMS.length} forums${GITHUB_TOKEN ? ", and GitHub Issues" : ""}.`)}`);
    log(`  ${dim("Run again for fresh results — signal changes daily.")}\n`);
  } finally {
    saveRun(stamp, report, logBuffer);
  }
}

main().catch(e => {
  console.error(`\n${red("Fatal error:")} ${e.message}\n`);
  process.exit(1);
});
