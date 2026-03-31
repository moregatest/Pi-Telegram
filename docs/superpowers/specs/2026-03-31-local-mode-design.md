# Local Mode: Directory-Based Bot Configuration

## Summary

Transform Pi-Telegram from a centralized config model (`~/.pi/telegram/`) to a directory-local model where each working directory can be an independent bot workspace. Token comes from `.env`, other settings from a flat `settings.json`, and all runtime data goes under `./pitg/`.

## Mode Detection

On startup, check `process.cwd()`:

1. `cwd/.env` exists and contains `TELEGRAM_BOT_TOKEN` → **local mode**, root = `cwd/pitg/`
2. `cwd/.env` does not exist → **legacy mode**, root = `~/.pi/telegram/`

`.env` is the sole trigger for local mode. This avoids false positives from unrelated `settings.json` files that may exist in the working directory.

## Local Mode Directory Structure

```
my-project/
├── .env                  # TELEGRAM_BOT_TOKEN=xxx
├── settings.json         # flat config (no bots array)
└── pitg/
    ├── sessions/         # pi session data
    ├── cron/             # cron job persistence
    ├── inbound/          # downloaded images/files
    ├── workspace/        # default workspace (unused in local mode)
    └── tool-system-prompt.txt
```

## .env File

Single value only:

```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
```

Parsed with a simple hand-written parser (no `dotenv` dependency). Supports `KEY=VALUE`, `#` comments, quoted values, blank lines ignored.

## settings.json (Local Mode — Flat Format)

```json
{
  "name": "Pi-Telegram",
  "allowedUsers": [],
  "idleTimeoutMs": 600000,
  "maxResponseLength": 4000,
  "streamByChat": {},
  "cron": {
    "enabled": true,
    "defaultTimezone": "Asia/Shanghai",
    "maxJobsPerChat": 20,
    "maxRunSeconds": 900,
    "maxLatenessMs": 600000,
    "retryMax": 2,
    "retryBackoffMs": 30000
  }
}
```

Changes from legacy format:
- No `bots` array wrapper — all fields at top level
- No `token` field (comes from `.env`)
- No `cwd` field (local mode uses `process.cwd()`)
- `lastChangelogVersion` retained (internal use)

Legacy mode `settings.json` format is unchanged.

## ResolvedConfig Interface

Both modes produce a unified internal config:

```ts
interface ResolvedConfig {
  token: string;
  name: string;
  allowedUsers: (number | string)[];
  cwd: string;                    // local mode = process.cwd(), legacy = settings value
  streamByChat: Record<string, boolean>;
  idleTimeoutMs: number;
  maxResponseLength: number;
  lastChangelogVersion?: string;
  cron: Required<CronConfig>;
}
```

## First-Run Behavior

### Local mode

```
pitg
  ├── cwd has .env with TELEGRAM_BOT_TOKEN?
  │   ├── YES → read token
  │   │   ├── token valid → cwd has settings.json?
  │   │   │   ├── YES → start normally
  │   │   │   └── NO → generate flat settings.json template, print hint, exit
  │   │   └── token empty/placeholder → error "fill in valid token in .env", exit
  │   └── NO → fallback to legacy mode
```

- `.env` is never auto-generated (user creates it to opt into local mode)
- `settings.json` is auto-generated as flat template
- `pitg/` subdirectories created at actual startup, not during template generation

### Legacy mode

Unchanged — missing `~/.pi/telegram/settings.json` generates the old-format template and exits.

## config.ts Changes

New functions:
- `parseEnvFile(path: string): Record<string, string>` — simple `.env` parser
- `readLocalConfig(cwd: string): ResolvedConfig` — reads `.env` for token + `settings.json` for the rest, merges into `ResolvedConfig`
- `readLegacyConfig(): ResolvedConfig` — reads old `settings.json`, takes `bots[0]`, converts to `ResolvedConfig`

Existing `readAppConfig()` delegates to one of the above based on mode detection.

Settings write-back: local mode writes flat format to `cwd/settings.json`, legacy mode writes old format to `~/.pi/telegram/settings.json`.

## runtime.ts Changes

- Remove `for` loop over `bots` array — single bot startup
- Read from `ResolvedConfig` directly
- `sessionBaseDir` = `{root}/sessions/{name}`
- `cronStorePath` = `{root}/cron/{name}/jobs.json`
- All other logic (runner auto-restart, shutdown, version check) unchanged

## paths.ts Changes

- Mode detection function that checks `cwd` for `.env` / `settings.json`
- All path constants become functions or lazily evaluated, parameterized by detected root
- Export detected mode for use by `config.ts`

## Files Changed

| File | Change |
|------|--------|
| `src/app/paths.ts` | Mode detection, dynamic root paths |
| `src/app/config.ts` | `.env` parser, `readLocalConfig`, flat template, `ResolvedConfig` |
| `src/app/runtime.ts` | Remove bots loop, use `ResolvedConfig` |
| `src/shared/types.ts` | Add `LocalConfig`, `ResolvedConfig` interfaces |

## Files NOT Changed

- `src/pi/pool.ts`, `src/pi/rpc.ts` — depend only on passed-in `cwd`, `sessionBaseDir`
- `src/telegram/*` — `CreateBotOptions` interface unchanged
- `src/cron/*` — depend only on passed-in `storePath`
- `src/shared/log.ts`, `jsonl.ts`, `version.ts` — no path dependencies

## Backward Compatibility

- Existing `~/.pi/telegram/` setups work without changes
- Legacy mode users are unaffected
- `pitg` CLI entry point unchanged
