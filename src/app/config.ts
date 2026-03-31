// src/app/config.ts — settings file creation, loading, normalization, and persistence
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths, settingsPath, defaultWorkspace } from "./paths.js";
import type { AppConfig, CronConfig, LocalConfig, ResolvedConfig } from "../shared/types.js";

export function parseEnvFile(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, "utf-8");
  const result: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function getResolvedTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function getDefaultCronConfig(): Required<CronConfig> {
  return {
    enabled: true,
    defaultTimezone: getResolvedTimezone(),
    maxJobsPerChat: 20,
    maxRunSeconds: 900,
    maxLatenessMs: 10 * 60 * 1000,
    retryMax: 2,
    retryBackoffMs: 30 * 1000,
  };
}

export function createDefaultSettingsTemplate(appVersion: string): AppConfig {
  const cron = getDefaultCronConfig();
  return {
    bots: [
      {
        token: "<YOUR_TELEGRAM_BOT_TOKEN>",
        name: "Pi-Telegram",
        allowedUsers: [],
        cwd: defaultWorkspace,
        streamByChat: {},
      },
    ],
    idleTimeoutMs: 600000,
    maxResponseLength: 4000,
    lastChangelogVersion: appVersion,
    cron,
  };
}

export function createLocalSettingsTemplate(appVersion: string): LocalConfig {
  const cron = getDefaultCronConfig();
  return {
    name: "Pi-Telegram",
    allowedUsers: [],
    idleTimeoutMs: 600000,
    maxResponseLength: 4000,
    streamByChat: {},
    lastChangelogVersion: appVersion,
    cron,
  };
}

export function ensureSettingsFileExists(appVersion: string): boolean {
  if (existsSync(settingsPath)) return false;
  const template = createDefaultSettingsTemplate(appVersion);
  writeFileSync(settingsPath, `${JSON.stringify(template, null, 2)}\n`, "utf-8");
  return true;
}

export function ensureLocalSettingsFileExists(appVersion: string): boolean {
  if (existsSync(paths.settingsPath)) return false;
  const template = createLocalSettingsTemplate(appVersion);
  writeFileSync(paths.settingsPath, `${JSON.stringify(template, null, 2)}\n`, "utf-8");
  return true;
}

export function readAppConfig(): AppConfig {
  return JSON.parse(readFileSync(settingsPath, "utf-8")) as AppConfig;
}

export function readLocalConfig(cwd: string, envFilePath: string): { config: ResolvedConfig; raw: LocalConfig } {
  const env = parseEnvFile(envFilePath);
  const token = env.TELEGRAM_BOT_TOKEN ?? "";

  const raw: LocalConfig = existsSync(paths.settingsPath)
    ? JSON.parse(readFileSync(paths.settingsPath, "utf-8")) as LocalConfig
    : {};

  const normalizedCron = normalizeCronConfig(raw.cron);
  const normalizedStream = normalizeStreamByChat(raw.streamByChat);

  const config: ResolvedConfig = {
    mode: "local",
    token,
    name: raw.name || "Pi-Telegram",
    allowedUsers: raw.allowedUsers ?? [],
    cwd,
    streamByChat: normalizedStream.value,
    idleTimeoutMs: raw.idleTimeoutMs || 600000,
    maxResponseLength: raw.maxResponseLength || 4000,
    lastChangelogVersion: raw.lastChangelogVersion,
    cron: normalizedCron.value,
  };

  return { config, raw };
}

export function readLegacyConfig(): { config: ResolvedConfig; raw: AppConfig } {
  const raw = readAppConfig();
  const botCfg = raw.bots[0];

  const normalizedCron = normalizeCronConfig(raw.cron);
  const normalizedStream = normalizeStreamByChat(botCfg?.streamByChat);

  const config: ResolvedConfig = {
    mode: "legacy",
    token: botCfg?.token ?? "",
    name: botCfg?.name || "Pi-Telegram",
    allowedUsers: botCfg?.allowedUsers ?? [],
    cwd: botCfg?.cwd || defaultWorkspace,
    streamByChat: normalizedStream.value,
    idleTimeoutMs: raw.idleTimeoutMs || 600000,
    maxResponseLength: raw.maxResponseLength || 4000,
    lastChangelogVersion: raw.lastChangelogVersion,
    cron: normalizedCron.value,
  };

  return { config, raw };
}

