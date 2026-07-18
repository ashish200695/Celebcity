import Parser from "rss-parser";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import sharp from "sharp";

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
const SOCIAL_IMAGE_LIMIT = 60; // how many recent posts get a dramatic Instagram-style graphic per run
const SOCIAL_IMAGE_CONCURRENCY = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB cap on source photo download
const SOCIAL_W = 1080;
const SOCIAL_H = 1350;
const REEL_W = 1080;
const REEL_H = 1920;
const REEL_BOTTOM_SAFE_ZONE = 260; // keep text clear of Instagram's Reels UI (caption/icons overlay)
const REEL_DURATION_SEC = 6;
const REEL_FPS = 25;
const REEL_LIMIT = 15; // video encoding is CPU/time heavy — keep this modest per run
const REEL_CONCURRENCY = 2;

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
        !/subscribe|cookie|advertisement|all rights reserved|preferred source|also read|catch us for|continue with google|log in with|sign up|newsletter|follow us on|download the app|click here|e-paper|entertainment desk|team of journalists|red carpet goes unrolled|insider insights|dynamic and dedicated|disclaimer:|end of article/i.test(
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

// ---------- Dramatic Instagram-style graphic (photo + gradient + bold headline) ----------

async function fetchImageBuffer(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (received < MAX_IMAGE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
    reader.cancel().catch(() => {});
    return Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapHeadline(title, fontSize, maxWidth, maxLines) {
  const avgCharWidth = fontSize * 0.58;
  const maxCharsPerLine = Math.max(6, Math.floor(maxWidth / avgCharWidth));
  const words = title.toUpperCase().split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
    if (lines.length === maxLines - 1 && current.length > maxCharsPerLine) {
      break;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    lines.length = maxLines;
  }
  const last = lines.length - 1;
  if (words.join(" ").length > lines.join(" ").length) {
    lines[last] = lines[last].replace(/\s*$/, "") + "…";
  }
  return lines;
}

function buildOverlaySvg(post, width, height, bottomSafeZone = 0) {
  const padding = 64;
  const maxWidth = width - padding * 2;
  const fontSize = post.title.length > 85 ? 62 : 76;
  const lineHeight = fontSize * 1.14;
  const lines = wrapHeadline(post.title, fontSize, maxWidth, 4);
  const textBlockHeight = lines.length * lineHeight;
  const baselineStart = height - 110 - bottomSafeZone - textBlockHeight;

  const textSpans = (dx, dy, fill, opacity) =>
    lines
      .map(
        (line, i) =>
          `<tspan x="${padding + dx}" y="${baselineStart + i * lineHeight + dy}" fill="${fill}" fill-opacity="${opacity}">${escapeXml(
            line
          )}</tspan>`
      )
      .join("");

  const categoryLabel = post.category.replace("-", " ").toUpperCase();
  const badgeWidth = categoryLabel.length * 15 + 48;

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="42%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.92"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#scrim)"/>
  <rect x="${padding}" y="56" width="${badgeWidth}" height="52" rx="10" fill="#ff3b6b"/>
  <text x="${padding + 24}" y="90" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="24" fill="#ffffff" letter-spacing="1">${escapeXml(
    categoryLabel
  )}</text>
  <text font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="${fontSize}">
    ${textSpans(4, 4, "#000000", 0.55)}
    ${textSpans(0, 0, "#ffffff", 1)}
  </text>
  <text x="${width - padding}" y="${height - bottomSafeZone - 40}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="26" fill="#ff3b6b" letter-spacing="2">CELEBCITY</text>
</svg>`;
}

async function compositeGraphic(rawBuffer, post, width, height, bottomSafeZone = 0) {
  const overlay = Buffer.from(buildOverlaySvg(post, width, height, bottomSafeZone));

  // Blurred, darkened cover-crop as a full-bleed backdrop (imperfections invisible once blurred)...
  const background = await sharp(rawBuffer)
    .resize(width, height, { fit: "cover" })
    .blur(42)
    .modulate({ brightness: 0.55 })
    .toBuffer();

  // ...with the full uncropped photo centered on top so faces/subjects are never cut off.
  const foreground = await sharp(rawBuffer)
    .resize(width, height, { fit: "inside", kernel: sharp.kernel.lanczos3 })
    .toBuffer();
  const fgMeta = await sharp(foreground).metadata();
  const fgLeft = Math.round((width - fgMeta.width) / 2);
  const fgTop = Math.round((height - fgMeta.height) / 2);

  return sharp(background)
    .composite([
      { input: foreground, left: fgLeft, top: fgTop },
      { input: overlay, top: 0, left: 0 },
    ])
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function generateSocialImage(post) {
  const raw = await fetchImageBuffer(post.imageUrl);
  if (!raw) return null;
  try {
    return await compositeGraphic(raw, post, SOCIAL_W, SOCIAL_H);
  } catch (err) {
    console.error(`Failed to composite social image for "${post.title}":`, err.message);
    return null;
  }
}

async function generateSocialImages(posts) {
  const candidates = posts.filter((p) => p.body && p.imageUrl).slice(0, SOCIAL_IMAGE_LIMIT);
  if (!candidates.length) return;
  console.log(`Generating ${candidates.length} dramatic social graphics...`);

  await mapWithConcurrency(candidates, SOCIAL_IMAGE_CONCURRENCY, async (post) => {
    const jpeg = await generateSocialImage(post);
    if (!jpeg) {
      post.socialImageGeneratedAt = "";
      return;
    }
    writeFile(`social/${post.slug}.jpg`, jpeg);
    post.socialImageGeneratedAt = new Date().toISOString();
  });
}

// ---------- Instagram Reel video (photo + slow zoom + silent audio track via ffmpeg) ----------

let ffmpegAvailable = null;
function checkFfmpegAvailable() {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  ffmpegAvailable = !result.error;
  if (!ffmpegAvailable) console.warn("ffmpeg not found — skipping Reel video generation.");
  return ffmpegAvailable;
}

async function generateReelVideo(post) {
  const raw = await fetchImageBuffer(post.imageUrl);
  if (!raw) return null;

  let frameBuffer;
  try {
    frameBuffer = await compositeGraphic(raw, post, REEL_W, REEL_H, REEL_BOTTOM_SAFE_ZONE);
  } catch (err) {
    console.error(`Failed to composite reel frame for "${post.title}":`, err.message);
    return null;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "celebcity-reel-"));
  const inputPath = path.join(tmpDir, "frame.jpg");
  const outputPath = path.join(tmpDir, "reel.mp4");
  fs.writeFileSync(inputPath, frameBuffer);

  const totalFrames = REEL_DURATION_SEC * REEL_FPS;
  const fadeOutStart = Math.max(REEL_DURATION_SEC - 1, 0);
  // Procedurally generated ambient chord bed (three sine tones + a gentle tremolo pulse) —
  // zero copyright risk and no external file dependency, unlike baking in real music.
  const videoFilter =
    // Pre-scale 1.5x with high-quality lanczos before zooming (reduces upscale blur), and
    // anchor the zoom on the CENTER (iw/2, ih/2) — without explicit x/y, zoompan anchors at
    // the top-left corner by default, which was cropping out faces and headline text as it
    // zoomed in. A gentle max zoom (1.08) also keeps the crop subtle.
    `[0:v]scale=${Math.round(REEL_W * 1.5)}:${Math.round(
      REEL_H * 1.5
    )}:flags=lanczos,zoompan=z='min(zoom+0.0006,1.08)':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${REEL_W}x${REEL_H}:fps=${REEL_FPS},format=yuv420p[vout]`;
  const audioFilter = `[1:a][2:a][3:a]amix=inputs=3:duration=longest:dropout_transition=0,tremolo=f=3:d=0.25,volume=0.15,afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart}:d=1[aout]`;

  const args = [
    "-y",
    "-loop",
    "1",
    "-i",
    inputPath,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=261.63:duration=${REEL_DURATION_SEC}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=329.63:duration=${REEL_DURATION_SEC}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=392.00:duration=${REEL_DURATION_SEC}`,
    "-filter_complex",
    `${videoFilter};${audioFilter}`,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-crf",
    "18",
    "-preset",
    "slow",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    "-t",
    String(REEL_DURATION_SEC),
    "-movflags",
    "+faststart",
    outputPath,
  ];

  const result = spawnSync("ffmpeg", args, { encoding: "utf-8" });
  let videoBuffer = null;
  if (result.status === 0 && fs.existsSync(outputPath)) {
    videoBuffer = fs.readFileSync(outputPath);
  } else {
    console.error(`ffmpeg failed for "${post.title}":`, (result.stderr || "").slice(-800));
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return videoBuffer;
}

async function generateReels(posts) {
  if (!checkFfmpegAvailable()) return;
  const candidates = posts.filter((p) => p.body && p.imageUrl && !p.igPostedAt).slice(0, REEL_LIMIT);
  if (!candidates.length) return;
  console.log(`Generating ${candidates.length} Reel videos...`);

  await mapWithConcurrency(candidates, REEL_CONCURRENCY, async (post) => {
    const video = await generateReelVideo(post);
    if (!video) {
      post.reelGeneratedAt = "";
      return;
    }
    writeFile(`reels/${post.slug}.mp4`, video);
    post.reelGeneratedAt = new Date().toISOString();
  });
}

// ---------- HTML rendering ----------

const SITE_URL = "https://celebcity.in";

function layout({ title, description, body, canonicalPath, prefix, ogImage, ogType, jsonLd }) {
  const canonicalUrl = `${SITE_URL}${canonicalPath}`;
  const image = ogImage || `${SITE_URL}/logo.png`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${escapeHtml(description || "")}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${canonicalUrl}">
<link rel="stylesheet" href="${prefix}style.css">
<link rel="icon" href="${prefix}favicon.png" type="image/png">
<link rel="alternate" type="application/rss+xml" title="CelebCity RSS" href="${prefix}feed.xml">
<meta property="og:site_name" content="CelebCity">
<meta property="og:type" content="${ogType || "website"}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description || "")}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description || "")}">
<meta name="twitter:image" content="${escapeHtml(image)}">
${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ""}
</head>
<body>
<header class="site-header">
  <a href="${prefix}" class="logo">Celeb<span>City</span></a>
  <nav>
    <a href="${prefix}category/bollywood-news/">News</a>
    <a href="${prefix}category/box-office/">Box Office</a>
    <a href="${prefix}category/celebrity/">Celebrity</a>
    <a href="${prefix}category/ott-releases/">OTT</a>
    <a href="${prefix}category/relationships/">Relationships</a>
    <a href="${prefix}category/fashion/">Fashion</a>
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
    return `<img class="card-img" src="${escapeHtml(post.imageUrl)}" alt="${escapeHtml(
      post.title
    )}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`;
  }
  return `<div class="card-img placeholder"><span>${escapeHtml(post.category.replace("-", " "))}</span></div>`;
}

function timeTag(dateStr) {
  return `<time datetime="${new Date(dateStr).toISOString()}">${formatDate(dateStr)}</time>`;
}

const DISPLAY_BOILERPLATE_RE =
  /entertainment desk|team of journalists|red carpet goes unrolled|insider insights|dynamic and dedicated|disclaimer:|subscribe|newsletter|follow us on/i;

function excerptOf(post) {
  const lines = (post.body || []).filter((line) => !DISPLAY_BOILERPLATE_RE.test(line));
  const first = lines[1] || lines[0] || "";
  return first.length > 160 ? first.slice(0, 157) + "..." : first;
}

function postCard(post, prefix) {
  return `<article class="card">
  ${cardImage(post)}
  <div class="card-body">
  <span class="tag">${post.category.replace("-", " ")}</span>
  <h2><a href="${prefix}article/${post.slug}/">${escapeHtml(post.title)}</a></h2>
  <p class="meta">${timeTag(post.pubDate)} &middot; ${escapeHtml(post.sourceName)}</p>
  <p class="snippet">${escapeHtml(excerptOf(post))}</p>
  </div>
</article>`;
}

function organizationJsonLd() {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsMediaOrganization",
    name: "CelebCity",
    url: SITE_URL,
    logo: { "@type": "ImageObject", url: `${SITE_URL}/logo.png` },
  });
}

