import { fileURLToPath } from "node:url";

const defaultDataDir = fileURLToPath(new URL("../data/", import.meta.url));

export const config = {
  port: parseInt(process.env.PORT || "8787", 10),
  dataDir: process.env.DATA_DIR || defaultDataDir,
  signingSecret: process.env.LEMONSQUEEZY_SIGNING_SECRET || "",
  apiKey: process.env.LEMONSQUEEZY_API_KEY || "",
  adminToken: process.env.ADMIN_TOKEN || "",
  // Bounded offline grace for clients: how long a validated entitlement may be
  // trusted without revalidation before degrading to the free tier.
  graceHours: parseInt(process.env.LICENSE_GRACE_HOURS || "72", 10),
};

// Emit fail-closed warnings on boot so a misconfigured deploy is obvious.
export function warnConfig(log = console) {
  if (!config.signingSecret) {
    log.warn("[config] LEMONSQUEEZY_SIGNING_SECRET unset — webhook events will be REJECTED (fail-closed).");
  }
  if (!config.adminToken) {
    log.warn("[config] ADMIN_TOKEN unset — /metrics, /dashboard, /admin/* are DISABLED (fail-closed).");
  }
}