export function normalizeCronConfig(input: CronConfig | undefined): { value: Required<CronConfig>; changed: boolean } {
  const defaultCronConfig = getDefaultCronConfig();
  const src = input ?? {};
  let changed = input === undefined;

  const enabled = typeof src.enabled === "boolean" ? src.enabled : defaultCronConfig.enabled;
  if (enabled !== src.enabled) changed = true;

  const timezone = String(src.defaultTimezone || defaultCronConfig.defaultTimezone).trim() || defaultCronConfig.defaultTimezone;
  if (timezone !== src.defaultTimezone) changed = true;

  const maxJobsPerChatRaw = Number(src.maxJobsPerChat);
  const maxJobsPerChat = Number.isFinite(maxJobsPerChatRaw) && maxJobsPerChatRaw >= 1
    ? Math.floor(maxJobsPerChatRaw)
    : defaultCronConfig.maxJobsPerChat;
  if (maxJobsPerChat !== src.maxJobsPerChat) changed = true;

  const maxRunSecondsRaw = Number(src.maxRunSeconds);
  const maxRunSeconds = Number.isFinite(maxRunSecondsRaw) && maxRunSecondsRaw >= 10
    ? Math.floor(maxRunSecondsRaw)
    : defaultCronConfig.maxRunSeconds;
  if (maxRunSeconds !== src.maxRunSeconds) changed = true;

  const maxLatenessMsRaw = Number(src.maxLatenessMs);
  const maxLatenessMs = Number.isFinite(maxLatenessMsRaw) && maxLatenessMsRaw >= 0
    ? Math.floor(maxLatenessMsRaw)
    : defaultCronConfig.maxLatenessMs;
  if (maxLatenessMs !== src.maxLatenessMs) changed = true;

  const retryMaxRaw = Number(src.retryMax);
  const retryMax = Number.isFinite(retryMaxRaw) && retryMaxRaw >= 0
    ? Math.floor(retryMaxRaw)
    : defaultCronConfig.retryMax;
  if (retryMax !== src.retryMax) changed = true;

  const retryBackoffMsRaw = Number(src.retryBackoffMs);
  const retryBackoffMs = Number.isFinite(retryBackoffMsRaw) && retryBackoffMsRaw >= 1000
    ? Math.floor(retryBackoffMsRaw)
    : defaultCronConfig.retryBackoffMs;
  if (retryBackoffMs !== src.retryBackoffMs) changed = true;

  return {
    changed,
    value: {
      enabled,
      defaultTimezone: timezone,
      maxJobsPerChat,
      maxRunSeconds,
      maxLatenessMs,
      retryMax,
      retryBackoffMs,
    },
  };
}

export function normalizeStreamByChat(input: unknown): { value: Record<string, boolean>; changed: boolean } {
  const value: Record<string, boolean> = {};

  if (input === undefined) {
    return { value, changed: true };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { value, changed: true };
  }

  let changed = false;
  for (const [chatIdRaw, enabledRaw] of Object.entries(input as Record<string, unknown>)) {
    const chatId = Number(chatIdRaw);
    if (!Number.isSafeInteger(chatId)) {
      changed = true;
      continue;
    }

    const key = String(chatId);
    if (key !== chatIdRaw) changed = true;

    if (typeof enabledRaw === "boolean") {
      value[key] = enabledRaw;
      continue;
    }

    if (enabledRaw === "true" || enabledRaw === "false") {
      value[key] = enabledRaw === "true";
      changed = true;
      continue;
    }

    if (typeof enabledRaw === "number") {
      value[key] = enabledRaw !== 0;
      changed = true;
      continue;
    }

    changed = true;
  }

  return { value, changed };
}

export function createSettingsWriter(config: AppConfig): () => Promise<void> {
  let settingsWriteQueue: Promise<void> = Promise.resolve();

  return () => {
    const task = settingsWriteQueue.then(() => {
      writeFileSync(settingsPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    });

    settingsWriteQueue = task.catch(() => {
      // Keep queue chain alive for future writes.
    });

    return task;
  };
}

export function createLocalSettingsWriter(config: ResolvedConfig, raw: LocalConfig): () => Promise<void> {
  let settingsWriteQueue: Promise<void> = Promise.resolve();

  return () => {
    const task = settingsWriteQueue.then(() => {
      raw.name = config.name;
      raw.allowedUsers = config.allowedUsers;
      raw.idleTimeoutMs = config.idleTimeoutMs;
      raw.maxResponseLength = config.maxResponseLength;
      raw.lastChangelogVersion = config.lastChangelogVersion;
      raw.streamByChat = config.streamByChat;
      raw.cron = config.cron;
      writeFileSync(paths.settingsPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
    });

    settingsWriteQueue = task.catch(() => {
      // Keep queue chain alive for future writes.
    });

    return task;
  };
}
