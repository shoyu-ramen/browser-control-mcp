import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifySignature } from "../lib/signature.js";

const secret = "whsec_test";
const body = Buffer.from(JSON.stringify({ meta: { event_name: "order_created" } }));
const goodSig = crypto.createHmac("sha256", secret).update(body).digest("hex");

test("accepts a correct signature", () => {
  assert.equal(verifySignature(body, goodSig, secret), true);
});

test("rejects a tampered body", () => {
  const tampered = Buffer.from(body.toString() + " ");
  assert.equal(verifySignature(tampered, goodSig, secret), false);
});

test("rejects a wrong secret", () => {
  assert.equal(verifySignature(body, goodSig, "whsec_other"), false);
});

test("fail-closed on missing secret or signature", () => {
  assert.equal(verifySignature(body, goodSig, ""), false);
  assert.equal(verifySignature(body, "", secret), false);
  assert.equal(verifySignature(null, goodSig, secret), false);
});
