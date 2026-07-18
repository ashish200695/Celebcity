# CelebCity — Automated Bollywood News Site

100% free stack: free RSS feeds → free rewriting → free GitHub Actions automation → free
GitHub Pages hosting → free Instagram auto-posting. No LLM cost, no hosting bill.

## How it works

1. `scripts/build.js` pulls headlines + links from free, direct-publisher RSS feeds (Times
   of India, Hindustan Times, Bollywood Hungama, Koimoi — filtered to Bollywood content).
2. For new articles, it fetches the full source page, pulls the article's photo (`og:image`)
   and body text, strips site boilerplate, and rewrites it in CelebCity's own words using a
   free template-based rephraser (no LLM).
3. The rewritten article — headline, photo, full rewritten body — is published on your own
   site. Only a small text credit ("Source: X") links back to the original publisher at the
   very bottom; readers stay on your page.
4. A GitHub Actions workflow (`.github/workflows/publish.yml`) runs this automatically every
   3 hours, commits the updated post index, and deploys `site/` to GitHub Pages. This same
   run also generates each new article's dramatic graphic and (for the newest ~15) a short
   Reel video via `ffmpeg` (zoom effect + a procedurally-generated ambient audio bed — no
   copyright risk, no external file dependency).
5. Two more workflows post to Instagram on independent schedules, both 10am-10pm IST:
   - `.github/workflows/instagram-photo.yml` — **every hour**, posts the newest not-yet-posted
     article as a photo (dramatic graphic, falling back to the plain original photo if needed).
   - `.github/workflows/instagram-reel.yml` — **every 3 hours**, posts the newest not-yet-posted
     article that has a Reel ready, as an actual Instagram Reel (falls back to a photo post if
     the Reel isn't ready or fails).
   - Each article is only ever posted once (by whichever workflow gets to it first), so photos
     and Reels never duplicate the same story.

## Run it locally

```bash
npm install
npm run build
# open site/index.html in a browser, or:
npx serve site
```

## One-time setup to go live (all free)

### 1. Push this to GitHub
- Create a new **public** repo (e.g. `celebcity`) at github.com/new.
- In this folder:
  ```bash
  git init
  git add .
  git commit -m "Initial CelebCity site"
  git branch -M main
  git remote add origin https://github.com/<your-username>/celebcity.git
  git push -u origin main
  ```

### 2. Turn on GitHub Pages
- In the repo: **Settings → Pages → Build and deployment → Source → GitHub Actions**.
- Push to `main` (or wait for the next scheduled run) and the workflow will build + deploy
  automatically. Your site will be live at `https://<your-username>.github.io/celebcity/`.

### 3. Point your GoDaddy domain at it (free)
Edit `scripts/build.js` and change the `CNAME` value near the bottom (`writeFile("CNAME", ...)`)
to your real domain, e.g. `celebcity.com`, then commit/push.

In GoDaddy → **My Products → DNS** for your domain, add:

| Type  | Name | Value                  |
|-------|------|-------------------------|
| A     | @    | 185.199.108.153         |
| A     | @    | 185.199.109.153         |
| A     | @    | 185.199.110.153         |
| A     | @    | 185.199.111.153         |
| CNAME | www  | `<your-username>.github.io` |

(These four IPs are GitHub Pages' fixed apex-domain servers — free, no expiry.)

Then in GitHub repo **Settings → Pages → Custom domain**, enter your domain and save (also
check "Enforce HTTPS" once it's verified — GitHub issues a free SSL cert automatically).

DNS propagation can take anywhere from a few minutes to ~24 hours.

### 4. Set up Instagram auto-posting (free, one-time)

Instagram's publishing API only works for **Business or Creator accounts** linked to a
Facebook Page. This part has to be done by you (it's your account), roughly 10 minutes:

1. **Convert your Instagram account** to a Business or Creator account (Instagram app →
   Settings → Account type).
2. **Create a Facebook Page** (any name, e.g. "CelebCity") at facebook.com/pages/create if
   you don't have one, and link your Instagram account to it (Page Settings → Linked
   Accounts).
3. **Create a Meta developer app**: go to developers.facebook.com/apps → Create App → type
   "Other" → "Business". Add the **Instagram Graph API** product to it.
4. **Get a long-lived access token**: in the app's Graph API Explorer
   (developers.facebook.com/tools/explorer), select your app, request permissions
   `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`,
   generate a token, then exchange it for a long-lived token (60 days) using the
   [token debugger](https://developers.facebook.com/tools/debug/accesstoken/) "Extend Access
   Token" button, or the `oauth/access_token?grant_type=fb_exchange_token` endpoint. You'll
   need to repeat this every ~60 days unless you set up a System User token (Meta Business
   Suite → Business Settings → System Users), which doesn't expire.
5. **Find your Instagram Business Account ID**: call
   `GET https://graph.facebook.com/v21.0/me/accounts?access_token=<token>` to get your Page
   ID, then `GET https://graph.facebook.com/v21.0/<page-id>?fields=instagram_business_account&access_token=<token>`
   to get the Instagram user ID.
6. **Add GitHub secrets**: in your repo, **Settings → Secrets and variables → Actions**:
   - New repository secret `IG_USER_ID` = the Instagram Business Account ID from step 5
   - New repository secret `IG_ACCESS_TOKEN` = the long-lived token from step 4
   - (Optional) New repository variable `SITE_BASE_URL` = your real domain, e.g.
     `https://celebcity.com`, so Instagram captions link to the right place

Once those secrets exist, `instagram-photo.yml` (hourly) and `instagram-reel.yml` (every 3
hours) will automatically post to Instagram — no further action needed. If secrets aren't set
yet, both workflows run and skip harmlessly (check the Actions tab logs).

**Token expiry reminder**: unless you set up a System User token, the access token expires
every ~60 days and posting will silently stop until you generate a new one and update the
`IG_ACCESS_TOKEN` secret.

## Customizing what it covers

Edit the `FEEDS` array near the top of `scripts/build.js` to add/remove RSS sources, and the
`CATEGORY_RULES` array to change how articles get tagged (box office, OTT, fashion, etc.).

## Scheduling

- Site rebuild + Reel/graphic generation: every 3 hours (`.github/workflows/publish.yml`)
- Instagram photo: every hour, 10am-10pm IST (`.github/workflows/instagram-photo.yml`) — 13
  posts/day
- Instagram Reel: every 3 hours, 10am-10pm IST (`.github/workflows/instagram-reel.yml`) — 5
  posts/day
- Total ~18 posts/day, comfortably under Instagram's official limit of 100 API-published
  posts per rolling 24-hour period.

GitHub Actions free tier gives public repos **unlimited** scheduled-workflow minutes.

## What this is / isn't

- Articles are rewritten in CelebCity's own words using free, deterministic templates — not
  an LLM. Quality is decent but not polished, human-editorial prose. If you later want
  noticeably better rewrites, that requires an LLM API key and has a small per-article cost
  (ask if you want that added).
- A small text credit to the original source is kept at the bottom of each article for
  legal/trust reasons, even though nothing redirects the reader away from your site.
