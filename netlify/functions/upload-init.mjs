/**
 * POST /api/upload-init
 *
 * Mints a Google Drive resumable upload session for the field-upload PWA.
 * The browser then PUTs the file bytes directly to the returned uploadUrl —
 * Netlify is only involved in this one tiny request.
 *
 * Request:
 *   {
 *     trip_id: 12,
 *     filename: "IMG_3493.HEIC",
 *     mime_type: "image/heic",     // optional, defaults to application/octet-stream
 *     size_bytes: 4823104,         // optional, helps Drive validate the upload
 *     uploader_name: "Alex",       // optional
 *     uploader_device_id: "..."    // localStorage UUID — required, used for retry/dedupe
 *   }
 *
 * Response:
 *   {
 *     uploadUrl: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=...",
 *     folder:   { id, name, webViewLink }
 *   }
 *
 * Browser then:
 *   PUT uploadUrl
 *     Content-Range: bytes 0-N/total   (chunked upload)
 *     body: chunk bytes
 *   ...repeated until done. Final response has the Drive file metadata.
 *
 * Notes:
 *   - The uploadUrl is good for ~1 week. The browser saves it to IndexedDB
 *     so a paused upload can resume after the device is restarted.
 *   - Google charges nothing for resumable upload sessions.
 */
import { sql, drive, driveAccessToken, ensureTripFolder, json, handleOptions } from "./_shared.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "POST")    return json(req, 405, { error: "POST only" });

  let body;
  try { body = await req.json(); }
  catch { return json(req, 400, { error: "Invalid JSON" }); }

  const tripId    = Number(body.trip_id);
  const filename  = String(body.filename || "").trim();
  const mime      = String(body.mime_type || "application/octet-stream").trim();
  const sizeBytes = body.size_bytes ? Number(body.size_bytes) : undefined;

  if (!tripId)           return json(req, 400, { error: "trip_id required" });
  if (!filename)         return json(req, 400, { error: "filename required" });

  // 1. Load the trip so we know which folder to upload into.
  let trip;
  try {
    const rows = await sql()`SELECT * FROM field_trips WHERE id = ${tripId} AND is_active = TRUE`;
    if (!rows.length) return json(req, 404, { error: "trip not found or inactive" });
    trip = rows[0];
  } catch (e) { return json(req, 500, { error: "DB lookup failed: " + e.message }); }

  // 2. Ensure the trip's Drive folder exists. Cache the ID back to the row.
  let folder;
  try {
    folder = await ensureTripFolder(trip);
    if (!trip.drive_folder_id) {
      await sql()`
        UPDATE field_trips
           SET drive_folder_id = ${folder.id},
               drive_folder_url = ${folder.webViewLink}
         WHERE id = ${trip.id}
      `;
    }
  } catch (e) {
    return json(req, 502, { error: "Drive folder setup failed: " + e.message });
  }

  // 3. Initiate the Drive resumable upload session.
  // We POST to /upload/drive/v3/files with uploadType=resumable; Drive responds
  // with a Location header — that's the URL the browser will PUT the file to.
  let uploadUrl;
  try {
    const token = await driveAccessToken();
    const initRes = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
      {
        method: "POST",
        headers: {
          "Authorization":          `Bearer ${token}`,
          "Content-Type":           "application/json; charset=UTF-8",
          "X-Upload-Content-Type":  mime,
          ...(sizeBytes ? { "X-Upload-Content-Length": String(sizeBytes) } : {}),
        },
        body: JSON.stringify({
          name:    filename,
          parents: [folder.id],
          mimeType: mime,
        }),
      }
    );
    if (initRes.status !== 200) {
      const errBody = await initRes.text();
      return json(req, 502, { error: `Drive upload init failed (${initRes.status}): ${errBody.slice(0, 300)}` });
    }
    uploadUrl = initRes.headers.get("location");
    if (!uploadUrl) return json(req, 502, { error: "Drive did not return an upload URL" });
  } catch (e) {
    return json(req, 502, { error: "Drive init request failed: " + e.message });
  }

  return json(req, 200, {
    uploadUrl,
    folder: { id: folder.id, webViewLink: folder.webViewLink },
    trip:   { id: trip.id, season: trip.season, year: trip.year, program: trip.program },
  });
};
