/**
 * PUT /api/upload-chunk?url=<google-resumable-url>
 *
 * Server-side proxy for Drive's resumable upload chunks. Receives binary
 * bytes from the browser and forwards them to Google with the original
 * Content-Range. This bypasses Drive's inconsistent CORS behavior on 308
 * (Resume Incomplete) responses — server-to-server requests don't care
 * about CORS at all.
 *
 * Browser sends:
 *   PUT /api/upload-chunk?url=<encoded-google-url>
 *   X-Content-Range: bytes 0-4194303/5963776
 *   Body: raw binary (max ~5MB to stay under Netlify's 6MB body limit)
 *
 * We respond with JSON describing what Google said:
 *   200 OK { status: 308, range: "bytes=0-4194303", body: null }
 *   200 OK { status: 200, range: null,            body: <Drive file metadata JSON> }
 *
 * The browser handles 308 / 200 the same way it did when calling Google
 * directly — only the transport changes.
 */
import { handleOptions, json } from "./_shared.mjs";

// CORS for non-JSON responses — we need to permit the X-Content-Range header.
function corsHeaders(origin) {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const allow = origin && allowed.includes(origin) ? origin : (allowed[0] || "*");
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Content-Range",
    "Vary": "Origin",
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.get?.("origin") || "";
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "PUT") return json(req, 405, { error: "PUT only" });

  const url          = new URL(req.url);
  const uploadUrl    = url.searchParams.get("url");
  const contentRange = req.headers.get("x-content-range");

  if (!uploadUrl)    return json(req, 400, { error: "?url= required" });
  if (!contentRange) return json(req, 400, { error: "X-Content-Range header required" });
  if (!uploadUrl.startsWith("https://www.googleapis.com/") &&
      !uploadUrl.startsWith("https://storage.googleapis.com/")) {
    return json(req, 400, { error: "Only googleapis.com upload URLs allowed" });
  }

  // Read the request body as bytes. Netlify Functions 2.0 supports
  // req.arrayBuffer() on raw bodies up to ~6MB.
  let buffer;
  try {
    buffer = await req.arrayBuffer();
  } catch (e) {
    return json(req, 413, { error: "Failed to read body: " + e.message });
  }

  // Forward to Google.
  let resp;
  try {
    resp = await fetch(uploadUrl, {
      method:  "PUT",
      headers: { "Content-Range": contentRange },
      body:    buffer,
    });
  } catch (e) {
    return json(req, 502, { error: "Upstream PUT failed: " + e.message });
  }

  const body = await resp.text();
  const origin = req.headers.get?.("origin") || "";
  return new Response(
    JSON.stringify({
      status: resp.status,
      range:  resp.headers.get("range"),
      body,
    }),
    {
      status: 200,
      headers: {
        "Content-Type":  "application/json",
        "Cache-Control": "no-store",
        ...corsHeaders(origin),
      },
    },
  );
};
