import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "data", "posts.json");

const IG_USER_ID = process.env.IG_USER_ID;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://celebcity.in";
const GRAPH_VERSION = "v21.0";
const MAX_ATTEMPTS = 3; // how many candidate posts to try before giving up this run
const MAX_RETRIES = 3; // how many separate runs a single article gets before being abandoned

// Broad, always-included tags that place us in the biggest relevant Bollywood search pools.
const BASE_HASHTAGS = [
  "#Bollywood",
  "#BollywoodNews",
  "#IndianCinema",
  "#BollywoodUpdates",
  "#CelebrityNews",
  "#BollywoodGossip",
  "#FilmyNews",
  "#Entertainment",
];

// Niche/category tags — smaller pools rank higher within them, good for discovery.
const HASHTAGS_BY_CATEGORY = {
  "box-office": [
    "#BoxOffice",
    "#BoxOfficeCollection",
    "#BoxOfficeIndia",
    "#BollywoodBoxOffice",
    "#FilmBusiness",
  ],
  "ott-releases": [
    "#OTTRelease",
    "#StreamingNow",
    "#OTTUpdates",
    "#WebSeries",
    "#BingeWatch",
  ],
  relationships: ["#BollywoodCouple", "#CelebRelationship", "#BollywoodShaadi", "#CelebLove"],
  fashion: ["#BollywoodFashion", "#CelebStyle", "#RedCarpetLook", "#EthnicWear", "#FashionPolice"],
  "bollywood-news": ["#CelebCity", "#BollywoodUpdate", "#HindiCinema"],
};

const CATEGORY_EMOJI = {
  "box-office": "💰",
  "ott-releases": "📺",
  relationships: "💔",
  fashion: "👗",
  "bollywood-news": "🎬",
};

const ANNOTATION_PREFIX_RE = /^(EXCLUSIVE|WATCH|BREAKING|VIRAL|OMG|WOW)\s*[:\-]?\s*/i;

// Common headline words that ride along in Title Case but aren't proper nouns —
// any candidate phrase containing one of these gets dropped rather than truncated,
// since a partial name/title reads as more spammy than just skipping it.
const HEADLINE_STOPWORDS = new Set(
  [
    "The",
    "A",
    "An",
    "Enters",
    "Becomes",
    "Says",
    "Say",
    "After",
    "Ahead",
    "Amid",
    "Box",
    "Office",
    "Day",
    "Days",
    "Week",
    "Weeks",
    "Year",
    "Years",
    "Crore",
    "Club",
    "Fastest",
    "Slowest",
    "Film",
    "Films",
    "Movie",
    "Movies",
    "Wave",
    "New",
    "First",
    "Second",
    "Third",
    "Song",
    "From",
    "With",
    "Not",
    "Why",
    "How",
    "What",
    "When",
    "Who",
    "Actor",
    "Actress",
    "Star",
    "News",
    "Update",
    "Updates",
    "Video",
    "Watch",
    "Photo",
    "Photos",
    "Look",
    "Looks",
    "Big",
    "Top",
    "Best",
    "Most",
    "List",
    "India",
    "Indian",
    "This",
    "That",
    "Is",
    "Are",
    "Was",
    "Were",
    "Will",
    "Recalls",
    "Reveals",
    "Shares",
    "Opens",
    "Breaks",
    "Makes",
    "Gets",
    "Gives",
    "Takes",
  ].map((w) => w.toLowerCase())
);

