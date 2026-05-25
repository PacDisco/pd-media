/**
 * GET /api/uploads-list?trip_id=&from=&to=&limit=&q=
 *
 * Read endpoint for the office Field Media dashboard. CORS-enabled so
 * pd-dashboards (on its own domain) can call this.
 *
 * Query params (all optional):
 *   trip_id   — filter to a specific trip
 *   from / to — YYYY-MM-DD date range on created_at
 *   q         — substring match on filename / notes / uploader_name
 *   limit     — default 200, capped at 1000
 *   media     — 'image' | 'video' | 'other'
 */
import { sql, json, handleOptions } from "./_shared.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "GET")     return json(req, 405, { error: "GET only" });

  const url    = new URL(req.url);
  const tripId = url.searchParams.get("trip_id");
  const from   = url.searchParams.get("from");
  const to     = url.searchParams.get("to");
  const q      = url.searchParams.get("q");
  const media  = url.searchParams.get("media");
  const limit  = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 1000);

  try {
    // Build the query in fragments — neon's tagged-template form composes nicely
    // but conditional WHERE clauses are easier with the .query method.
    const where = ["fu.status = 'complete'"];
    const args  = [];
    if (tripId) { args.push(Number(tripId)); where.push(`fu.trip_id = $${args.length}`); }
    if (from)   { args.push(from);            where.push(`fu.created_at >= $${args.length}`); }
    if (to)     { args.push(to);              where.push(`fu.created_at <= $${args.length}`); }
    if (q) {
      args.push("%" + q.toLowerCase() + "%");
      where.push(`(LOWER(fu.filename) LIKE $${args.length} OR LOWER(COALESCE(fu.notes,'')) LIKE $${args.length} OR LOWER(COALESCE(fu.uploader_name,'')) LIKE $${args.length})`);
    }
    if (media === "image") where.push(`fu.mime_type LIKE 'image/%'`);
    if (media === "video") where.push(`fu.mime_type LIKE 'video/%'`);
    if (media === "other") where.push(`fu.mime_type NOT LIKE 'image/%' AND fu.mime_type NOT LIKE 'video/%'`);

    args.push(limit);
    const sqlText = `
      SELECT fu.id, fu.trip_id, fu.uploader_name, fu.filename, fu.mime_type, fu.size_bytes,
             fu.drive_file_id, fu.drive_file_url, fu.thumbnail_url, fu.tags, fu.notes,
             fu.created_at,
             ft.season, ft.year, ft.program, ft.drive_folder_url
        FROM field_uploads fu
        JOIN field_trips    ft ON ft.id = fu.trip_id
       WHERE ${where.join(" AND ")}
       ORDER BY fu.created_at DESC
       LIMIT $${args.length}
    `;
    const rows = await sql().query(sqlText, args);
    return json(req, 200, { uploads: rows, limit });
  } catch (e) {
    return json(req, 500, { error: e.message });
  }
};
