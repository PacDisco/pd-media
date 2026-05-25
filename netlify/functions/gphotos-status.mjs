/**
 * GET /api/gphotos-status?email=<email>
 *
 * Used by the field-media dashboard to know whether the current user has
 * already authorized Google Photos (so we don't pop a needless OAuth window).
 *
 * Response: { authorized: bool, email, expires_at }
 */
import { sql, json, handleOptions } from "./_shared.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "GET")     return json(req, 405, { error: "GET only" });

  const url   = new URL(req.url);
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  if (!email) return json(req, 200, { authorized: false });

  try {
    const rows = await sql()`SELECT email, expires_at, refresh_token IS NOT NULL AS has_refresh
                               FROM gphotos_tokens WHERE email = ${email}`;
    if (!rows.length) return json(req, 200, { authorized: false });
    return json(req, 200, {
      authorized:  true,
      email:       rows[0].email,
      expires_at:  rows[0].expires_at,
      has_refresh: rows[0].has_refresh,
    });
  } catch (e) {
    return json(req, 500, { error: e.message });
  }
};