function renderHome(posts) {
  const prefix = "";
  const latest = posts.slice(0, MAX_POSTS_ON_HOME);
  const body = `<section class="hero">
  <h1>Bollywood News, Updated Automatically</h1>
  <p>Latest Bollywood celebrity news, box office numbers, OTT releases and more — refreshed around the clock.</p>
</section>
<section class="feed">
${latest.map((p) => postCard(p, prefix)).join("\n")}
</section>`;
  const jsonLd = JSON.stringify([
    JSON.parse(organizationJsonLd()),
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "CelebCity",
      url: SITE_URL,
      potentialAction: {
        "@type": "SearchAction",
        target: `${SITE_URL}/?s={search_term_string}`,
        "query-input": "required name=search_term_string",
      },
    },
  ]);
  return layout({
    title: "CelebCity — Latest Bollywood Celebrity News",
    description: "Latest Bollywood celebrity news, box office updates, OTT releases, fashion and relationships.",
    body,
    canonicalPath: "/",
    prefix,
    jsonLd,
  });
}

function renderCategory(category, posts) {
  const prefix = "../../";
  const filtered = posts.filter((p) => p.category === category).slice(0, MAX_POSTS_ON_HOME);
  const label = category.replace("-", " ");
  const body = `<section class="hero small">
  <h1>${escapeHtml(label)}</h1>
</section>
<section class="feed">
${filtered.length ? filtered.map((p) => postCard(p, prefix)).join("\n") : "<p>No stories yet — check back soon.</p>"}
</section>`;
  return layout({
    title: `${label} — CelebCity`,
    description: `Latest ${label} news from CelebCity.`,
    body,
    canonicalPath: `/category/${category}/`,
    prefix,
  });
}

