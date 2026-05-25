/**
 * Trip management endpoint.
 *
 *   GET  /api/trips                       → active trips (for upload PWA dropdown)
 *   GET  /api/trips?include_inactive=1    → all trips (for office admin UI)
 *   POST /api/trips                       → create:   { season, year, program }
 *   POST /api/trips                       → update:   { id, patch: { season?, year?, program?, is_active? } }
 *
 * If ADMIN_TOKEN env var is set, POST requests must include matching
 * X-Admin-Token header. Otherwise POST is open (rely on the office
 * dashboard's auth gate).
 */
import { sql, json, handleOptions } from "./_shared.mjs";

const SEASONS = new Set(["Spring", "Summer", "Fall", "Winter"]);

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method === "GET")     return list(req);
  if (req.method === "POST")    return mutate(req);
  return json(req, 405, { error: "Method not allowed" });
};

async function list(req) {
  const url = new URL(req.url);
  const all = url.searchParams.get("include_inactive") === "1";
  try {
    const rows = all
      ? await sql()`
          SELECT id, season, year, program, drive_folder_url, is_active, created_at
            FROM field_trips
           ORDER BY is_active DESC, year DESC, season, program
        `
      : await sql()`
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

async function mutate(req) {
  const required = process.env.ADMIN_TOKEN;
  if (required) {
    const given = req.headers.get?.("x-admin-token") || req.headers?.["x-admin-token"];
    if (given !== required) return json(req, 401, { error: "Admin token required" });
  }

  let body;
  try { body = await req.json(); }
  catch { return json(req, 400, { error: "Invalid JSON" }); }

  // Update path: { id, patch: {...} }
  if (body.id && body.patch) return updateTrip(req, body);
  // Create path: { season, year, program }
  return createTrip(req, body);
}

async function createTrip(req, body) {
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
}

async function updateTrip(req, body) {
  const id = Number(body.id);
  if (!id) return json(req, 400, { error: "id required" });
  const patch = body.patch || {};

  const sets = [];
  const args = [];
  if ("season"    in patch) {
    if (!SEASONS.has(patch.season)) return json(req, 400, { error: `bad season` });
    args.push(patch.season);  sets.push(`season = $${args.length}`);
  }
  if ("year"      in patch) {
    const y = Number(patch.year);
    if (!Number.isInteger(y) || y < 2020 || y > 2050) return json(req, 400, { error: "bad year" });
    args.push(y);             sets.push(`year = $${args.length}`);
  }
  if ("program"   in patch) {
    const p = String(patch.program || "").trim();
    if (!p) return json(req, 400, { error: "program cannot be empty" });
    args.push(p);             sets.push(`program = $${args.length}`);
  }
  if ("is_active" in patch) {
    args.push(!!patch.is_active);
    sets.push(`is_active = $${args.length}`);
  }
  if (!sets.length) return json(req, 400, { error: "no updatable fields in patch" });

  args.push(id);
  try {
    const rows = await sql().query(
      `UPDATE field_trips SET ${sets.join(", ")} WHERE id = $${args.length}
       RETURNING id, season, year, program, drive_folder_url, is_active`,
      args
    );
    if (!rows.length) return json(req, 404, { error: "trip not found" });
    return json(req, 200, { trip: rows[0] });
  } catch (e) {
    return json(req, 500, { error: e.message });
  }
}
