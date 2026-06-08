// ── Configuration ──────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for the LemonSqueezy checkout URL.
// Format: https://YOURSTORE.lemonsqueezy.com/checkout/buy/VARIANT_UUID
// If the variant changes, update it HERE first, then mirror to site/index.html
// (3 buy links: hero, pricing card, footer). popup.js reads this constant
// directly, so the popup needs no separate update.
const PURCHASE_URL = "https://browser-control-mcp.lemonsqueezy.com/checkout/buy/920548b5-6f48-458a-874e-7871048f334d";

const LS_API = "https://api.lemonsqueezy.com/v1/licenses";
const TRIAL_DAYS = 7;
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

async function getTrialStart() {
  const result = await chrome.storage.local.get("trialStart");
  return result.trialStart || null;
}

async function setTrialStart(timestamp) {
  await chrome.storage.local.set({ trialStart: timestamp });
}

// ── Trial ─────────────────────────────────────────────────────────────────

function trialDaysRemaining(trialStart) {
  if (!trialStart) return 0;
  const elapsed = Date.now() - trialStart;
  const remaining = TRIAL_DAYS - elapsed / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.ceil(remaining));
}

async function initTrial() {
  const existing = await getTrialStart();
  if (!existing) {
    await setTrialStart(Date.now());
  }
}

// ── LemonSqueezy API ─────────────────────────────────────────────────────

async function activateLicense(licenseKey) {
  const resp = await fetch(`${LS_API}/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      license_key: licenseKey,
      instance_name: "Browser Control MCP – Chrome",
    }),
  });
  const data = await resp.json();
  if (!data.valid) {
    return { success: false, error: data.error || "Invalid license key" };
  }
  const stored = {
    key: licenseKey,
    instanceId: data.instance?.id || null,
    status: "active",
    validatedAt: Date.now(),
  };
  await setLicenseData(stored);
  return { success: true };
}

async function validateLicense(force) {
  const lic = await getLicenseData();
  if (!lic || !lic.key) return { valid: false, reason: "no_key" };

  if (!force && lic.validatedAt && Date.now() - lic.validatedAt < REVALIDATE_INTERVAL_MS) {
    return { valid: lic.status === "active", cached: true };
  }

  try {
    const body = { license_key: lic.key };
    if (lic.instanceId) body.instance_id = lic.instanceId;

    const resp = await fetch(`${LS_API}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    lic.status = data.valid ? "active" : "invalid";
    lic.validatedAt = Date.now();
    await setLicenseData(lic);
    return { valid: data.valid, cached: false };
  } catch {
    // Network error — trust the cached status for now
    return { valid: lic.status === "active", cached: true, offline: true };
  }
}

async function deactivateLicense() {
  const lic = await getLicenseData();
  if (!lic || !lic.key) return;

  try {
    const body = { license_key: lic.key };
    if (lic.instanceId) body.instance_id = lic.instanceId;
    await fetch(`${LS_API}/deactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Best-effort deactivation
  }
  await clearLicenseData();
}

// ── Premium gating ─────────────────────────────────────────────────────────
// Commands that require an active license once the trial ends. Anything NOT in
// this list stays usable on the free tier, so a user whose trial expired (or
// whose payment was declined) is never fully locked out — the old behaviour
// hard-blocked every command and dead-ended on a Buy button that could fail.
//
// This list is the single monetization knob. It ships EMPTY (free tier == full
// access) on purpose: turning on enforcement, and deciding exactly which
// commands are premium, is a deliberate product/revenue decision made in ONE
// place — not a silent default baked in here. Populate with command names
// (e.g. "execute_js", "fill_field", "click_element") to gate them.
const PREMIUM_COMMANDS = [];

function isPremiumCommand(command) {
  return PREMIUM_COMMANDS.includes(command);
}

// ── Main access check ─────────────────────────────────────────────────────
// Returns { allowed, status, tier, ... }. `tier` is "full" (licensed or active
// trial) or "free" (trial ended / key lapsed). Access is never hard-denied here
// anymore; per-command gating happens in background.js via isPremiumCommand().

async function checkAccess() {
  const lic = await getLicenseData();
  if (lic && lic.key) {
    const v = await validateLicense(false);
    if (v.valid) return { allowed: true, status: "licensed", tier: "full" };
    // Key present but invalid/revoked: degrade to the free tier instead of
    // bricking the extension (a lapsed key should not be a dead-end).
    return {
      allowed: true,
      status: "invalid_key",
      tier: "free",
      notice: "Your license key is invalid or revoked — running on the free tier.",
    };
  }

  const trialStart = await getTrialStart();
  const days = trialDaysRemaining(trialStart);
  if (days > 0) return { allowed: true, status: "trial", tier: "full", daysRemaining: days };

  // Trial over: free tier, never a hard wall.
  return {
    allowed: true,
    status: "expired",
    tier: "free",
    notice: "Your 7-day trial has ended — running on the free tier.",
  };
}

// ── Status summary for popup ──────────────────────────────────────────────

async function getLicenseStatus() {
  const lic = await getLicenseData();
  const trialStart = await getTrialStart();
  const days = trialDaysRemaining(trialStart);

  if (lic && lic.key && lic.status === "active") {
    return { status: "licensed", key: lic.key };
  }
  if (days > 0) {
    return { status: "trial", daysRemaining: days };
  }
  return { status: "expired" };
}
