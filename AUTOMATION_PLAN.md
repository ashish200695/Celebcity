# Celebcity Automation Plan (React, no CMS/DB yet)

This plan sets you up to automatically collect, curate, and publish news/talks about top celebrities and important people, with a React frontend and a lightweight backend you can host later.

## 1) Core decisions (recommended defaults)

### Content scope
- **People list**: start with a curated list of top celebs/important people (50–200). Expand later.
- **Sources**: prioritize reputable outlets (BBC, Reuters, Variety, Billboard, People, etc.) + official social accounts.
- **Content types**: news, interviews, podcast clips, award announcements, public statements.

### Tech stack (minimal, scalable)
- **Frontend**: React (you already have this)
- **Backend**: Node.js (Express) or Next.js API routes
- **Database**: Postgres (Supabase or Railway) or MongoDB (Atlas)
- **Automation**: Scheduled jobs (cron) + background worker
- **Content pipeline**: RSS/API ingestion → dedupe → summarize → publish

## 2) Suggested architecture

```
Sources → Ingestion → Normalization → Deduping → Enrichment → Review → Publish → React UI
```

### Components
1. **Ingestion service**
   - Pulls data from RSS and APIs on a schedule.
   - Stores raw items in a staging table.

2. **Processing/Enrichment service**
   - Cleans HTML, extracts names, creates summaries, and adds tags.
   - Applies a confidence score for auto-publish vs review.

3. **Review queue (optional)**
   - Admin UI to approve/decline low-confidence items.

4. **Publishing service**
   - Saves public content and exposes an API for your React app.

## 3) Data model (starter)

### Tables/collections
- **people**: id, name, aliases, tags
- **sources**: id, name, url, credibility_score
- **raw_items**: id, source_id, title, body, url, published_at, hash
- **articles**: id, title, summary, body, people_ids, source_id, published_at, status

## 4) Automation workflow

1. **Fetch** (every 30–60 min)
   - Pull RSS feeds + APIs
   - Store in `raw_items`

2. **Deduplicate**
   - Hash `url + title`
   - Skip existing hashes

3. **Enrich**
   - Extract person names (NER)
   - Summarize content (LLM optional)
   - Add tags (event, award, controversy, interview)

4. **Publish**
   - Auto-publish if high confidence
   - Otherwise send to review queue

## 5) Tools/services you can use now

### News sources
- GNews API / NewsAPI
- Google News RSS
- YouTube API (for interviews)

### Scheduling
- GitHub Actions (if hosted on GitHub)
- Cron on your server
- Vercel/Netlify scheduled functions

### Summarization
- OpenAI API / Claude / HuggingFace
- Optional: no AI at first—store full content, summarize later

## 6) What to build first (MVP)

### Phase 1 (1–2 weeks)
- Setup DB
- Build ingestion for 5–10 sources
- Store raw items + dedupe
- Basic React page to list articles

### Phase 2
- Add summarization + tagging
- Add admin review UI
- Add SEO metadata

### Phase 3
- Expand sources + social feeds
- Add alerts + newsletter

## 7) Hosting recommendation (when ready)

- **Frontend**: Vercel or Netlify
- **Backend + DB**: Railway or Supabase
- **Jobs**: GitHub Actions or server cron

## 8) Next steps checklist

- [ ] Decide backend (Node/Express vs Next.js API)
- [ ] Choose DB (Postgres vs MongoDB)
- [ ] List 10 starter sources
- [ ] Confirm: do you want auto-publish or review first?

---

If you want, I can generate:
- a full project scaffold
- a list of starter RSS feeds/APIs
- an ingestion script with dedupe + tagging
