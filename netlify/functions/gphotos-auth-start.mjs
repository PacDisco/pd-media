/**
 * GET /api/gphotos-auth-start?return_origin=<origin>
 *
 * Kicks off the Google OAuth consent flow. The page that calls this opens
 * the resulting URL in a popup; after consent, gphotos-auth-callback posts
 * a message back to the opener and closes itself.
 */
import { buildAuthUrl } from "./_gphotos.mjs";
import { handleOptions, json } from "./_shared.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "GET")     return json(req, 405, { error: "GET only" });

  const url    = new URL(req.url);
  const origin = url.searchParams.get("return_origin") || "";
  // The state carries the origin that opened the popup so the callback page
  // can postMessage back to exactly that origin (not a wildcard).
  const state  = Buffer.from(JSON.stringify({ origin, nonce: Math.random().toString(36).slice(2) })).toString("base64url");

  try {
    const authUrl = buildAuthUrl(state);
    // Redirect the browser straight into Google's consent screen
    return new Response(null, { status: 302, headers: { Location: authUrl } });
  } catch (e) {
    return json(req, 500, { error: e.message });
  }
};
