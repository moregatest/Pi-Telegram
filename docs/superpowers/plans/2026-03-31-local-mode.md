# Local Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Pi-Telegram to run as a directory-local bot by reading token from `.env` and storing runtime data under `./pitg/`, with fallback to legacy `~/.pi/telegram/` mode.

**Architecture:** Refactor `paths.ts` to detect mode (local vs legacy) based on `cwd/.env` presence, add `.env` parser and `ResolvedConfig` unification layer to `config.ts`, then simplify `runtime.ts` to single-bot startup using `ResolvedConfig`.

**Tech Stack:** TypeScript, Node.js (ESM), grammY

**Spec:** `docs/superpowers/specs/2026-03-31-local-mode-design.md`

---

### Task 1: Add types — `LocalConfig` and `ResolvedConfig`

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add `LocalConfig` and `ResolvedConfig` interfaces**

Append to `src/shared/types.ts`:

```ts
export interface LocalConfig {
  name?: string;
  allowedUsers?: (number | string)[];
  idleTimeoutMs?: number;
  maxResponseLength?: number;
  lastChangelogVersion?: string;
  streamByChat?: Record<string, boolean>;
  cron?: CronConfig;
}

export interface ResolvedConfig {
  mode: "local" | "legacy";
  token: string;
  name: string;
  allowedUsers: (number | string)[];
  cwd: string;
  streamByChat: Record<string, boolean>;
  idleTimeoutMs: number;
  maxResponseLength: number;
  lastChangelogVersion?: string;
  cron: Required<CronConfig>;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add LocalConfig and ResolvedConfig interfaces"
```

---

### Task 2: Refactor `paths.ts` — mode detection and dynamic root

**Files:**
- Modify: `src/app/paths.ts`

- [ ] **Step 1: Rewrite `paths.ts` with mode detection**

Replace the full content of `src/app/paths.ts` with:

```ts
// src/app/paths.ts — runtime path constants and bootstrap helpers
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type AppMode = "local" | "legacy";

export interface DetectedPaths {
  mode: AppMode;
  root: string;
  settingsPath: string;
  sessionsRoot: string;
  cronRoot: string;
  defaultWorkspace: string;
  envFilePath: string | null;
}

function detectMode(cwd: string): AppMode {
  const envPath = resolve(cwd, ".env");
  if (!existsSync(envPath)) return "legacy";

  try {
    const content = readFileSync(envPath, "utf-8");
    if (/^\s*TELEGRAM_BOT_TOKEN\s*=/m.test(content)) return "local";
  } catch {
    // unreadable .env — ignore, fall through to legacy
  }

  return "legacy";
}

function buildPaths(cwd: string): DetectedPaths {
  const mode = detectMode(cwd);

  if (mode === "local") {
    const root = resolve(cwd, "pitg");
    return {
      mode,
      root,
      settingsPath: resolve(cwd, "settings.json"),
      sessionsRoot: resolve(root, "sessions"),
      cronRoot: resolve(root, "cron"),
      defaultWorkspace: resolve(root, "workspace"),
      envFilePath: resolve(cwd, ".env"),
    };
  }

  const root = resolve(homedir(), ".pi", "telegram");
  return {
    mode,
    root,
    settingsPath: resolve(root, "settings.json"),
    sessionsRoot: resolve(root, "sessions"),
    cronRoot: resolve(root, "cron"),
    defaultWorkspace: resolve(root, "workspace"),
    envFilePath: null,
  };
}

export const paths = buildPaths(process.cwd());

// Re-export individual paths for backward compatibility with existing imports
export const telegramRoot = paths.root;
export const settingsPath = paths.settingsPath;
export const sessionsRoot = paths.sessionsRoot;
export const cronRoot = paths.cronRoot;
export const defaultWorkspace = paths.defaultWorkspace;

export function ensureAppDirectories(): void {
  mkdirSync(paths.sessionsRoot, { recursive: true });
  mkdirSync(paths.cronRoot, { recursive: true });
  mkdirSync(paths.defaultWorkspace, { recursive: true });
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: no errors (all existing imports of `settingsPath`, `sessionsRoot`, etc. still resolve)

- [ ] **Step 3: Commit**

```bash
git add src/app/paths.ts
git commit -m "feat(paths): add mode detection and dynamic root paths"
```

---

### Task 3: Add `.env` parser and `ResolvedConfig` builder to `config.ts`

**Files:**
- Modify: `src/app/config.ts`

- [ ] **Step 1: Add `parseEnvFile` function**

Add after existing imports in `src/app/config.ts`:

```ts
import { paths } from "./paths.js";
import type { LocalConfig, ResolvedConfig } from "../shared/types.js";
```

Then add the function before `getDefaultCronConfig()`:

```ts
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
```

- [ ] **Step 2: Add `createLocalSettingsTemplate` function**

Add after `createDefaultSettingsTemplate`:

```ts
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
```

- [ ] **Step 3: Add `ensureLocalSettingsFileExists` function**

Add after `ensureSettingsFileExists`:

```ts
export function ensureLocalSettingsFileExists(appVersion: string): boolean {
  if (existsSync(paths.settingsPath)) return false;
  const template = createLocalSettingsTemplate(appVersion);
  writeFileSync(paths.settingsPath, `${JSON.stringify(template, null, 2)}\n`, "utf-8");
  return true;
}
```

- [ ] **Step 4: Add `readLocalConfig` function**

Add after `readAppConfig`:

```ts
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
```

- [ ] **Step 5: Add `readLegacyConfig` function**

Add after `readLocalConfig`:

```ts
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
```

- [ ] **Step 6: Add `createLocalSettingsWriter` function**

Add after `createSettingsWriter`:

```ts
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
```

- [ ] **Step 7: Verify build**

Run: `npm run build`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/app/config.ts
git commit -m "feat(config): add env parser, local/legacy config readers, ResolvedConfig"
```

