// src/shared/types.ts — shared app/config types

export interface BotConfig {
  token: string;
  name: string;
  allowedUsers: (number | string)[];
  cwd: string;
  streamByChat?: Record<string, boolean>;
}

export interface CronConfig {
  enabled?: boolean;
  defaultTimezone?: string;
  maxJobsPerChat?: number;
  maxRunSeconds?: number;
  maxLatenessMs?: number;
  retryMax?: number;
  retryBackoffMs?: number;
}

export interface AppConfig {
  bots: BotConfig[];
  idleTimeoutMs: number;
  maxResponseLength: number;
  lastChangelogVersion?: string;
  cron?: CronConfig;
}

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
