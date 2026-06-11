const $connection = document.getElementById("connection-status");
const $licenseStatus = document.getElementById("license-status");
const $keySection = document.getElementById("key-section");
const $keyInput = document.getElementById("key-input");
const $activateBtn = document.getElementById("activate-btn");
const $keyError = document.getElementById("key-error");
const $licensedSection = document.getElementById("licensed-section");
const $licensedKey = document.getElementById("licensed-key");
const $deactivateBtn = document.getElementById("deactivate-btn");
const $buySection = document.getElementById("buy-section");
const $buyBtn = document.getElementById("buy-btn");
const $serverHelp = document.getElementById("server-help");
const $retryBtn = document.getElementById("retry-btn");
const $tierNote = document.getElementById("tier-note");

// ── Connection status ──────────────────────────────────────────────────────
// The offscreen document owns the WebSocket and records the live state in
// chrome.storage.local.wsConnected. On open we proactively ask the service
// worker to (re)spawn the offscreen document so a dropped socket reconnects
// immediately — rather than telling the user to start a server that is very
// possibly already running.

let pollTimer = null;

function setConnBadge(state) {
  if (state === "connected") {
    $connection.textContent = "Connected";
    $connection.className = "badge connected";
    $serverHelp.hidden = true;
  } else if (state === "connecting") {
    $connection.textContent = "Connecting…";
    $connection.className = "badge connecting";
    $serverHelp.hidden = true;
  } else {
    $connection.textContent = "Disconnected";
    $connection.className = "badge disconnected";
    $serverHelp.hidden = false;
  }
}

async function isConnected() {
  try {
    const { wsConnected } = await chrome.storage.local.get("wsConnected");
    return !!wsConnected;
  } catch {
    return false;
  }
}

async function attemptConnect() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (await isConnected()) {
    setConnBadge("connected");
    return;
  }
  setConnBadge("connecting");
  // Wake the service worker and (re)create the offscreen WebSocket holder.
  try {
    await chrome.runtime.sendMessage({ type: "ensure_offscreen" });
  } catch {
    // No receiver yet — the offscreen reconnect loop (every 2s) still applies.
  }
  // Poll briefly for the socket to come up before surfacing the "can't reach" help.
  let waited = 0;
  pollTimer = setInterval(async () => {
    waited += 600;
    if (await isConnected()) {
      clearInterval(pollTimer);
      pollTimer = null;
      setConnBadge("connected");
    } else if (waited >= 5000) {
      clearInterval(pollTimer);
      pollTimer = null;
      setConnBadge("disconnected");
    }
  }, 600);
}

// ── License status ─────────────────────────────────────────────────────────

async function refreshLicenseUI() {
  const info = await getLicenseStatus();

  $keySection.hidden = true;
  $licensedSection.hidden = true;
  $buySection.hidden = true;
  $tierNote.hidden = true;

  if (info.status === "pro") {
    $licenseStatus.textContent = info.offline ? "Pro (offline)" : "Pro";
    $licenseStatus.className = "badge licensed";
    $licensedSection.hidden = false;
    const masked = info.key.slice(0, 8) + "…" + info.key.slice(-4);
    $licensedKey.textContent = masked;
  } else {
    $licenseStatus.textContent = "Free";
    $licenseStatus.className = "badge free";
    $keySection.hidden = false;
    $buySection.hidden = false;
    $tierNote.hidden = false;
    if (info.reason === "invalid_key") {
      $tierNote.textContent =
        "Your license key is invalid or revoked — running on the free tier. Re-activate a key to restore Pro.";
    } else if (info.reason === "grace_expired") {
      $tierNote.textContent =
        "Couldn't revalidate your license — running on the free tier until the license service is reachable again.";
    } else {
      $tierNote.textContent =
        "Free tier: full core browsing & automation. Pro unlocks DevTools, test flows, network capture, PDF export, emulation, and more.";
    }
  }
}

// ── Actions ────────────────────────────────────────────────────────────────

$activateBtn.addEventListener("click", async () => {
  const key = $keyInput.value.trim();
  if (!key) {
    $keyError.textContent = "Paste your license key first.";
    $keyError.hidden = false;
    return;
  }

  $activateBtn.disabled = true;
  $activateBtn.textContent = "Activating…";
  $keyError.hidden = true;

  try {
    const result = await activateLicense(key);
    if (result.success) {
      $keyInput.value = "";
      await refreshLicenseUI();
    } else {
      $keyError.textContent = result.error || "Activation failed. Check the key and try again.";
      $keyError.hidden = false;
    }
  } catch {
    // Network/parse failure — don't leave the button stuck on "Activating…"
    $keyError.textContent = "Couldn't reach the license server. Check your connection and try again.";
    $keyError.hidden = false;
  } finally {
    $activateBtn.disabled = false;
    $activateBtn.textContent = "Activate";
  }
});

$deactivateBtn.addEventListener("click", async () => {
  $deactivateBtn.disabled = true;
  await deactivateLicense();
  await refreshLicenseUI();
  $deactivateBtn.disabled = false;
});

$buyBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: PURCHASE_URL });
});

$retryBtn.addEventListener("click", () => {
  attemptConnect();
});

$keyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $activateBtn.click();
});

// Live-update the badge if the socket connects/drops while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.wsConnected) {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    setConnBadge(changes.wsConnected.newValue ? "connected" : "disconnected");
  }
});

attemptConnect();
refreshLicenseUI();
