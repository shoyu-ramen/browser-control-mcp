// ── Configuration ──────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for the LemonSqueezy checkout URL.
// Format: https://YOURSTORE.lemonsqueezy.com/checkout/buy/VARIANT_UUID
// If the variant changes, update it HERE first, then mirror to site/index.html
// (3 buy links: hero, pricing card, footer). popup.js reads this constant
// directly, so the popup needs no separate update.
const PURCHASE_URL = "https://browser-control-mcp.lemonsqueezy.com/checkout/buy/920548b5-6f48-458a-874e-7871048f334d";

// License calls go through our license service (which proxies LemonSqueezy and
// answers with a derived entitlement {tier, seats, grace_until}). Disclosed in
// the privacy policy: the license key — and nothing else — is sent to our
// license service and the payment provider for validation.
const LICENSE_API = "https://browser-control-license-production.up.railway.app/v1/licenses";

const REVALIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Storage helpers ───────────────────────────────────────────────────────

async function getLicenseData() {
  const result = await chrome.storage.sync.get("license");
  return result.license || null;
}

async function setLicenseData(data) {
  await chrome.storage.sync.set({ license: data });
}

async function clearLicenseData() {
  await chrome.storage.sync.remove("license");
}

// ── License service API ──────────────────────────────────────────────────

// Entitlement is server-derived; this fallback only covers a response from a
// pre-entitlement server build (or LS directly): valid key → pro, else free.
function entitlementOf(data) {
  if (data.entitlement && (data.entitlement.tier === "pro" || data.entitlement.tier === "free")) {
    return data.entitlement;
  }
  const ok = data.valid === true || data.activated === true;
  return { tier: ok ? "pro" : "free", seats: ok ? 1 : 0, grace_until: null };
}

async function activateLicense(licenseKey) {
  const resp = await fetch(`${LICENSE_API}/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      license_key: licenseKey,
      instance_name: "Browser Control MCP – Chrome",
    }),
  });
  const data = await resp.json();
  // LemonSqueezy answers activate with `activated` (validate answers `valid`);
  // our proxy normalizes both into entitlement, but stay defensive.
  const ok = data.activated === true || data.valid === true;
  if (!ok) {
    return { success: false, error: data.error || "Invalid license key" };
  }
  const ent = entitlementOf(data);
  await setLicenseData({
    key: licenseKey,
    instanceId: data.instance?.id || null,
    status: "active",
    tier: ent.tier,
    seats: ent.seats,
    graceUntil: ent.grace_until,
    validatedAt: Date.now(),
  });
  return { success: true };
}

// Returns { tier: "pro"|"free", status, offline? }. Network/server failures are
// NOT a verdict on the key: within the bounded grace window (server-issued
// grace_until, default 72h) the cached tier holds; past it, free tier. A
// definitive valid:false (revoked/refunded key) downgrades immediately.
async function validateLicense(force) {
  const lic = await getLicenseData();
  if (!lic || !lic.key) return { tier: "free", status: "no_key" };

  const fresh =
    !force && lic.validatedAt && Date.now() - lic.validatedAt < REVALIDATE_INTERVAL_MS;
  if (fresh && lic.status === "active") {
    return { tier: lic.tier || "pro", status: "licensed", cached: true };
  }

  try {
    const body = { license_key: lic.key };
    if (lic.instanceId) body.instance_id = lic.instanceId;

    const resp = await fetch(`${LICENSE_API}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.status >= 500) throw new Error(`license service ${resp.status}`);
    const data = await resp.json();

    const ent = entitlementOf(data);
    const verdictValid = data.valid === true;
    await setLicenseData({
      ...lic,
      status: verdictValid ? "active" : "invalid",
      tier: ent.tier,
      seats: ent.seats,
      graceUntil: verdictValid ? ent.grace_until : null,
      validatedAt: Date.now(),
    });
    return verdictValid
      ? { tier: ent.tier, status: "licensed" }
      : { tier: "free", status: "invalid_key" };
  } catch {
    // Offline / service unreachable — bounded grace, not trust-forever.
    const inGrace =
      lic.status === "active" && lic.graceUntil && Date.now() < Date.parse(lic.graceUntil);
    if (inGrace) {
      return { tier: lic.tier || "pro", status: "licensed", offline: true };
    }
    return { tier: "free", status: "grace_expired", offline: true };
  }
}

async function deactivateLicense() {
  const lic = await getLicenseData();
  if (!lic || !lic.key) return;

  try {
    const body = { license_key: lic.key };
    if (lic.instanceId) body.instance_id = lic.instanceId;
    await fetch(`${LICENSE_API}/deactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Best-effort deactivation
  }
  await clearLicenseData();
}

// ── Main access check ─────────────────────────────────────────────────────
// Freemium: access is never hard-denied. tier is "pro" (valid license, or
// within the offline grace window) or "free" (everyone else). Per-tool Pro
// gating happens in the MCP server's registry (lib/mcp.js), which reads this
// tier via the get_license_status command — that registry list is the single
// monetization knob.

async function checkAccess() {
  const v = await validateLicense(false);
  if (v.tier === "pro") {
    return { allowed: true, status: v.status, tier: "pro", offline: !!v.offline };
  }
  const notices = {
    invalid_key: "Your license key is invalid or revoked — running on the free tier.",
    grace_expired:
      "Couldn't revalidate your license (offline too long) — running on the free tier until the license service is reachable.",
  };
  return {
    allowed: true,
    status: v.status,
    tier: "free",
    ...(notices[v.status] ? { notice: notices[v.status] } : {}),
  };
}

// ── Status summary for popup ──────────────────────────────────────────────

async function getLicenseStatus() {
  const lic = await getLicenseData();
  const v = await validateLicense(false);
  if (v.tier === "pro") {
    return { status: "pro", key: lic?.key || "", offline: !!v.offline };
  }
  return { status: "free", reason: v.status };
}
