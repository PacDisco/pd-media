# pd-media

Standalone field-upload PWA for Pacific Discovery. Deploys to `media.pacificdiscovery.org`.

Field staff open the URL on their phone, pick a trip, pick photos/videos from their camera roll, and the files upload directly to a Google Drive Shared Drive using Drive's resumable upload protocol — bytes go phone → Google CDN, not through this app. Failed/paused uploads automatically resume.

The office views uploads via the `field-media` card in pd-dashboard, which reads from this app's API.

---

## What you need before deploying

1. **Google Workspace Shared Drive** named "Field Uploads" (or anything). Shared Drives are different from regular folders — content belongs to the org, not the person who created it. Create one via Drive → Shared drives → New.
2. **Service account** with Content manager role on that shared drive. Reuse `invoices-uploader@invoice-tool-494123.iam.gserviceaccount.com` from the invoices integration — same JSON key, just give it shared drive access.
3. **Neon DB** — uses the same database as pd-dashboard. The schema additions (`field_trips`, `field_uploads` tables) live in pd-dashboard's `db/schema.sql`.

## Deploy steps

### 1. Run the schema migration on Neon

Open Neon SQL Editor and paste/run the section from pd-dashboard's `db/schema.sql` under the "Field media uploader" heading. Or paste this block directly:

```sql
CREATE TABLE IF NOT EXISTS field_trips (
  id SERIAL PRIMARY KEY,
  season TEXT NOT NULL,
  year INTEGER NOT NULL,
  program TEXT NOT NULL,
  drive_folder_id TEXT,
  drive_folder_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(season, year, program)
);
CREATE INDEX IF NOT EXISTS field_trips_active_idx ON field_trips(is_active, year DESC, season);

CREATE TABLE IF NOT EXISTS field_uploads (
  id SERIAL PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES field_trips(id) ON DELETE CASCADE,
  uploader_name TEXT,
  uploader_device_id TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  drive_file_id TEXT NOT NULL,
  drive_file_url TEXT NOT NULL,
  thumbnail_url TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'complete'
    CHECK (status IN ('pending', 'uploading', 'complete', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS field_uploads_trip_idx ON field_uploads(trip_id);
CREATE INDEX IF NOT EXISTS field_uploads_created_idx ON field_uploads(created_at DESC);
CREATE INDEX IF NOT EXISTS field_uploads_tags_idx ON field_uploads USING GIN (tags);
```

### 2. Get the Shared Drive ID

Open the shared drive in Google Drive. The URL is `drive.google.com/drive/folders/<DRIVE_ID>`. Copy that ID.

### 3. Push this repo to GitHub

```sh
cd pd-media
git init
git add .
git commit -m "Initial commit"
gh repo create boulderdigitalmedia/pd-media --public --source=. --push   # or use the GitHub UI
```

### 4. Create the Netlify site

In Netlify → Add new site → Import from Git → select `pd-media`. Build settings auto-detect from `netlify.toml`. Don't deploy yet.

### 5. Set environment variables

Netlify → site settings → Environment variables → add:

| Key | Value |
|---|---|
| `DATABASE_URL` | Your Neon connection string (same one in pd-dashboard) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON key, single line |
| `FIELD_UPLOADS_DRIVE_ID` | Shared Drive ID from step 2 |
| `ALLOWED_ORIGINS` | `https://pd-dashboards.netlify.app,https://dashboards.pacificdiscovery.org` (whatever your pd-dashboard site URL is) |
| `ADMIN_TOKEN` | Optional — long random string. If set, creating new trips requires the `X-Admin-Token` header. Leave unset for open trip-creation. |

### 6. Trigger deploy

Netlify → Deploys → Trigger deploy → Deploy site. Watch it finish.

### 7. Seed at least one trip

So the upload form has something to show. Either:

