/**
 * POST /api/gallery-link
 * Body: { trip_id, ttl_days?, action? }   action in { 'create' (default), 'revoke' }
 *
 * Office endpoint. Returns a signed family-facing URL for the trip's gallery.
 *
 * Response:
 *   {
 *     url: "https://media.pacificdiscovery.org/gallery.html?t=v1.12.1812345.AbCd...",
 *     expires_at: 1812345,
 *     trip: { id, season, year, program, approved_count }
 *   }
 *
 * When action='revoke' the trip's secret is rotated FIRST, so the returned
 * URL is the new one and all previously distributed links are dead.
 */
import { sql, json, handleOptions } from "./_shared.mjs";
import { ensureTripSecret, rotateTripSecret, buildToken } from "./_gallery.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "POST")    return json(req, 405, { error: "POST only" });

  let body;
  try { body = await req.json(); } catch { return json(req, 400, { error: "Invalid JSON" }); }

  // Trip identification: caller passes either `trip_id` directly or the
  // natural key `(season, year, program)`. The student portal uses the
  // natural key since it already knows program metadata from HubSpot.
  const directId = body.trip_id ? Number(body.trip_id) : null;
  const season   = body.season  ? String(body.season).trim()  : null;
  const year     = body.year    ? Number(body.year)            : null;
  const program  = body.program ? String(body.program).trim()  : null;

  const ttlDays  = Math.min(365, Math.max(0, Number(body.ttl_days) || 30));
  // ttl_hours wins when present (used by the student-portal bridge for short-lived links)
  const ttlHours = body.ttl_hours ? Math.max(1, Number(body.ttl_hours)) : null;
  const action   = body.action === "revoke" ? "revoke" : "create";

  if (!directId && !(season && year && program)) {
    return json(req, 400, { error: "Provide trip_id OR (season, year, program)" });
  }

  try {
    const tripRows = directId
      ? await sql()`SELECT id, season, year, program FROM field_trips WHERE id = ${directId}`
      : await sql()`
          SELECT id, season, year, program FROM field_trips
           WHERE LOWER(season)  = LOWER(${season})
             AND year            = ${year}
             AND LOWER(program) = LOWER(${program})
        `;
    if (!tripRows.length) return json(req, 404, { error: "trip not found" });
    const trip  = tripRows[0];
    const tripId = trip.id;

    const secret = action === "revoke"
      ? await rotateTripSecret(tripId)
      : await ensureTripSecret(tripId);

    const ttlSeconds = ttlHours ? ttlHours * 3600 : ttlDays * 86400;
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const token     = buildToken(tripId, expiresAt, secret);

    const publicOrigin = (process.env.PUBLIC_ORIGIN || "").replace(/\/$/, "");
    const url = `${publicOrigin}/gallery.html?t=${encodeURIComponent(token)}`;

    // Approved photo count, for display
    const countRows = await sql()`
      SELECT COUNT(*)::int AS n FROM field_uploads
       WHERE trip_id = ${tripId} AND approved_for_gallery = TRUE
    `;

    return json(req, 200, {
      url,
      expires_at: expiresAt,
      trip: { ...trip, approved_count: countRows[0].n },
      action,
    });
  } catch (e) {
    return json(req, 500, { error: e.message });
  }
};
