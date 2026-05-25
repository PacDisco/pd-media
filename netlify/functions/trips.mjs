/**
 * GET /api/trips         → active trips for the upload form dropdown
 * POST /api/trips        → admin creates a new trip (no auth gate yet; behind a shared
 *                          admin token if you want one — set ADMIN_TOKEN env var
 *                          and require it in the X-Admin-Token header).
 */
import { sql, json, handleOptions } from "./_shared.mjs";

const SEASONS = new Set(["Spring", "Summer", "Fall", "Winter"]);

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method === "GET")  return list(req);
  if (req.method === "POST") return create(req);
  return json(req, 405, { error: "Method not allowed" });
};

async function list(req) {
  try {
    const rows = await sql()`
      SELECT id, season, year, program, drive_folder_url, is_active
        FROM field_trips
       WHERE is_active = TRUE
       ORDER BY year DESC, season, program
    `;
    return json(req, 200, { trips: rows });
  } catch (e) {
    return json(req, 500, { error: e.message });
  }
}

async function create(req) {
  // Optional admin gate
  const required = process.env.ADMIN_TOKEN;
  if (required) {
    const given = req.headers.get?.("x-admin-token") || req.headers?.["x-admin-token"];
    if (given !== required) return json(req, 401, { error: "Admin token required" });
  }

  let body;
  try { body = await req.json(); }
  catch { return json(req, 400, { error: "Invalid JSON" }); }

  const season  = String(body.season  || "").trim();
  const year    = Number(body.year);
  const program = String(body.program || "").trim();

  if (!SEASONS.has(season))      return json(req, 400, { error: `season must be one of ${[...SEASONS].join(", ")}` });
  if (!Number.isInteger(year) || year < 2020 || year > 2050)
                                  return json(req, 400, { error: "year must be a 4-digit integer between 2020 and 2050" });
  if (!program)                   return json(req, 400, { error: "program is required" });

  try {
    const rows = await sql()`
      INSERT INTO field_trips (season, year, program)
      VALUES (${season}, ${year}, ${program})
      ON CONFLICT (season, year, program) DO UPDATE
        SET is_active = TRUE
      RETURNING id, season, year, program, drive_folder_url, is_active
    `;
    return json(req, 200, { trip: rows[0] });
  } catch (e) {
    return json(req, 500, { error: e.message });
  }
};
