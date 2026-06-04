import crypto from "node:crypto";

// LemonSqueezy signs each webhook with HMAC-SHA256 over the raw request body,
// keyed by the endpoint's signing secret, and sends the hex digest in `X-Signature`.
// Compare in constant time. Returns false on any missing input (fail-closed).
export function verifySignature(rawBody, signatureHex, secret) {
  if (!secret || !signatureHex || rawBody == null) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(String(signatureHex), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
