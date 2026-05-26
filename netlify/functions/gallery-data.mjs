/**
 * GET /api/gallery-data?t=<token>
 *
 * Public endpoint hit by the gallery viewer page. Validates the token and
 * returns the trip's approved photos + videos. Returns 401 if the token
 * is invalid or revoked, 410 if expired.
 */
import { sql, json, handleOptions } from "./_shared.mjs";
import { verifyToken } from "./_gallery.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "GET")     return json(req, 405, { error: "GET only" });

  const url   = new URL(req.url);
  const token = url.searchParams.get("t");
  if (!token) return json(req, 400, { error: "Missing token" });

  let claims;
  try { claims = await verifyToken(token); }
  catch (e) {
    if (e.message === "Link expired") return json(req, 410, { error: "This gallery link has expired." });
    return json(req, 401, { error: "This gallery link is no longer valid." });
  }

  try {
    const tripRows = await sql()`
      SELECT id, season, year, program FROM field_trips WHERE id = ${claims.tripId}
    `;
    if (!tripRows.length) return json(req, 404, { error: "Trip no longer exists." });

    const uploads = await sql()`
      SELECT id, drive_file_id, filename, mime_type, created_at
        FROM field_uploads
       WHERE trip_id = ${claims.tripId}
         AND approved_for_gallery = TRUE
         AND status = 'complete'
       ORDER BY created_at DESC
    `;

    return json(req, 200, {
      trip:    tripRows[0],
      uploads,
      expires_at: claims.expiresAt,
    });
  } catch (e) {
    return json(req, 500, { error: e.message });
  }
};
