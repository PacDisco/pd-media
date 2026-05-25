/**
 * Google Photos helpers: OAuth flow + Library API calls.
 *
 * Env vars (set on the pd-media Netlify site):
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   PUBLIC_ORIGIN            — e.g. https://media.pacificdiscovery.org
 *                              (used to compute the redirect_uri)
 */
import { sql } from "./_shared.mjs";

export const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/photoslibrary.appendonly",
  "https://www.googleapis.com/auth/photoslibrary.sharing",
];

export function oauthEnv() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  if (!clientId || !clientSecret || !publicOrigin) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and PUBLIC_ORIGIN env vars are required");
  }
  return {
    clientId,
    clientSecret,
    redirectUri: `${publicOrigin.replace(/\/$/, "")}/api/gphotos-auth-callback`,
  };
}

// Build the Google consent URL.
export function buildAuthUrl(state) {
  const { clientId, redirectUri } = oauthEnv();
  const params = new URLSearchParams({
    response_type: "code",
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope:         SCOPES.join(" "),
    access_type:   "offline",                    // ask for a refresh_token
    prompt:        "consent",                    // force refresh_token return on re-auth
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Exchange an auth code for tokens. Also fetches the user's email so we
// can key the token row by their identity.
export async function exchangeCodeForTokens(code) {
  const { clientId, clientSecret, redirectUri } = oauthEnv();
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    const t = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${t.slice(0, 300)}`);
  }
  const tokens = await tokenRes.json();
  // Get user's email via the userinfo endpoint
  const userinfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userinfoRes.ok) throw new Error("Could not read userinfo after OAuth");
  const userinfo = await userinfoRes.json();
  return { tokens, email: (userinfo.email || "").toLowerCase() };
}

// Save (or update) a user's tokens.
export async function storeTokens(email, tokens) {
  const expiresAt = new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000);
  // Google only returns a refresh_token on the first consent and (with
  // prompt=consent) on every re-consent. Be defensive: keep the old one
  // if no new one was returned.
  await sql()`
    INSERT INTO gphotos_tokens (email, access_token, refresh_token, expires_at, scope)
    VALUES (${email}, ${tokens.access_token},
            ${tokens.refresh_token || null},
            ${expiresAt.toISOString()},
            ${tokens.scope || null})
    ON CONFLICT (email) DO UPDATE
      SET access_token  = EXCLUDED.access_token,
          refresh_token = COALESCE(EXCLUDED.refresh_token, gphotos_tokens.refresh_token),
          expires_at    = EXCLUDED.expires_at,
          scope         = COALESCE(EXCLUDED.scope, gphotos_tokens.scope)
  `;
}

// Get a valid access token for the given user, refreshing if it's near expiry.
export async function getAccessToken(email) {
  const rows = await sql()`SELECT * FROM gphotos_tokens WHERE email = ${email}`;
  if (!rows.length) throw new Error("not-authorized");
  const t = rows[0];
  const expiresIn = new Date(t.expires_at).getTime() - Date.now();
  if (expiresIn > 60_000) return t.access_token;
  // Refresh
  if (!t.refresh_token) throw new Error("not-authorized");
  const { clientId, clientSecret } = oauthEnv();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    "refresh_token",
      refresh_token: t.refresh_token,
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    // Refresh token revoked → user needs to re-auth
    if (r.status === 400 || r.status === 401) throw new Error("not-authorized");
    throw new Error(`Token refresh failed (${r.status}): ${txt.slice(0, 200)}`);
  }
  const fresh = await r.json();
  await storeTokens(email, fresh);
  return fresh.access_token;
}

// --- Photos Library API wrappers ----------------------------------------

const PHOTOS_API = "https://photoslibrary.googleapis.com/v1";

async function gphotosFetch(token, path, init = {}) {
  const r = await fetch(`${PHOTOS_API}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  init.body && !init.bodyIsBinary ? "application/json" : (init.headers?.["Content-Type"] || "application/json"),
      ...(init.headers || {}),
    },
    body: init.bodyIsBinary ? init.body : (init.body ? JSON.stringify(init.body) : undefined),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Photos ${r.method || "POST"} ${path} → ${r.status}: ${txt.slice(0, 400)}`);
  }
  return r;
}

export async function createAlbum(token, title) {
  const r = await gphotosFetch(token, "/albums", {
    method: "POST",
    body:   { album: { title } },
  });
  return r.json();
}

export async function shareAlbum(token, albumId) {
  const r = await gphotosFetch(token, `/albums/${albumId}:share`, {
    method: "POST",
    body: {
      sharedAlbumOptions: {
        isCollaborative: false,    // viewers can't add photos
        isCommentable:   false,    // tweak if you want comments
      },
    },
  });
  return r.json();   // contains shareInfo.shareableUrl, shareToken, etc.
}

// Upload bytes → returns a short-lived "upload token"
export async function uploadBytes(token, mime, buffer) {
  const r = await fetch(`${PHOTOS_API}/uploads`, {
    method: "POST",
    headers: {
      "Authorization":            `Bearer ${token}`,
      "Content-type":             "application/octet-stream",
      "X-Goog-Upload-Content-Type": mime || "application/octet-stream",
      "X-Goog-Upload-Protocol":   "raw",
    },
    body: buffer,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Photos /uploads → ${r.status}: ${txt.slice(0, 300)}`);
  }
  return (await r.text()).trim();   // upload token
}

// Create media items from upload tokens, attaching them to an album.
export async function batchCreateMediaItems(token, albumId, items) {
  const r = await gphotosFetch(token, "/mediaItems:batchCreate", {
    method: "POST",
    body: {
      albumId,
      newMediaItems: items.map(it => ({
        description:     it.description || "",
        simpleMediaItem: { fileName: it.filename, uploadToken: it.uploadToken },
      })),
    },
  });
  return r.json();
}
