/**
 * GET /api/file-proxy?id=<drive_file_id>[&download=1]
 *
 * Streams a Drive file through this site so office viewers can open photos
 * and play videos without needing their own Google account (the dashboard
 * already gates access). Uses the service account credentials.
 *
 * Range requests are forwarded so video <video> playback can seek properly.
 */
import { driveAccessToken, handleOptions, json } from "./_shared.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "GET")     return json(req, 405, { error: "GET only" });

  const url     = new URL(req.url);
  const fileId  = url.searchParams.get("id");
  const dl      = url.searchParams.get("download");
  if (!fileId)  return json(req, 400, { error: "id required" });

  const token = await driveAccessToken();

  // alt=media tells Drive to stream bytes (vs returning JSON metadata).
  const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;

  const headers = { "Authorization": `Bearer ${token}` };
  const range = req.headers.get?.("range") || req.headers?.range;
  if (range) headers["Range"] = range;

  const upstream = await fetch(driveUrl, { headers });
  if (!upstream.ok && upstream.status !== 206) {
    const txt = await upstream.text();
    return json(req, upstream.status, { error: `Drive ${upstream.status}: ${txt.slice(0, 300)}` });
  }

  const out = {
    "Cache-Control": "private, max-age=86400",
    "Content-Type":  upstream.headers.get("content-type") || "application/octet-stream",
  };
  const cl   = upstream.headers.get("content-length");
  const cr   = upstream.headers.get("content-range");
  const ar   = upstream.headers.get("accept-ranges");
  if (cl) out["Content-Length"] = cl;
  if (cr) out["Content-Range"]  = cr;
  if (ar) out["Accept-Ranges"]  = ar;
  if (dl === "1" || dl === "true") {
    out["Content-Disposition"] = `attachment`;
  }

  return new Response(upstream.body, {
    status:  upstream.status,
    headers: out,
  });
};
