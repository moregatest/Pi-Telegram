# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pi-Telegram is a bridge that connects Telegram bots to the [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) via RPC. It spawns `pi` subprocesses in `--mode rpc` and communicates over JSONL stdin/stdout. Published as the `pi-telegram` npm package with a `pitg` CLI entry point.

## Development Commands

```bash
npm install          # install dependencies
npm run build        # compile TypeScript (tsc) to dist/
npm run dev          # watch mode via tsx (src/main.ts)
npm start            # run compiled output (dist/main.js)
```

There is no test suite or linter configured.

## Release

Releases use `node scripts/release.mjs` locally, which bumps version, updates CHANGELOG.md, and commits. Publishing is handled by a GitHub Actions workflow (`publish-npm.yml`) triggered manually via `workflow_dispatch`. It uses npm Trusted Publishing with provenance.

## Architecture

### Startup flow (`src/app/`)

`main.ts` → `runtime.ts:runApp()` — detects operating mode (local vs legacy), loads config, then starts a single bot:
1. Creates a `PiPool` (one pi subprocess per chat)
2. Creates a `CronService` (persistent cron scheduler)
3. Creates a grammY bot via `createBot()` and starts polling with auto-restart

### Pi RPC layer (`src/pi/`)

- **`PiPool`** — manages a map of `chatKey → PiRpc` instances. Spawns pi on first message per chat, reaps idle processes on a 60s interval.
- **`PiRpc`** — wraps a single `pi --mode rpc` child process. Communicates via JSONL over stdin/stdout. Has an internal prompt queue (one prompt at a time per process). Emits `event` and `exit` events. Supports `prompt()`, `abort()`, `newSession()`, model/thinking-level changes.

### Telegram layer (`src/telegram/`)

- **`create-bot.ts`** — the largest file (~700 lines). Sets up grammY bot with all middleware, commands (`/new`, `/status`, `/abort`, `/model`, `/stream`, `/thinking`, `/cron`), message handlers, and the response delivery pipeline (streaming and non-streaming). Uses grammY plugins: auto-retry, hydrate, files, commands, menu, auto-chat-action.
- **`format.ts`** — converts Markdown to Telegram HTML via markdown-it with CJK-friendly plugin, plus a plain-text fallback.
- **`attachment.ts`** — parses `<tg-attachment>` tags from pi output to send files/media.
- **`reply.ts`** — parses `<tg-reply>` tags and manages reply-to message tracking.
- **`menu.ts`** — builds grammY `Menu` instances for model selection, thinking level, and stream toggle.
- **`tool-prompt.ts`** — AI tool registry that generates a system prompt appended to pi, defining `tg-reply`, `tg-attachment`, and `tg-cron` tag protocols.

### Cron system (`src/cron/`)

- **`service.ts`** — persistent cron scheduler using `croner`. Stores jobs in `~/.pi/telegram/cron/<botName>/jobs.json`. Supports three schedule types: `at` (one-shot), `every` (interval), `cron` (cron expression with timezone). Has retry, lateness detection, and a serial execution queue.
- **`directives.ts`** — parses `<tg-cron>` tags from pi output to create/manage cron jobs programmatically.
- **`types.ts`** — all cron domain types (`CronJobRecord`, `CronSchedule`, `CronService*` interfaces).

### Shared utilities (`src/shared/`)

- **`log.ts`** — colored logger that imports pi's Theme system for consistent styling. Applies keyword-based syntax highlighting to log output.
- **`jsonl.ts`** — JSONL line reader/writer for pi RPC communication.
- **`types.ts`** — `AppConfig`, `BotConfig`, `CronConfig`, `LocalConfig`, `ResolvedConfig` interfaces.
- **`version.ts`** — package version detection, changelog diffing, and update checking.

## Key Design Patterns

- **One pi process per chat**: Each Telegram chat gets its own `pi --mode rpc` subprocess with a dedicated `--session-dir` for conversation persistence.
- **JSONL RPC protocol**: All communication with pi is through JSON lines on stdin (commands) and stdout (events). Event types include `message_update`, `tool_execution_start/end`, `agent_end`, and `response`.
- **Tag-based AI tools**: Pi's responses are scanned for XML-like tags (`<tg-attachment>`, `<tg-reply>`, `<tg-cron>`) that trigger Telegram actions. The tag protocols are injected via `--append-system-prompt`.
- **Serial prompt queue**: `PiRpc` queues prompts internally — only one prompt runs at a time per chat to respect pi's single-turn processing model.

## Operating Modes

**Local mode** (directory-local): Triggered when `cwd/.env` contains `TELEGRAM_BOT_TOKEN`. Token from `.env`, settings from `cwd/settings.json` (flat format, no `bots` array), runtime data under `cwd/pitg/`. Pi's `cwd` = `process.cwd()`.

**Legacy mode** (centralized): Fallback when no `.env` in cwd. Uses `~/.pi/telegram/settings.json` with `bots` array format. Original behavior preserved.

Mode detection happens in `src/app/paths.ts`. Both modes produce a unified `ResolvedConfig` via `src/app/config.ts`.

## Config & Data Paths

**Local mode** — data under `cwd/pitg/`:
- `cwd/.env` — bot token (`TELEGRAM_BOT_TOKEN=xxx`)
- `cwd/settings.json` — flat config (no `bots` array, no `token`, no `cwd`)
- `cwd/pitg/sessions/<botName>/<chatKey>/` — pi session directories
- `cwd/pitg/cron/<botName>/jobs.json` — persistent cron job store

**Legacy mode** — data under `~/.pi/telegram/`:
- `settings.json` — main config (bot tokens, cron settings, per-chat stream preferences)
- `sessions/<botName>/<chatKey>/` — pi session directories
- `cron/<botName>/jobs.json` — persistent cron job store
- `tool-system-prompt.txt` — generated system prompt for tag protocols

## Pi Skills

Skills live in `~/.pi/agent/skills/<name>/SKILL.md`. pi CLI does **not** auto-discover skills — the `--skill <path>` flag is required (Pi-Telegram passes this via RPC spawn args).

### img-gen

- **SKILL.md:** `~/.pi/agent/skills/img-gen/SKILL.md`
- **Script:** `~/.pi/agent/skills/img-gen/scripts/generate-z-image-turbo.sh`
- **Backend:** mflux z-image-turbo (768×1024, 8 steps)
- **Prompt optimization:** SKILL.md contains a validated pose/movement vocabulary (contortion, horror, backbend terms) and a 5-layer prompt structure (subject → appearance → pose → background → style). Pi silently enhances user prompts before passing to the script.
- **Testing:** Run from `~/pi-workspace/` with `pi -p --skill ~/.pi/agent/skills/img-gen "/img_gen <prompt>"`. Avoid running from project directories as cwd context can interfere.

### Local LLM

- **Server:** llama-server managed by pm2 (`~/.pm2/ecosystem.config.cjs`)
- **Model:** `~/models/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf`
- **Endpoint:** `http://127.0.0.1:8081/v1` (pi provider config in `~/.pi/agent/models.json`)

## Language & Conventions

- TypeScript (ES2022, Node16 module resolution), ESM-only (`"type": "module"`)
- Comments and UI strings are in Chinese (Simplified)
- grammY framework for Telegram bot API
