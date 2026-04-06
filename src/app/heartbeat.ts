/**
 * Polling heartbeat for external watchdog monitoring.
 *
 * Writes an epoch-seconds timestamp to /tmp/pitg-{botName}.heartbeat
 * on every successful getUpdates call. If the file goes stale (>7 min),
 * the external watchdog (pitg-watchdog.sh) restarts the bot via pm2.
 *
 * NOTE: This monitors polling health only, not handler responsiveness.
 * A bot with a deadlocked handler will still produce fresh heartbeats
 * as long as getUpdates keeps succeeding.
 */

import { renameSync, writeFileSync } from "node:fs";
import type { Transformer } from "grammy";

export function heartbeatPath(botName: string): string {
  const safe = botName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  return `/tmp/pitg-${safe}.heartbeat`;
}

export function writeHeartbeat(botName: string): void {
  const target = heartbeatPath(botName);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, String(Math.floor(Date.now() / 1000)), "utf-8");
    renameSync(tmp, target);
  } catch {
    // /tmp should always be writable; swallow to avoid crashing the bot
  }
}

export function createHeartbeatTransformer(botName: string): Transformer {
  return (prev, method, payload, signal) => {
    const result = prev(method, payload, signal);
    if (method === "getUpdates") {
      result.then(
        () => writeHeartbeat(botName),
        () => {},
      );
    }
    return result;
  };
}
