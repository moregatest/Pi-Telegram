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
