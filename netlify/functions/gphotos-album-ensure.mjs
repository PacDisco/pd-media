/**
 * POST /api/gphotos-album-ensure
 * Body: { email, program }
 *
 * Returns the Google Photos album that this user has for this program,
 * creating one (and making it shareable) if it doesn't exist yet. One album
 * per (program, user) — Spring 2026 Bali + Fall 2026 Bali both land in the
 * same "Bali" album.
 *
 * Response: { album: { album_id, album_title, product_url, share_url, ... } }
 */
import { sql, json, handleOptions } from "./_shared.mjs";
import { getAccessToken, createAlbum, shareAlbum } from "./_gphotos.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "POST")    return json(req, 405, { error: "POST only" });

  let body;
  try { body = await req.json(); } catch { return json(req, 400, { error: "Invalid JSON" }); }

  const email   = String(body.email || "").trim().toLowerCase();
  const program = String(body.program || "").trim();
  if (!email)   return json(req, 400, { error: "email required" });
  if (!program) return json(req, 400, { error: "program required" });

  let token;
  try { token = await getAccessToken(email); }
  catch (e) {
    if (e.message === "not-authorized") return json(req, 401, { error: "not-authorized" });
    return json(req, 500, { error: e.message });
  }

  // Already have one?
  const existing = await sql()`SELECT * FROM gphotos_albums WHERE program = ${program} AND owner_email = ${email}`;
  if (existing.length) return json(req, 200, { album: existing[0] });

  // Title is the bare program name — the family-facing label.
  // (Owner sees this title in their personal Google Photos library too.)
  const title = `Pacific Discovery · ${program}`;

  try {
    const album      = await createAlbum(token, title);
    const albumId    = album.id;
    const productUrl = album.productUrl;

    const shared     = await shareAlbum(token, albumId);
    const shareUrl   = shared?.shareInfo?.shareableUrl || null;
    const shareTok   = shared?.shareInfo?.shareToken    || null;

    const rows = await sql()`
      INSERT INTO gphotos_albums (program, owner_email, album_id, album_title, product_url, share_url, share_token)
      VALUES (${program}, ${email}, ${albumId}, ${title}, ${productUrl || null}, ${shareUrl}, ${shareTok})
      RETURNING *
    `;
    return json(req, 200, { album: rows[0] });
  } catch (e) {
    return json(req, 502, { error: "Google Photos: " + e.message });
  }
};
