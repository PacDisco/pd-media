/**
 * Gallery token helpers.
 *
 * Token format (URL-safe, no dependency on a JWT lib):
 *   v1.<tripId>.<expiresAt>.<sig>
 * where sig = base64url(HMAC-SHA256(secret, "v1.<tripId>.<expiresAt>"))
 * and `secret` is the per-trip secret stored in gallery_secrets.
 *
 * Rotating the per-trip secret revokes every previously issued link for
 * that trip without affecting other trips' galleries.
 */
import crypto from "node:crypto";
import { sql } from "./_shared.mjs";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Ensure a per-trip secret exists (creates one if missing). Returns the secret.
export async function ensureTripSecret(tripId) {
  const rows = await sql()`SELECT secret FROM gallery_secrets WHERE trip_id = ${tripId}`;
  if (rows.length) return rows[0].secret;
  const secret = crypto.randomBytes(32).toString("hex");
  await sql()`
    INSERT INTO gallery_secrets (trip_id, secret) VALUES (${tripId}, ${secret})
    ON CONFLICT (trip_id) DO NOTHING
  `;
  const again = await sql()`SELECT secret FROM gallery_secrets WHERE trip_id = ${tripId}`;
  return again[0].secret;
}

// Rotate the per-trip secret. Invalidates every previously issued link.
export async function rotateTripSecret(tripId) {
  const fresh = crypto.randomBytes(32).toString("hex");
  await sql()`
    INSERT INTO gallery_secrets (trip_id, secret, rotated_at)
    VALUES (${tripId}, ${fresh}, NOW())
    ON CONFLICT (trip_id) DO UPDATE
      SET secret = EXCLUDED.secret,
          rotated_at = NOW()
  `;
  return fresh;
}

export async function getTripSecret(tripId) {
  const rows = await sql()`SELECT secret FROM gallery_secrets WHERE trip_id = ${tripId}`;
  return rows.length ? rows[0].secret : null;
}

export function buildToken(tripId, expiresAt, secret) {
  const payload = `v1.${tripId}.${expiresAt}`;
  const sig     = b64url(crypto.createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

// Returns { tripId, expiresAt } if valid, or throws.
export async function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Bad token");
  const tripId    = Number(parts[1]);
  const expiresAt = Number(parts[2]);
  const sig       = parts[3];
  if (!tripId || !expiresAt) throw new Error("Bad token");
  if (Date.now() / 1000 > expiresAt) throw new Error("Link expired");

  const secret = await getTripSecret(tripId);
  if (!secret) throw new Error("Link revoked");

  const expected = b64url(crypto.createHmac("sha256", secret).update(`v1.${tripId}.${expiresAt}`).digest());
  if (!b64urlEqual(sig, expected)) throw new Error("Link revoked");

  return { tripId, expiresAt };
}