**Option A — admin tool curl:**
```sh
curl -X POST https://<your-site>.netlify.app/api/trips \
  -H "Content-Type: application/json" \
  ${ADMIN_TOKEN:+-H "X-Admin-Token: $ADMIN_TOKEN"} \
  -d '{"season":"Fall","year":2026,"program":"Bali"}'
```

**Option B — Neon SQL Editor:**
```sql
INSERT INTO field_trips (season, year, program) VALUES
  ('Fall', 2026, 'Bali'),
  ('Spring', 2026, 'Cambodia');
```

### 8. Custom domain (later)

When you're ready for `media.pacificdiscovery.org`:
- Netlify → Domain settings → Add custom domain → enter `media.pacificdiscovery.org`
- At your DNS provider, add a CNAME record pointing `media` → `<your-site>.netlify.app`
- Netlify auto-provisions Let's Encrypt cert (~5 min)
- After it's live, update `MEDIA_ORIGIN` in `pd-dashboard/field-media/index.html` if it doesn't already point there

### 9. Add the office card

In your `pd-dashboard` repo:
- The new `field-media/` folder is already there
- Commit + push as usual
- Build manifest auto-includes it on next deploy

### 10. Smoke test

1. Open the deployed pd-media URL on your phone.
2. iOS: Share → Add to Home Screen. Android: menu → Install app.
3. Open the installed PWA → pick the seeded trip → pick a photo → watch it upload.
4. Switch your phone to airplane mode mid-upload — the row should pause with a retry button.
5. Disable airplane mode. The upload should resume from where it left off.
6. Open pd-dashboard's Field Media card. The photo should appear under the trip.

---

## How resumable uploads work here

```
Field PWA                Netlify                Google Drive
   │                        │                        │
   │  POST /api/upload-init │                        │
   ├──────────────────────► │   POST /upload/files   │
   │                        ├──────────────────────► │
   │  uploadUrl             │   uploadUrl (resumable)│
   │ ◄──────────────────────┤◄───────────────────────┤
   │                                                  │
   │  PUT uploadUrl (chunk 1)                         │
   ├──────────────────────────────────────────────────►
   │  308 Resume Incomplete / Range: 0-8388607        │
   │ ◄────────────────────────────────────────────────┤
   │                                                  │
   │  PUT uploadUrl (chunk 2)                         │
   ├──────────────────────────────────────────────────►
   │  200 OK { id: "..." }                            │
   │ ◄────────────────────────────────────────────────┤
   │                                                  │
   │  POST /api/upload-complete                       │
   ├──────────────────► (writes row to DB)            │
```

- The uploadUrl is persisted to IndexedDB. If the phone restarts mid-upload, the next time the PWA opens it continues from `bytes_sent`.
- Each chunk is retried with exponential backoff on network errors and 5xx responses.
- For Android, the Service Worker registers a `sync` event that fires when connectivity returns and pokes the page to resume.
- For iOS (no Background Sync), the page listens for `visibilitychange` and `focus` events and resumes when the user opens the app.

## Caveats

- **iOS background uploads**: iOS suspends Safari and PWAs in the background. Uploads resume *as soon as the user reopens the app* on a network — they don't fire while the phone is locked. This is an Apple limitation, not something we can fix from the web.
- **iCloud-optimized photos**: if a user has iCloud "Optimize iPhone Storage" on and picks a photo that's only stored as a thumbnail on-device, iOS downloads the full size before exposing it to the page. Slow internet means slow downloads. The picker dialog shows a spinner; the file just won't appear until iCloud delivers it.
- **HEIC / HEVC**: iOS uploads in HEIC by default. The proxy preview in the office dashboard falls back to a generic tile (Chrome doesn't render HEIC inline). Most reviewers can download and open them. If this becomes a real problem, we can add server-side HEIC → JPEG conversion later.

## Local dev

```sh
cd pd-media
npm install
netlify dev
# Open http://localhost:8888
```

You need the env vars from step 5 set locally (e.g. via a `.env` file ignored by git).
