/**
 * POST /api/gphotos-push
 * Body: { email, program, upload_ids: [123, 124, ...] }
 *
 * For each upload_id:
 *   1. Stream the file bytes from Drive (service-account auth)
 *   2. POST bytes to Photos /uploads → get an upload token
 *   3. Collect tokens and call mediaItems:batchCreate to attach them
 *      to the program's album in one shot.
 *
 * The selected uploads may span multiple trips (Spring + Fall Bali both
 * land in the same "Bali" album). All photos for a given program live in
 * a single album per owner_email.
 *
 * Limits per Google: batchCreate accepts up to 50 items per request — we chunk.
 *
 * Response:
 *   { album: { share_url, ... }, created: [...], failed: [{ upload_id, error }] }
 */
import { sql, json, handleOptions, driveAccessToken } from "./_shared.mjs";
import { getAccessToken, uploadBytes, batchCreateMediaItems } from "./_gphotos.mjs";

const BATCH = 50;

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "POST")    return json(req, 405, { error: "POST only" });

  let body;
  try { body = await req.json(); } catch { return json(req, 400, { error: "Invalid JSON" }); }

  const email   = String(body.email || "").trim().toLowerCase();
  const program = String(body.program || "").trim();
  const ids     = Array.isArray(body.upload_ids) ? body.upload_ids.map(Number).filter(Boolean) : [];
  if (!email || !program || !ids.length) return json(req, 400, { error: "email, program, upload_ids required" });

  // Get a fresh access token for the user
  let pToken;
  try { pToken = await getAccessToken(email); }
  catch (e) {
    if (e.message === "not-authorized") return json(req, 401, { error: "not-authorized" });
    return json(req, 500, { error: e.message });
  }

  // Album for this program?
  const albumRows = await sql()`SELECT * FROM gphotos_albums WHERE program = ${program} AND owner_email = ${email}`;
  if (!albumRows.length) return json(req, 400, { error: "Album not ready — call gphotos-album-ensure first" });
  const album = albumRows[0];

  // Pull the uploads (filtered to ones actually in this program via the
  // field_trips join — defensive against UIs that pass mismatched ids).
  const uploads = await sql()`
    SELECT fu.id, fu.drive_file_id, fu.filename, fu.mime_type
      FROM field_uploads fu
      JOIN field_trips    ft ON ft.id = fu.trip_id
     WHERE fu.id = ANY(${ids}::int[])
       AND ft.program = ${program}
  `;
  const idMap = new Map(uploads.map(u => [u.id, u]));

  const driveTok = await driveAccessToken();
  const tokens   = [];
  const failed   = [];

  for (const id of ids) {
    const u = idMap.get(id);
    if (!u) { failed.push({ upload_id: id, error: `Not in program ${program}` }); continue; }
    try {
      const driveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(u.drive_file_id)}?alt=media&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${driveTok}` } }
      );
      if (!driveRes.ok) throw new Error(`Drive ${driveRes.status}`);
      const buffer  = Buffer.from(await driveRes.arrayBuffer());
      const upToken = await uploadBytes(pToken, u.mime_type || "application/octet-stream", buffer);
      tokens.push({ upload_id: u.id, filename: u.filename, uploadToken: upToken });
    } catch (e) {
      failed.push({ upload_id: id, error: e.message });
    }
  }

  const created = [];
  for (let i = 0; i < tokens.length; i += BATCH) {
    const chunk = tokens.slice(i, i + BATCH);
    try {
      const r = await batchCreateMediaItems(pToken, album.album_id, chunk);
      const results = r.newMediaItemResults || [];
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const orig   = chunk[j];
        if (result.status?.code && result.status.code !== 0) {
          failed.push({ upload_id: orig.upload_id, error: result.status.message || "Photos rejected the item" });
        } else {
          created.push({ upload_id: orig.upload_id, photos_id: result.mediaItem?.id });
        }
      }
    } catch (e) {
      for (const c of chunk) failed.push({ upload_id: c.upload_id, error: e.message });
    }
  }

  return json(req, 200, { album, created, failed });
};