function extractEntityHashtags(title) {
  const cleaned = title.replace(ANNOTATION_PREFIX_RE, "").replace(/['’]/g, "");
  const matches = cleaned.match(/\b[A-Z][a-zA-Z]*(?:\s[A-Z][a-zA-Z]*){0,2}\b/g) || [];
  const seen = new Set();
  const tags = [];
  for (const m of matches) {
    const words = m.split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) continue;
    if (words.some((w) => HEADLINE_STOPWORDS.has(w.toLowerCase()))) continue;
    const tag = `#${words.join("")}`;
    const key = tag.toLowerCase();
    if (tag.length < 4 || tag.length > 30 || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags.slice(0, 6);
}

function buildHashtags(post) {
  const categoryTags = HASHTAGS_BY_CATEGORY[post.category] || HASHTAGS_BY_CATEGORY["bollywood-news"];
  const entityTags = extractEntityHashtags(post.title);
  const combined = [...BASE_HASHTAGS, ...categoryTags, ...entityTags];
  const seen = new Set();
  const deduped = combined.filter((t) => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.slice(0, 25).join(" ");
}

function loadPosts() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function savePosts(posts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(posts, null, 2));
}

const CAPTION_BOILERPLATE_RE =
  /entertainment desk|team of journalists|red carpet goes unrolled|insider insights|dynamic and dedicated|disclaimer:|subscribe|newsletter|follow us on/i;

function buildCaption(post) {
  // Skip the generic opener line, and defensively drop any boilerplate that slipped
  // past the scraper's own filter (e.g. a publisher's "about our newsroom" blurb).
  const bodyLines = (post.body || []).slice(1).filter((line) => !CAPTION_BOILERPLATE_RE.test(line));
  const excerpt = bodyLines.slice(0, 2).join(" ").slice(0, 350);
  const emoji = CATEGORY_EMOJI[post.category] || CATEGORY_EMOJI["bollywood-news"];
  const hashtags = buildHashtags(post);
  const articleUrl = `${SITE_BASE_URL}/article/${post.slug}/`;
  return [`${emoji} ${post.title}`, "", excerpt, "", `Full story: ${articleUrl} (link in bio)`, "", hashtags]
    .join("\n")
    .slice(0, 2190);
}

function buildAltText(post) {
  const label = post.category.replace("-", " ");
  return `${post.title} — ${label} news photo, CelebCity`.slice(0, 1000);
}

async function graphRequest(pathSegment, params) {
  const url = new URL(`https://graph.instagram.com/${GRAPH_VERSION}/${pathSegment}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, { method: "POST" });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(json.error ? JSON.stringify(json.error) : `HTTP ${res.status}`);
  }
  return json;
}

async function createMedia(imageUrl, caption, altText) {
  return graphRequest(`${IG_USER_ID}/media`, {
    image_url: imageUrl,
    caption,
    alt_text: altText,
    access_token: IG_ACCESS_TOKEN,
  });
}

async function createReelMedia(videoUrl, caption) {
  // Note: alt_text is not a supported param for REELS media type (photos only).
  return graphRequest(`${IG_USER_ID}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: "true",
    access_token: IG_ACCESS_TOKEN,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilMediaReady(creationId, isVideo) {
  // Video (Reels) processing is noticeably slower and more variable than photos, and can
  // occasionally exceed a minute or two under load — give it up to ~4 minutes. Photos are
  // effectively instant, so a short timeout there just fails fast on genuine problems.
  const maxAttempts = isVideo ? 80 : 15;
  for (let i = 0; i < maxAttempts; i++) {
    const url = new URL(`https://graph.instagram.com/${GRAPH_VERSION}/${creationId}`);
    url.searchParams.set("fields", "status_code");
    url.searchParams.set("access_token", IG_ACCESS_TOKEN);
    const res = await fetch(url);
    const json = await res.json();
    if (json.status_code === "FINISHED") return;
    if (json.status_code === "ERROR") throw new Error("Media processing failed on Instagram's side");
    await sleep(3000);
  }
  throw new Error("Media was not ready for publishing after waiting");
}

async function publishToInstagram(post, mode) {
  const caption = buildCaption(post);
  const altText = buildAltText(post);
  const reelUrl = `${SITE_BASE_URL}/reels/${post.slug}.mp4`;
  const socialImageUrl = `${SITE_BASE_URL}/social/${post.slug}.jpg`;

  let created;
  let isVideo = false;
  if (mode === "reel" && post.reelGeneratedAt) {
    try {
      created = await createReelMedia(reelUrl, caption);
      isVideo = true;
    } catch (err) {
      console.error(`Reel failed (${err.message}), falling back to photo.`);
    }
  }
  if (!created && post.socialImageGeneratedAt) {
    try {
      created = await createMedia(socialImageUrl, caption, altText);
    } catch (err) {
      console.error(`Dramatic graphic failed (${err.message}), falling back to original photo.`);
    }
  }
  if (!created) {
    created = await createMedia(post.imageUrl, caption, altText);
  }

  await waitUntilMediaReady(created.id, isVideo);

  await graphRequest(`${IG_USER_ID}/media_publish`, {
    creation_id: created.id,
    access_token: IG_ACCESS_TOKEN,
  });
}

async function main() {
  if (!IG_USER_ID || !IG_ACCESS_TOKEN) {
    console.error("Missing IG_USER_ID or IG_ACCESS_TOKEN environment variables. Skipping Instagram post.");
    process.exit(0); // don't fail the workflow — just skip until secrets are configured
  }

  // POST_MODE=reel -> only post articles with a Reel ready (runs on the reel schedule).
  // POST_MODE=photo (default) -> post as a photo regardless of Reel availability.
  const mode = process.env.POST_MODE === "reel" ? "reel" : "photo";
  console.log(`Running in ${mode} mode.`);

  const posts = loadPosts();
  // Retry transient failures (e.g. "media not ready yet") up to MAX_RETRIES times across
  // separate runs before giving up on an article for good — a single failure is very often
  // just a slow Instagram processing queue, not a real problem with that article.
  const eligible = posts.filter(
    (p) => p.body && p.imageUrl && !p.igPostedAt && (p.igPostAttempts || 0) < MAX_RETRIES
  );
  const candidates = (mode === "reel" ? eligible.filter((p) => p.reelGeneratedAt) : eligible).slice(0, MAX_ATTEMPTS);

  if (!candidates.length) {
    console.log("No eligible unposted articles found.");
    return;
  }

  for (const post of candidates) {
    try {
      console.log(`Posting to Instagram: ${post.title}`);
      await publishToInstagram(post, mode);
      post.igPostedAt = new Date().toISOString();
      savePosts(posts);
      console.log("Posted successfully.");
      return; // one post per run
    } catch (err) {
      console.error(`Failed to post "${post.title}":`, err.message);
      post.igPostAttempts = (post.igPostAttempts || 0) + 1;
      post.igLastFailureAt = new Date().toISOString();
      if (post.igPostAttempts >= MAX_RETRIES) {
        post.igPostFailedAt = post.igLastFailureAt; // give up for good after MAX_RETRIES tries
      }
      savePosts(posts);
    }
  }
  console.log("No candidate could be posted this run.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
