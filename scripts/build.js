import Parser from "rss-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "data", "posts.json");
const SITE_DIR = path.join(ROOT, "site");
const MAX_POSTS_ON_HOME = 40;
const MAX_TOTAL_POSTS = 500; // trim old posts beyond this to keep repo small
const ARTICLE_FETCH_LIMIT = 80; // how many posts to fetch full source pages for per run
const ARTICLE_FETCH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 10000;
const MAX_PAGE_BYTES = 900000; // stop reading a source page after ~900KB

// Free RSS feeds only — no API keys required. These are direct publisher feeds
// (not Google News' redirect-wrapped links) so we can actually fetch and
// rephrase the full article text.
const FEEDS = [
  {
    url: "https://timesofindia.indiatimes.com/rssfeeds/1081479906.cms",
    siteName: "Times of India",
    filterPath: "/bollywood/",
  },
  {
    url: "https://www.hindustantimes.com/feeds/rss/entertainment/bollywood/rssfeed.xml",
    siteName: "Hindustan Times",
  },
  {
    url: "https://www.bollywoodhungama.com/rss/news.xml",
    siteName: "Bollywood Hungama",
  },
  {
    url: "https://www.koimoi.com/feed/",
    siteName: "Koimoi",
    filterFn: (item) =>
      (item.categories || []).some((c) => /bollywood/i.test(c)) || /\/bollywood-news\//.test(item.link || ""),
  },
];

const CATEGORY_RULES = [
  [/box office|collection day|crore|opening day|weekend collection/i, "box-office"],
  [/\bott\b|streaming|netflix|prime video|hotstar|jiocinema|zee5|sonyliv/i, "ott-releases"],
  [/wedding|engage|dating|relationship|breakup|divorce|marries|married|boyfriend|girlfriend/i, "relationships"],
  [/fashion|outfit|red carpet|saree|gown|\blook\b|style file/i, "fashion"],
];

function categorize(title) {
  for (const [re, category] of CATEGORY_RULES) {
    if (re.test(title)) return category;
  }
  return "bollywood-news";
}

const parser = new Parser({ timeout: 20000 });

function slugify(title, pubDate) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  const datePart = new Date(pubDate || Date.now()).toISOString().slice(0, 10);
  return `${datePart}-${base}`;
}

function loadPosts() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function savePosts(posts) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(posts, null, 2));
}

function cleanTitle(title) {
  return title ? title.replace(/\s+/g, " ").trim() : title;
}

async function fetchAllFeeds() {
  const items = [];
  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const item of parsed.items || []) {
        if (feed.filterPath && !(item.link || "").includes(feed.filterPath)) continue;
        if (feed.filterFn && !feed.filterFn(item)) continue;
        const title = cleanTitle(item.title || "Untitled");
        items.push({
          title,
          link: (item.link || "").trim(),
          pubDate: (item.pubDate || new Date().toISOString()).trim(),
          sourceName: feed.siteName,
          category: categorize(title),
        });
      }
    } catch (err) {
      console.error(`Failed to fetch feed ${feed.url}:`, err.message);
    }
  }
  return items;
}

function mergeNewPosts(existingPosts, freshItems) {
  const existingLinks = new Set(existingPosts.map((p) => p.link));
  const newPosts = [];
  for (const item of freshItems) {
    if (!item.link || existingLinks.has(item.link)) continue;
    existingLinks.add(item.link);
    newPosts.push({
      ...item,
      slug: slugify(item.title, item.pubDate),
      addedAt: new Date().toISOString(),
    });
  }
  return [...newPosts, ...existingPosts];
}

// ---------- Fetch full source page (for image + article text) ----------

async function fetchPageHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      redirect: "follow",
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    let html = "";
    let received = 0;
    while (received < MAX_PAGE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += Buffer.from(value).toString("utf-8");
      received += value.length;
    }
    reader.cancel().catch(() => {});
    return html;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractOgImage(html) {
  if (!html) return "";
  const patterns = [
    /<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+(?:property|name)=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] && m[1].startsWith("http")) return m[1];
  }
  return "";
}

