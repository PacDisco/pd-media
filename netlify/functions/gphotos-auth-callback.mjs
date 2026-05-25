/**
 * GET /api/gphotos-auth-callback?code=...&state=...
 *
 * Google redirects the browser here after consent. We:
 *   1. Exchange the code for tokens
 *   2. Look up the user's email from Google userinfo
 *   3. Store tokens in DB keyed by email
 *   4. Return an HTML page that postMessages success back to the opener
 *      (the field-media dashboard) and closes itself.
 */
import { exchangeCodeForTokens, storeTokens } from "./_gphotos.mjs";

const html = (body) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Google Photos</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px;text-align:center;}h1{margin-bottom:8px;}p{color:#94a3b8;}code{background:#1e293b;padding:4px 8px;border-radius:4px;color:#fca5a5;}</style>
</head><body>${body}</body></html>`,
  { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });

export default async (req) => {
  const url   = new URL(req.url);
  const code  = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return html(`<h1>❌ Authorization failed</h1><p><code>${escapeHtml(error)}</code></p><p>You can close this window.</p>`);
  }
  if (!code) {
    return html(`<h1>❌ Missing code</h1><p>You can close this window.</p>`);
  }

  let parsedState = {};
  try { parsedState = JSON.parse(Buffer.from(state || "", "base64url").toString("utf8")); } catch {}
  const origin = String(parsedState.origin || "*");

  try {
    const { tokens, email } = await exchangeCodeForTokens(code);
    if (!email) throw new Error("Google didn't return an email");
    await storeTokens(email, tokens);
    return html(`
      <h1>✅ Connected!</h1>
      <p>Signed in as <strong>${escapeHtml(email)}</strong>. You can close this window.</p>
      <script>
        try {
          window.opener?.postMessage(
            { type: "gphotos-auth-success", email: ${JSON.stringify(email)} },
            ${JSON.stringify(origin)}
          );
        } catch (e) {}
        setTimeout(() => window.close(), 600);
      </script>
    `);
  } catch (e) {
    return html(`
      <h1>❌ Couldn't complete sign-in</h1>
      <p><code>${escapeHtml(e.message)}</code></p>
      <p>You can close this window and try again.</p>
      <script>
        try {
          window.opener?.postMessage(
            { type: "gphotos-auth-error", error: ${JSON.stringify(e.message)} },
            ${JSON.stringify(origin)}
          );
        } catch (e) {}
      </script>
    `);
  }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