---

### Task 4: Refactor `runtime.ts` — unified single-bot startup

**Files:**
- Modify: `src/app/runtime.ts`

- [ ] **Step 1: Update imports**

Replace the imports section (lines 1-18) with:

```ts
// src/app/runtime.ts — app assembly and startup orchestration
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { PiPool } from "../pi/pool.js";
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
```

- [ ] **Step 2: Replace `runApp` function body**

Replace the `runApp` function (from `export async function runApp()` to the end of file) with:

```ts
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
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/app/runtime.ts
git commit -m "feat(runtime): unified single-bot startup with local/legacy mode"
```

---

### Task 5: Manual verification — local mode

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: clean build, no errors

- [ ] **Step 2: Test local mode — first run**

```bash
mkdir /tmp/pitg-test && cd /tmp/pitg-test
echo 'TELEGRAM_BOT_TOKEN=test:fake' > .env
node <path-to-repo>/dist/main.js
```

Expected: generates `settings.json` flat template in `/tmp/pitg-test/`, prints hint, exits with code 1.

Verify:
- `settings.json` exists and has flat format (no `bots` array)
- No `pitg/` directory yet

- [ ] **Step 3: Test local mode — normal start**

Review `settings.json`, then re-run:

```bash
node <path-to-repo>/dist/main.js
```

Expected: attempts to start bot (will fail with invalid token error from Telegram, which is expected — confirms the flow reaches bot creation).

- [ ] **Step 4: Test legacy mode fallback**

```bash
cd /tmp && mkdir pitg-legacy && cd pitg-legacy
node <path-to-repo>/dist/main.js
```

Expected: no `.env` in cwd → fallback to legacy mode → uses `~/.pi/telegram/settings.json` (existing behavior).

- [ ] **Step 5: Clean up**

```bash
rm -rf /tmp/pitg-test /tmp/pitg-legacy
```

- [ ] **Step 6: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: address issues found during manual verification"
```

---

### Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md to document local mode**

Add a section about local mode to `CLAUDE.md` under "Config & Data Paths":

```markdown
## Operating Modes

**Local mode** (directory-local): Triggered when `cwd/.env` contains `TELEGRAM_BOT_TOKEN`. Token from `.env`, settings from `cwd/settings.json` (flat format, no `bots` array), runtime data under `cwd/pitg/`. Pi's `cwd` = `process.cwd()`.

**Legacy mode** (centralized): Fallback when no `.env` in cwd. Uses `~/.pi/telegram/settings.json` with `bots` array format. Original behavior preserved.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with local mode documentation"
```
