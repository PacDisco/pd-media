/**
 * Shared helpers: DB client, Google auth, JSON helpers, CORS.
 *
 * Env vars (set in Netlify → site settings → environment variables):
 *   DATABASE_URL                 — Neon connection string (same DB as pd-dashboard)
 *   GOOGLE_SERVICE_ACCOUNT_JSON  — full JSON key as a single string
 *   FIELD_UPLOADS_DRIVE_ID       — Shared Drive ID where uploads go
 *   ALLOWED_ORIGINS              — comma-separated list of origins allowed to call
 *                                  the read endpoints (e.g. https://pd-dashboards.netlify.app)
 */
import { neon } from "@neondatabase/serverless";
import { google } from "googleapis";

// ---- Database -----------------------------------------------------------
let _sql;
export function sql() {
  if (!_sql) {
    const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL env var is not set");
    _sql = neon(url);
  }
  return _sql;
}

// ---- Google Drive -------------------------------------------------------
let _drive;
let _driveAccessToken;
let _driveTokenExpiresAt = 0;

function loadCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var is not set");
  let creds;
  try { creds = JSON.parse(raw); }
  catch (e) { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: " + e.message); }
  if (creds.private_key && creds.private_key.includes("\\n")) {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }
  return creds;
}

export async function drive() {
  if (_drive) return _drive;
  const auth = new google.auth.GoogleAuth({
    credentials: loadCredentials(),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const client = await auth.getClient();
  _drive = google.drive({ version: "v3", auth: client });
  return _drive;
}

// Returns a raw OAuth access token so we can hit Drive's resumable upload
// HTTP endpoint directly (googleapis npm package doesn't expose resumable
// initiation cleanly, so we POST to /upload/drive/v3/files ourselves).
export async function driveAccessToken() {
  const now = Date.now();
  if (_driveAccessToken && _driveTokenExpiresAt > now + 60_000) return _driveAccessToken;

  const auth = new google.auth.GoogleAuth({
    credentials: loadCredentials(),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const client = await auth.getClient();
  const { token, res } = await client.getAccessToken();
  _driveAccessToken    = token;
  // Token usually lives 1h; refresh 5min early to be safe.
  _driveTokenExpiresAt = (res?.data?.expiry_date) || (now + 55 * 60_000);
  return _driveAccessToken;
}

// ---- HTTP / CORS --------------------------------------------------------
function corsHeaders(origin) {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const allow = origin && allowed.includes(origin) ? origin : (allowed[0] || "*");
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

export function json(req, status, body) {
  const origin = req.headers.get?.("origin") || req.headers?.origin || "";
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

export function handleOptions(req) {
  const origin = req.headers.get?.("origin") || req.headers?.origin || "";
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// ---- Folder helpers -----------------------------------------------------
const SHARED_DRIVE_ID = () => {
  const id = process.env.FIELD_UPLOADS_DRIVE_ID;
  if (!id) throw new Error("FIELD_UPLOADS_DRIVE_ID env var is not set");
  return id;
};

// Look up (or create) a subfolder under the shared drive. Returns { id, webViewLink }.
export async function ensureTripFolder(trip) {
  if (trip.drive_folder_id) return { id: trip.drive_folder_id, webViewLink: trip.drive_folder_url };

  const name = `${trip.season} ${trip.year} - ${trip.program}`;
  const d = await drive();
  const driveId = SHARED_DRIVE_ID();

  // First, check if a folder with this name already exists at the root of the shared drive.
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${driveId}' in parents`;
  const found = await d.files.list({
    q,
    fields: "files(id,webViewLink)",
    corpora: "drive",
    driveId,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });

  if (found.data.files?.length) return found.data.files[0];

  const created = await d.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [driveId],
    },
    fields: "id,webViewLink",
    supportsAllDrives: true,
  });
  return created.data;
}