function renderArticle(post) {
  const prefix = "../../";
  const ogImage = post.socialImageGeneratedAt ? `${SITE_URL}/social/${post.slug}.jpg` : post.imageUrl;
  const heroImg = post.imageUrl
    ? `<img class="hero-img" src="${escapeHtml(post.imageUrl)}" alt="${escapeHtml(
        post.title
      )}" referrerpolicy="no-referrer" onerror="this.remove()">`
    : "";
  const paragraphs = (post.body || []).map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
  const canonicalUrl = `${SITE_URL}/article/${post.slug}/`;
  const publishedIso = new Date(post.pubDate).toISOString();
  const body = `<article class="article-page">
  <span class="tag">${post.category.replace("-", " ")}</span>
  <h1>${escapeHtml(post.title)}</h1>
  <p class="meta">${timeTag(post.pubDate)}</p>
  ${heroImg}
  ${paragraphs}
  <p class="source-credit">Source: <a href="${escapeHtml(post.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(post.sourceName)}</a></p>
</article>`;
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: post.title,
    image: ogImage ? [ogImage] : undefined,
    datePublished: publishedIso,
    dateModified: publishedIso,
    articleSection: post.category.replace("-", " "),
    mainEntityOfPage: { "@type": "WebPage", "@id": canonicalUrl },
    author: { "@type": "Organization", name: "CelebCity" },
    publisher: {
      "@type": "Organization",
      name: "CelebCity",
      logo: { "@type": "ImageObject", url: `${SITE_URL}/logo.png` },
    },
  });
  return layout({
    title: `${post.title} — CelebCity`,
    description: excerptOf(post),
    body,
    canonicalPath: `/article/${post.slug}/`,
    prefix,
    ogImage,
    ogType: "article",
    jsonLd,
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

function buildSitemap(posts, categories) {
  const urls = [
    { loc: `${SITE_URL}/`, changefreq: "hourly", priority: "1.0" },
    ...categories.map((cat) => ({ loc: `${SITE_URL}/category/${cat}/`, changefreq: "hourly", priority: "0.7" })),
    ...posts
      .filter((p) => p.body !== undefined)
      .map((p) => ({
        loc: `${SITE_URL}/article/${p.slug}/`,
        lastmod: new Date(p.pubDate).toISOString(),
        changefreq: "daily",
        priority: "0.8",
      })),
  ];
  const entries = urls
    .map(
      (u) =>
        `  <url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}<changefreq>${
          u.changefreq
        }</changefreq><priority>${u.priority}</priority></url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>`;
}

function buildRobotsTxt() {
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
}

function buildRssFeed(posts) {
  const items = posts
    .filter((p) => p.body !== undefined)
    .slice(0, 50)
    .map(
      (p) => `  <item>
    <title>${escapeXml(p.title)}</title>
    <link>${SITE_URL}/article/${p.slug}/</link>
    <guid>${SITE_URL}/article/${p.slug}/</guid>
    <pubDate>${new Date(p.pubDate).toUTCString()}</pubDate>
    <category>${escapeXml(p.category.replace("-", " "))}</category>
    <description>${escapeXml(excerptOf(p))}</description>
  </item>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n  <title>CelebCity — Latest Bollywood Celebrity News</title>\n  <link>${SITE_URL}/</link>\n  <description>Latest Bollywood celebrity news, box office updates, OTT releases, fashion and relationships.</description>\n  <language>en-in</language>\n${items}\n</channel></rss>`;
}

function buildLogoSvg(size) {
  const fontSize = Math.round(size * 0.24);
  return `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" rx="${size * 0.18}" fill="#0f0f13"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="${fontSize}" fill="#ff3b6b">CC</text>
</svg>`;
}

async function generateBrandAssets() {
  const logo = await sharp(Buffer.from(buildLogoSvg(512))).png().toBuffer();
  writeFile("logo.png", logo);
  const favicon = await sharp(Buffer.from(buildLogoSvg(64))).png().toBuffer();
  writeFile("favicon.png", favicon);
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

  writeFile("sitemap.xml", buildSitemap(posts, categories));
  writeFile("robots.txt", buildRobotsTxt());
  writeFile("feed.xml", buildRssFeed(posts));

  // CNAME file for GitHub Pages custom domain.
  writeFile("CNAME", "celebcity.in");
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
  renderSite(merged);
  await generateBrandAssets();
  await generateSocialImages(merged);
  await generateReels(merged);
  savePosts(merged);
  console.log("Site built at ./site");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
