// src/app/runtime.ts — app assembly and startup orchestration
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { PiPool } from "../pi/pool.js";
import { discoverSkills } from "../pi/discover.js";
import { createBot } from "../telegram/create-bot.js";
import { CronService } from "../cron/service.js";
import { log } from "../shared/log.js";
import { getRegisteredToolSystemPrompt } from "../telegram/tool-prompt.js";
import type { ResolvedConfig } from "../shared/types.js";
import {
  checkLatestVersion,
  getNewChangelogText,
  getPackageMeta,
  getUpdateInstruction,
  shouldCheckUpdatesOnStartup,
} from "../shared/version.js";
import {
  createLocalSettingsWriter,
  createSettingsWriter,
  ensureLocalSettingsFileExists,
  ensureSettingsFileExists,
  readLegacyConfig,
  readLocalConfig,
} from "./config.js";
import { cronRoot, ensureAppDirectories, paths, sessionsRoot, telegramRoot } from "./paths.js";

const bots: Array<{ stop: () => Promise<void> }> = [];
const pools: PiPool[] = [];
const cronServices: CronService[] = [];
let shuttingDown = false;
let booted = false;

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getTelegramErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as Record<string, unknown>).error_code;
  return typeof code === "number" ? code : undefined;
}

function describeRunnerError(err: unknown): string {
  const details: string[] = [formatErr(err)];

  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    if (typeof rec.error_code === "number") {
      details.push(`error_code=${rec.error_code}`);
    }
    if (typeof rec.description === "string" && rec.description.trim()) {
      details.push(`description=${rec.description}`);
    }
    const params = rec.parameters;
    if (params && typeof params === "object") {
      const retryAfter = (params as Record<string, unknown>).retry_after;
      if (typeof retryAfter === "number") {
        details.push(`retry_after=${retryAfter}s`);
      }
    }
  }

  return details.join(" | ");
}

function startRunnerWithAutoRestart(
  bot: ReturnType<typeof createBot>,
  botName: string,
): { stop: () => Promise<void> } {
  let runner: RunnerHandle | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutive409 = 0;
  const MAX_409_RETRIES = 5;

  const scheduleRestart = (reason: string, delayMs = 5000) => {
    if (shuttingDown) return;
    if (retryTimer) return;
    const delaySec = Math.max(1, Math.round(delayMs / 1000));
    log.warn(`"${botName}" 轮询已停止（${reason}），${delaySec} 秒后重试`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      log.warn(`"${botName}" 正在重启 Telegram 轮询...`);
      start();
    }, delayMs);
  };

  const watch = (current: RunnerHandle) => {
    const task = current.task();
    if (!task) return;

    task
      .then(() => {
        if (shuttingDown) return;
        if (runner !== current) return;
        scheduleRestart("runner task ended");
      })
      .catch((err) => {
        if (shuttingDown) return;
        if (runner !== current) return;

        const code = getTelegramErrorCode(err);
        log.error("boot", `"${botName}" 轮询异常：${describeRunnerError(err)}`);

        if (code === 401) {
          log.warn(`"${botName}" token 可能无效/已失效，请检查 settings.json（本次不自动重启）`);
          return;
        }

        if (code === 409) {
          consecutive409++;
          log.warn(`"${botName}" 可能存在重复实例（同 token 多进程轮询）[${consecutive409}/${MAX_409_RETRIES}]`);
          if (consecutive409 >= MAX_409_RETRIES) {
            log.error("boot", `"${botName}" 连续 ${MAX_409_RETRIES} 次 409，退出进程让 pm2 重启`);
            process.exit(1);
          }
          scheduleRestart("runner crashed code=409", 45000);
          return;
        }

        scheduleRestart(code ? `runner crashed code=${code}` : "runner crashed");
      });
  };

  const start = () => {
    if (shuttingDown) return;
    try {
      runner = run(bot, {
        runner: {
          maxRetryTime: 7 * 24 * 60 * 60 * 1000,
        },
      });
      consecutive409 = 0;
      watch(runner);
    } catch (err) {
      log.error("boot", `"${botName}" 启动轮询失败：${describeRunnerError(err)}`);
      scheduleRestart("start failed");
    }
  };

  start();

  return {
    stop: async () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (runner?.isRunning()) {
        await runner.stop();
      }
    },
  };
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  log.shutdown("stopping...");
  for (const bot of bots) await bot.stop();
  for (const cron of cronServices) await cron.stop();
  for (const pool of pools) await pool.shutdown();
  process.exit(0);
}

