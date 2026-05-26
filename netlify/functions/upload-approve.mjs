/**
 * POST /api/upload-approve
 * Body: { id, approved }   OR   { ids: [...], approved }
 *
 * Toggle the approved_for_gallery flag on one or many uploads.
 * Called from the office Field Media dashboard (no extra auth beyond CORS).
 */
import { sql, json, handleOptions } from "./_shared.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "POST")    return json(req, 405, { error: "POST only" });

  let body;
  try { body = await req.json(); } catch { return json(req, 400, { error: "Invalid JSON" }); }

  const approved = !!body.approved;
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean)
            : body.id                  ? [Number(body.id)]
            :                            [];
  if (!ids.length) return json(req, 400, { error: "id or ids required" });

  try {
    const rows = await sql()`
      UPDATE field_uploads
         SET approved_for_gallery = ${approved}
       WHERE id = ANY(${ids}::int[])
       RETURNING id, approved_for_gallery
    `;
    return json(req, 200, { updated: rows });
  } catch (e) {
    return json(req, 500, { error: e.message });
  }
};
