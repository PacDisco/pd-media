/**
 * POST /api/upload-complete
 *
 * The browser calls this once the resumable upload has finished and it
 * has the Drive file ID. We:
 *   1. Fetch the file's metadata (thumbnail, webViewLink) from Drive
 *   2. Insert a row into field_uploads so the office dashboard can list it
 *
 * Request:
 *   {
 *     trip_id:            12,
 *     drive_file_id:      "1xYz...",
 *     filename:           "IMG_3493.HEIC",
 *     mime_type:          "image/heic",
 *     size_bytes:         4823104,
 *     uploader_name:      "Alex",          // optional
 *     uploader_device_id: "...",           // localStorage UUID
 *     notes:              "..."            // optional
 *   }
 *
 * Response: { upload: <full row> }
 */
import { sql, drive, json, handleOptions } from "./_shared.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "POST")    return json(req, 405, { error: "POST only" });

  let body;
  try { body = await req.json(); }
  catch { return json(req, 400, { error: "Invalid JSON" }); }

  const tripId         = Number(body.trip_id);
  const driveFileId    = String(body.drive_file_id || "").trim();
  const filename       = String(body.filename || "").trim();
  const mime           = String(body.mime_type || "application/octet-stream");
  const sizeBytes      = body.size_bytes ? Number(body.size_bytes) : null;
  const uploaderName   = (body.uploader_name || null) || null;
  const uploaderDevice = (body.uploader_device_id || null) || null;
  const notes          = (body.notes || null) || null;

  if (!tripId)        return json(req, 400, { error: "trip_id required" });
  if (!driveFileId)   return json(req, 400, { error: "drive_file_id required" });
  if (!filename)      return json(req, 400, { error: "filename required" });

  // Fetch thumbnail + webViewLink from Drive.
  let meta = { webViewLink: null, thumbnailLink: null };
  try {
    const d = await drive();
    const r = await d.files.get({
      fileId: driveFileId,
      fields: "id,webViewLink,thumbnailLink,mimeType,size",
      supportsAllDrives: true,
    });
    meta = r.data || meta;
  } catch (e) {
    // Non-fatal — we still want to record the upload even if metadata is flaky.
    console.warn("Drive metadata fetch failed:", e.message);
  }

  try {
    const rows = await sql()`
      INSERT INTO field_uploads
        (trip_id, uploader_name, uploader_device_id, filename, mime_type, size_bytes,
         drive_file_id, drive_file_url, thumbnail_url, notes, status)
      VALUES
        (${tripId}, ${uploaderName}, ${uploaderDevice}, ${filename}, ${mime}, ${sizeBytes},
         ${driveFileId}, ${meta.webViewLink || ""}, ${meta.thumbnailLink || null}, ${notes}, 'complete')
      RETURNING *
    `;
    return json(req, 200, { upload: rows[0] });
  } catch (e) {
    return json(req, 500, { error: "DB insert failed: " + e.message });
  }
};