export async function runApp(): Promise<void> {
  if (booted) return;
  booted = true;

  ensureAppDirectories();

  const { name: packageName, version: appVersion } = getPackageMeta();

  // ── Mode-specific config loading ──

  let resolved: ResolvedConfig;
  let queueWriteSettings: () => Promise<void>;

  if (paths.mode === "local") {
    // Local mode: token from .env, settings from cwd/settings.json
    if (ensureLocalSettingsFileExists(appVersion)) {
      log.warn(`settings.json 不存在，已自动生成模板: ${paths.settingsPath}`);
      log.warn("请检查配置后再重新启动。\n");
      process.exit(1);
      return;
    }

    const { config, raw } = readLocalConfig(process.cwd(), paths.envFilePath!);

    if (!config.token || config.token.includes("<") || config.token.includes(">")) {
      log.error("config", "请在 .env 中填入有效的 TELEGRAM_BOT_TOKEN");
      process.exit(1);
      return;
    }

    resolved = config;
    queueWriteSettings = createLocalSettingsWriter(config, raw);
  } else {
    // Legacy mode: everything from ~/.pi/telegram/settings.json
    if (ensureSettingsFileExists(appVersion)) {
      log.warn(`settings.json 不存在，已自动生成模板: ${paths.settingsPath}`);
      log.warn("请先填写 bot token，再重新启动。\n");
      process.exit(1);
      return;
    }

    const { config, raw } = readLegacyConfig();
    resolved = config;
    queueWriteSettings = createSettingsWriter(raw);
  }

  let needsSettingsRewrite = false;

  log.boot(`Pi-Telegram v${appVersion} (${paths.mode} mode)`);

  if (!resolved.lastChangelogVersion) {
    resolved.lastChangelogVersion = appVersion;
    needsSettingsRewrite = true;
  } else if (resolved.lastChangelogVersion !== appVersion) {
    const changelogText = getNewChangelogText(resolved.lastChangelogVersion);
    if (changelogText) {
      log.warn(`检测到新版本变更（${resolved.lastChangelogVersion} -> ${appVersion}）：`);
      for (const line of changelogText.split(/\r?\n/)) {
        if (line.trim()) log.warn(line);
      }
    }

    resolved.lastChangelogVersion = appVersion;
    needsSettingsRewrite = true;
  }

  if (shouldCheckUpdatesOnStartup()) {
    void checkLatestVersion(packageName, appVersion).then((newVersion) => {
      if (!newVersion) return;
      log.warn(`发现新版本 ${newVersion} 可用。${getUpdateInstruction(packageName)}`);
      log.warn("Changelog: https://github.com/Ziphyrien/Pi-Telegram/blob/main/CHANGELOG.md");
    });
  }

  // ── Tool system prompt ──

  const toolSystemPrompt = getRegisteredToolSystemPrompt().trim();
  const toolSystemPromptFile = resolve(telegramRoot, "tool-system-prompt.txt");
  if (toolSystemPrompt) {
    writeFileSync(toolSystemPromptFile, `${toolSystemPrompt}\n`, "utf-8");
  }
  const toolSystemPromptArg = toolSystemPrompt ? toolSystemPromptFile : "";

  // ── Discover pi skills ──

  const discoveredSkills = await discoverSkills({
    cwd: resolved.cwd,
    piArgs: [],
    appendSystemPrompt: toolSystemPromptArg,
  });

  if (discoveredSkills.length > 0) {
    log.boot(`发现 ${discoveredSkills.length} 个技能: ${discoveredSkills.map((s) => s.name.replace(/-/g, "_")).join(", ")}`);
  } else {
    log.warn("未发现任何 pi 技能，所有 slash 命令将被忽略");
  }

  // ── Single bot startup ──

  const botName = resolved.name || "Pi-Telegram";
  const sessionBaseDir = resolve(sessionsRoot, botName);

  const pool = new PiPool({
    cwd: resolved.cwd,
    piArgs: [],
    appendSystemPrompt: toolSystemPromptArg,
    sessionBaseDir,
    idleTimeoutMs: resolved.idleTimeoutMs,
  });
  pools.push(pool);

  const cronStorePath = resolve(cronRoot, botName, "jobs.json");
  const cronCfg = resolved.cron;
  const cronService = new CronService({
    storePath: cronStorePath,
    botName,
    enabled: cronCfg.enabled,
    defaultTimezone: cronCfg.defaultTimezone,
    maxJobsPerChat: cronCfg.maxJobsPerChat,
    maxRunMs: cronCfg.maxRunSeconds * 1000,
    defaultPolicy: {
      maxLatenessMs: cronCfg.maxLatenessMs,
      retryMax: cronCfg.retryMax,
      retryBackoffMs: cronCfg.retryBackoffMs,
      deleteAfterRun: true,
    },
  });

  const bot = createBot({
    botIndex: 0,
    config: {
      token: resolved.token,
      name: botName,
      allowedUsers: resolved.allowedUsers,
      cwd: resolved.cwd,
      streamByChat: resolved.streamByChat,
    },
    pool,
    cron: cronService,
    maxResponseLength: resolved.maxResponseLength,
    initialStreamByChat: resolved.streamByChat,
    discoveredSkills,
    onStreamModeChange: async (chatId, enabled) => {
      const key = String(chatId);
      const prev = resolved.streamByChat?.[key];
      if (prev === enabled) return;

      resolved.streamByChat = resolved.streamByChat ?? {};
      resolved.streamByChat[key] = enabled;

      try {
        await queueWriteSettings();
      } catch (err) {
        log.error("config", `保存流式配置失败 (${botName}:${key}=${enabled ? 1 : 0}): ${formatErr(err)}`);
        throw err;
      }
    },
  });

  await cronService.start();
  cronServices.push(cronService);

  const handle = startRunnerWithAutoRestart(bot, botName);
  bots.push(handle);
  log.boot(`"${botName}" started`);

  if (needsSettingsRewrite) {
    queueWriteSettings().catch((err) => {
      log.error("config", `写回 settings.json 失败：${formatErr(err)}`);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.boot(`1 bot running. Ctrl+C to stop.`);
}