function extractArticleParagraphs(html) {
  if (!html) return [];
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  const paraMatches = [...withoutScripts.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
  const paragraphs = paraMatches
    .map((m) =>
      m[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&#39;|&rsquo;/g, "'")
        .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
        .replace(/&mdash;/g, "—")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(
      (text) =>
        text.length > 45 &&
        !/subscribe|cookie|advertisement|all rights reserved|preferred source|also read|catch us for|continue with google|log in with|sign up|newsletter|follow us on|download the app|click here|e-paper/i.test(
          text
        )
    );

  return paragraphs.slice(0, 8);
}

// ---------- Free template-based rephrasing (no LLM) ----------

const SYNONYMS = [
  ["announced", "revealed"],
  ["said in a statement", "shared in a note"],
  ["stated", "shared"],
  ["said", "shared"],
  ["actress", "star"],
  ["actor", "star"],
  ["celebrity", "star"],
  ["film", "movie"],
  ["box office collection", "ticket-window earnings"],
  ["box office", "ticket-window"],
  ["release", "rollout"],
  ["released", "rolled out"],
  ["reportedly", "as per reports"],
  ["according to reports", "as per the latest buzz"],
  ["recently", "of late"],
  ["speaking to", "in conversation with"],
  ["took to Instagram", "posted on Instagram"],
  ["shared a post", "put up a post"],
  ["fans", "followers"],
  ["viral", "widely shared"],
  ["controversy", "row"],
  ["slammed", "criticized"],
  ["praised", "lauded"],
  ["confirmed", "verified"],
  ["revealed that", "opened up that"],
  ["upcoming", "soon-to-release"],
  ["blockbuster", "smash hit"],
  ["earned", "collected"],
  ["crore", "crore rupees"],
];

function applySynonyms(text) {
  let result = text;
  for (const [from, to] of SYNONYMS) {
    const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    result = result.replace(re, (match) => {
      if (match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()) {
        return to.charAt(0).toUpperCase() + to.slice(1);
      }
      return to;
    });
  }
  return result;
}

const TRANSITIONS = [
  "",
  "Adding to this, ",
  "Meanwhile, ",
  "Notably, ",
  "As per the latest buzz, ",
  "In further updates, ",
  "On top of that, ",
];

const OPENERS = {
  "box-office": "Here's the latest box office buzz making the rounds:",
  celebrity: "Here's what's trending in celebrity circles right now:",
  "ott-releases": "Here's the latest on what's streaming and coming up:",
  relationships: "Here's the latest relationship update doing the rounds:",
  fashion: "Here's the latest fashion moment turning heads:",
  "bollywood-news": "Here's the latest update from the Bollywood world:",
};

function rephraseArticle(paragraphs, category, title) {
  if (!paragraphs.length) {
    return [`Here's a quick update: ${applySynonyms(title)}. More details are expected to follow soon.`];
  }
  const opener = OPENERS[category] || OPENERS["bollywood-news"];
  const rewritten = paragraphs.map((para, i) => {
    const transition = TRANSITIONS[i % TRANSITIONS.length];
    return transition + applySynonyms(para);
  });
  return [opener, ...rewritten];
}

// ---------- Concurrency-limited enrichment ----------

async function mapWithConcurrency(items, limit, fn) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      await fn(items[current]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
}

async function enrichPosts(posts) {
  const candidates = posts.filter((p) => p.body === undefined).slice(0, ARTICLE_FETCH_LIMIT);
  if (!candidates.length) return;
  console.log(`Fetching + rephrasing ${candidates.length} source articles...`);

  await mapWithConcurrency(candidates, ARTICLE_FETCH_CONCURRENCY, async (post) => {
    const html = await fetchPageHtml(post.link);
    post.imageUrl = extractOgImage(html) || "";
    const paragraphs = extractArticleParagraphs(html);
    post.body = rephraseArticle(paragraphs, post.category, post.title);
  });
}

// ---------- HTML rendering ----------

function layout({ title, description, body, canonicalPath }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${escapeHtml(description || "")}">
<link rel="canonical" href="https://celebcity.example${canonicalPath}">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="site-header">
  <a href="/" class="logo">Celeb<span>City</span></a>
  <nav>
    <a href="/category/bollywood-news/">News</a>
    <a href="/category/box-office/">Box Office</a>
    <a href="/category/celebrity/">Celebrity</a>
    <a href="/category/ott-releases/">OTT</a>
    <a href="/category/relationships/">Relationships</a>
    <a href="/category/fashion/">Fashion</a>
  </nav>
</header>
<main>
${body}
</main>
<footer class="site-footer">
  <p>CelebCity reports on publicly available Bollywood news in its own words. Story tips originate from the credited source noted on each article.</p>
</footer>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(d) {
  return new Date(d).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
}

function cardImage(post) {
  if (post.imageUrl) {
    return `<img class="card-img" src="${escapeHtml(post.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`;
  }
  return `<div class="card-img placeholder"><span>${escapeHtml(post.category.replace("-", " "))}</span></div>`;
}

function excerptOf(post) {
  const first = (post.body || [])[1] || (post.body || [])[0] || "";
  return first.length > 160 ? first.slice(0, 157) + "..." : first;
}

function postCard(post) {
  return `<article class="card">
  ${cardImage(post)}
  <div class="card-body">
  <span class="tag">${post.category.replace("-", " ")}</span>
  <h2><a href="/article/${post.slug}/">${escapeHtml(post.title)}</a></h2>
  <p class="meta">${formatDate(post.pubDate)} &middot; ${escapeHtml(post.sourceName)}</p>
  <p class="snippet">${escapeHtml(excerptOf(post))}</p>
  </div>
</article>`;
}

function renderHome(posts) {
  const latest = posts.slice(0, MAX_POSTS_ON_HOME);
  const body = `<section class="hero">
  <h1>Bollywood News, Updated Automatically</h1>
  <p>Latest Bollywood celebrity news, box office numbers, OTT releases and more — refreshed around the clock.</p>
</section>
<section class="feed">
${latest.map(postCard).join("\n")}
</section>`;
  return layout({
    title: "CelebCity — Latest Bollywood Celebrity News",
    description: "Latest Bollywood celebrity news, box office updates, OTT releases, fashion and relationships.",
    body,
    canonicalPath: "/",
  });
}

function renderCategory(category, posts) {
  const filtered = posts.filter((p) => p.category === category).slice(0, MAX_POSTS_ON_HOME);
  const label = category.replace("-", " ");
  const body = `<section class="hero small">
  <h1>${escapeHtml(label)}</h1>
</section>
<section class="feed">
${filtered.length ? filtered.map(postCard).join("\n") : "<p>No stories yet — check back soon.</p>"}
</section>`;
  return layout({
    title: `${label} — CelebCity`,
    description: `Latest ${label} news from CelebCity.`,
    body,
    canonicalPath: `/category/${category}/`,
  });
}

function renderArticle(post) {
  const heroImg = post.imageUrl
    ? `<img class="hero-img" src="${escapeHtml(post.imageUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`
    : "";
  const paragraphs = (post.body || []).map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
  const body = `<article class="article-page">
  <span class="tag">${post.category.replace("-", " ")}</span>
  <h1>${escapeHtml(post.title)}</h1>
  <p class="meta">${formatDate(post.pubDate)}</p>
  ${heroImg}
  ${paragraphs}
  <p class="source-credit">Source: <a href="${escapeHtml(post.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(post.sourceName)}</a></p>
</article>`;
  return layout({
    title: `${post.title} — CelebCity`,
    description: excerptOf(post),
    body,
    canonicalPath: `/article/${post.slug}/`,
  });
}

const STYLE_CSS = `
:root{--bg:#0f0f13;--card:#1a1a22;--text:#f2f2f5;--muted:#a0a0ab;--accent:#ff3b6b;}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);}
.site-header{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid #2a2a33;flex-wrap:wrap;gap:12px;}
.logo{font-size:22px;font-weight:800;color:var(--text);text-decoration:none;}
.logo span{color:var(--accent);}
.site-header nav a{color:var(--muted);text-decoration:none;margin-left:16px;font-size:14px;text-transform:capitalize;}
.site-header nav a:hover{color:var(--text);}
main{max-width:960px;margin:0 auto;padding:24px;}
.hero{padding:32px 0;}
.hero h1{font-size:32px;margin:0 0 8px;}
.hero p{color:var(--muted);}
.hero.small h1{font-size:24px;text-transform:capitalize;}
.feed{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;}
.card{background:var(--card);border-radius:12px;overflow:hidden;}
.card-img{width:100%;height:160px;object-fit:cover;display:block;background:#25252f;}
.card-img.placeholder{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;text-transform:capitalize;background:linear-gradient(135deg,#25252f,#1a1a22);}
.card-body{padding:14px 16px 18px;}
.card h2{font-size:18px;margin:8px 0;}
.card h2 a{color:var(--text);text-decoration:none;}
.card h2 a:hover{color:var(--accent);}
.tag{display:inline-block;background:var(--accent);color:#fff;font-size:11px;font-weight:700;text-transform:uppercase;padding:3px 8px;border-radius:6px;}
.meta{color:var(--muted);font-size:12px;margin:4px 0;}
.snippet{color:#c9c9d2;font-size:14px;line-height:1.5;}
.article-page{max-width:720px;margin:0 auto;}
.article-page h1{font-size:28px;line-height:1.3;}
.article-page p{line-height:1.7;color:#dcdce2;font-size:16px;}
.hero-img{width:100%;max-height:420px;object-fit:cover;border-radius:12px;margin:16px 0;background:#25252f;}
.source-credit{margin-top:24px;font-size:11px;color:var(--muted);border-top:1px solid #2a2a33;padding-top:10px;}
.source-credit a{color:var(--muted);text-decoration:underline;}
.source-credit a:hover{color:var(--accent);}
.site-footer{max-width:960px;margin:0 auto;padding:24px;color:var(--muted);font-size:12px;border-top:1px solid #2a2a33;}
`;

function writeFile(relPath, content) {
  const full = path.join(SITE_DIR, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function renderSite(posts) {
  fs.rmSync(SITE_DIR, { recursive: true, force: true });
  writeFile("style.css", STYLE_CSS);
  writeFile("index.html", renderHome(posts));

  const categories = ["bollywood-news", ...CATEGORY_RULES.map(([, cat]) => cat)];
  for (const cat of categories) {
    writeFile(`category/${cat}/index.html`, renderCategory(cat, posts));
  }

  for (const post of posts) {
    if (post.body === undefined) continue; // skip rendering until enriched
    writeFile(`article/${post.slug}/index.html`, renderArticle(post));
  }

  // CNAME file for GitHub Pages custom domain — edit this to your real domain.
  writeFile("CNAME", "celebcity.com");
}

async function main() {
  console.log("Fetching RSS feeds...");
  const freshItems = await fetchAllFeeds();
  console.log(`Fetched ${freshItems.length} raw items.`);

  const existing = loadPosts();
  let merged = mergeNewPosts(existing, freshItems);
  merged.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  if (merged.length > MAX_TOTAL_POSTS) merged = merged.slice(0, MAX_TOTAL_POSTS);

  const addedCount = merged.length - existing.length;
  console.log(`Added ${Math.max(addedCount, 0)} new posts. Total: ${merged.length}`);

  await enrichPosts(merged);

  savePosts(merged);
  renderSite(merged);
  console.log("Site built at ./site");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
