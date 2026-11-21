import { config } from "../config.js";
import { logger } from "../lib/log.js";

const lastSent = new Map<string, number>();

/** Fire-and-forget operator alert. Always logged; POSTed to ALERT_WEBHOOK_URL when set. The same `key` is sent at
 * most once per cooldown so a sustained condition (empty relayer, stuck nonce) does not flood a channel. */
export function alert(key: string, message: string): void {
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < config.policy.alertCooldownMs) return;
  lastSent.set(key, now);
  logger.error("alert", { key, message });
  const url = config.policy.alertWebhookUrl;
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `text` for Slack, `content` for Discord, plus structured fields for anything else.
    body: JSON.stringify({ text: `[fee.market sponsor ${config.sponsorId}] ${message}`, content: `[fee.market sponsor ${config.sponsorId}] ${message}`, key, message }),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => logger.error("alert_webhook_failed", { error: (e as Error).message }));
}

/** Test hook. */
export function resetAlertCooldowns(): void {
  lastSent.clear();
}
