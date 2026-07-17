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

const HASHTAGS_BY_CATEGORY = {
  "box-office": "#BoxOffice #Bollywood #BollywoodNews",
  "ott-releases": "#OTT #Bollywood #BollywoodNews #Streaming",
  relationships: "#Bollywood #BollywoodNews #Celebrity",
  fashion: "#BollywoodFashion #Bollywood #CelebStyle",
  "bollywood-news": "#Bollywood #BollywoodNews #CelebCity",
};

function loadPosts() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function savePosts(posts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(posts, null, 2));
}

function buildCaption(post) {
  const bodyLines = (post.body || []).slice(1, 3); // skip the generic opener line
  const excerpt = bodyLines.join(" ").slice(0, 350);
  const hashtags = HASHTAGS_BY_CATEGORY[post.category] || HASHTAGS_BY_CATEGORY["bollywood-news"];
  const articleUrl = `${SITE_BASE_URL}/article/${post.slug}/`;
  return [post.title, "", excerpt, "", `Full story: ${articleUrl}`, "", hashtags].join("\n").slice(0, 2190);
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

async function publishToInstagram(post) {
  const caption = buildCaption(post);
  const socialImageUrl = `${SITE_BASE_URL}/social/${post.slug}.jpg`;
  const imageUrl = post.socialImageGeneratedAt ? socialImageUrl : post.imageUrl;
  const created = await graphRequest(`${IG_USER_ID}/media`, {
    image_url: imageUrl,
    caption,
    access_token: IG_ACCESS_TOKEN,
  });
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

  const posts = loadPosts();
  const candidates = posts
    .filter((p) => p.body && p.imageUrl && !p.igPostedAt && !p.igPostFailedAt)
    .slice(0, MAX_ATTEMPTS);

  if (!candidates.length) {
    console.log("No eligible unposted articles found.");
    return;
  }

  for (const post of candidates) {
    try {
      console.log(`Posting to Instagram: ${post.title}`);
      await publishToInstagram(post);
      post.igPostedAt = new Date().toISOString();
      savePosts(posts);
      console.log("Posted successfully.");
      return; // one post per run
    } catch (err) {
      console.error(`Failed to post "${post.title}":`, err.message);
      post.igPostFailedAt = new Date().toISOString(); // avoid retrying a broken image forever
      savePosts(posts);
    }
  }
  console.log("No candidate could be posted this run.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
