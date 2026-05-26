/**
 * GET /api/gallery-file?t=<token>&id=<drive_file_id>[&download=1]
 *
 * Public-facing file proxy for the family gallery. Same as file-proxy.mjs
 * but locked down: only streams files that (a) belong to the trip the token
 * encodes, and (b) are flagged approved_for_gallery.
 *
 * This is what every <img> and <video> in the gallery viewer fetches.
 */
import { sql, driveAccessToken, json, handleOptions } from "./_shared.mjs";
import { verifyToken } from "./_gallery.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "GET")     return json(req, 405, { error: "GET only" });

  const url    = new URL(req.url);
  const token  = url.searchParams.get("t");
  const fileId = url.searchParams.get("id");
  const dl     = url.searchParams.get("download");

  if (!token)  return json(req, 400, { error: "Missing token" });
  if (!fileId) return json(req, 400, { error: "Missing id" });

  let claims;
  try { claims = await verifyToken(token); }
  catch { return json(req, 401, { error: "Link invalid or revoked." }); }

  // Make sure this file belongs to the token's trip AND is approved.
  const rows = await sql()`
    SELECT mime_type, filename
      FROM field_uploads
     WHERE drive_file_id = ${fileId}
       AND trip_id = ${claims.tripId}
       AND approved_for_gallery = TRUE
       AND status = 'complete'
  `;
  if (!rows.length) return json(req, 403, { error: "Not in this gallery." });
  const meta = rows[0];

  const accessToken = await driveAccessToken();
  const driveUrl    = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const headers     = { "Authorization": `Bearer ${accessToken}` };
  const range       = req.headers.get?.("range") || req.headers?.range;
  if (range) headers["Range"] = range;

  const upstream = await fetch(driveUrl, { headers });
  if (!upstream.ok && upstream.status !== 206) {
    const txt = await upstream.text();
    return json(req, upstream.status, { error: `Drive ${upstream.status}: ${txt.slice(0, 200)}` });
  }

  const out = {
    "Cache-Control": "private, max-age=3600",
    "Content-Type":  upstream.headers.get("content-type") || meta.mime_type || "application/octet-stream",
  };
  const cl = upstream.headers.get("content-length"); if (cl) out["Content-Length"] = cl;
  const cr = upstream.headers.get("content-range");  if (cr) out["Content-Range"]  = cr;
  const ar = upstream.headers.get("accept-ranges");  if (ar) out["Accept-Ranges"]  = ar;
  if (dl === "1" || dl === "true") {
    const safe = (meta.filename || "download").replace(/["\r\n]/g, "");
    out["Content-Disposition"] = `attachment; filename="${safe}"`;
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
};
