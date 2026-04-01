# Auto Skill Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded `/img_gen` passthrough with automatic skill discovery via pi's `get_commands` RPC at bot startup.

**Architecture:** At startup, spawn a temporary `pi --mode rpc` process, call `get_commands`, filter for `source === "skill"`, extract skill names, then pass them to `createBot()` which builds a dynamic passthrough set using kebab→underscore normalization.

**Tech Stack:** TypeScript, Node.js child_process, JSONL protocol, pi RPC

---

### Task 1: Create `src/pi/discover.ts` — skill discovery module

**Files:**
- Create: `src/pi/discover.ts`

This module spawns a temporary pi RPC process, sends `get_commands`, and returns the list of skill names.

- [ ] **Step 1: Create `src/pi/discover.ts` with the `discoverSkills` function**

```typescript
// src/pi/discover.ts — discover pi skills via temporary RPC subprocess
import { spawn } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "../shared/jsonl.js";
import { log } from "../shared/log.js";

interface RpcSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: string;
  path?: string;
}

interface DiscoverOptions {
  cwd: string;
  piArgs: string[];
  appendSystemPrompt?: string;
}

export async function discoverSkills(opts: DiscoverOptions): Promise<string[]> {
  const args = ["--mode", "rpc", "--no-session", ...opts.piArgs];

  const append = (opts.appendSystemPrompt || "").trim();
  if (append && !args.includes("--append-system-prompt")) {
    args.push("--append-system-prompt", append);
  }

  const isWin = process.platform === "win32";
  const cmd = isWin ? "cmd.exe" : "pi";
  const cmdArgs = isWin ? ["/d", "/s", "/c", "pi", ...args] : args;

  return new Promise<string[]>((resolve) => {
    const proc = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      log.warn("skill 探测超时（10s），跳过");
      cleanup();
      resolve([]);
    }, 10_000);

    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      detach();
      proc.kill("SIGTERM");
    };

    const detach = attachJsonlLineReader(proc.stdout!, (line) => {
      if (!line.trim() || settled) return;
      try {
        const event = JSON.parse(line);
        if (event.type !== "response" || event.command !== "get_commands") return;

        if (!event.success) {
          log.warn(`get_commands 失败: ${event.error || "unknown"}`);
          cleanup();
          resolve([]);
          return;
        }

        const commands: RpcSlashCommand[] = event.data?.commands ?? [];
        const skills = commands
          .filter((c) => c.source === "skill")
          .map((c) => c.name.replace(/^skill:/, ""));

        cleanup();
        resolve(skills);
      } catch {
        // ignore parse errors, wait for the right line
      }
    });

    proc.stderr?.on("data", () => {
      // discard stderr silently during discovery
    });

    proc.on("error", (err) => {
      log.warn(`skill 探测失败: ${err.message}`);
      cleanup();
      resolve([]);
    });

    proc.on("exit", () => {
      if (!settled) {
        cleanup();
        resolve([]);
      }
    });

    // Send the get_commands RPC
    proc.stdin!.write(serializeJsonLine({ type: "get_commands" }));
    proc.stdin!.end();
  });
}
```

- [ ] **Step 2: Verify the new file compiles**

Run: `npx tsc --noEmit`
Expected: No new errors from `src/pi/discover.ts`

- [ ] **Step 3: Commit**

```bash
git add src/pi/discover.ts
git commit -m "feat(pi): add skill discovery via get_commands RPC"
```

---

### Task 2: Add `skillNames` parameter to `createBot` and replace hardcoded passthrough

**Files:**
- Modify: `src/telegram/create-bot.ts:41-49` (CreateBotOptions interface)
- Modify: `src/telegram/create-bot.ts:1370-1386` (passthrough logic)

- [ ] **Step 1: Add `skillNames` to `CreateBotOptions`**

In `src/telegram/create-bot.ts`, add the field to the interface:

```typescript
export interface CreateBotOptions {
  botIndex: number;
  config: BotConfig;
  pool: PiPool;
  cron: CronService;
  maxResponseLength: number;
  initialStreamByChat?: Record<string, boolean>;
  onStreamModeChange?: (chatId: number, enabled: boolean) => Promise<void> | void;
  skillNames?: string[];
}
```

And destructure it in `createBot`:

```typescript
export function createBot(opts: CreateBotOptions): Bot<BotContext> {
  const {
    botIndex,
    config,
    pool,
    cron,
    maxResponseLength,
    initialStreamByChat,
    onStreamModeChange,
    skillNames = [],
  } = opts;
```

- [ ] **Step 2: Replace hardcoded passthrough with dynamic skill-based logic**

Replace the block at lines 1370-1386:

```typescript
  // Slash commands that should be forwarded to pi instead of being ignored
  const passthroughCommands = ["img_gen"];
  const isPassthroughCommand = (t: string) => {
    const m = /^\/(\w+)/.exec(t);
    return m !== null && passthroughCommands.includes(m[1]);
  };
```

With:

```typescript
  // Build passthrough set from discovered pi skills (kebab-case → underscore)
  const passthroughSet = new Set(skillNames.map((s) => s.replace(/-/g, "_")));
  const isPassthroughCommand = (t: string) => {
    const m = /^\/(\w+)/.exec(t);
    return m !== null && passthroughSet.has(m[1]);
  };
```

- [ ] **Step 3: Replace hardcoded ACK with generic message**

Replace at line 1384-1386:

```typescript
    // Send immediate ACK for long-running passthrough commands
    if (isPassthroughCommand(text)) {
      await tgCtx.reply("🖼️ 开始生成图片，请稍候，这通常需要几十秒。");
    }
```

With:

```typescript
    if (isPassthroughCommand(text)) {
      await tgCtx.reply("⏳ 正在处理，请稍候...");
    }
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/telegram/create-bot.ts
git commit -m "feat(bot): replace hardcoded passthrough with dynamic skill names"
```

---

### Task 3: Wire `discoverSkills` into `runtime.ts` startup flow

**Files:**
- Modify: `src/app/runtime.ts:1-10` (imports)
- Modify: `src/app/runtime.ts:243-302` (bot startup section)

- [ ] **Step 1: Add the import**

Add to the imports section of `src/app/runtime.ts`:

```typescript
import { discoverSkills } from "../pi/discover.js";
```

- [ ] **Step 2: Call `discoverSkills` before `createBot`**

In `runtime.ts`, insert the discovery call between the tool system prompt section (after line 241) and the single bot startup section (before line 245). The new code goes right before `const botName = ...`:

```typescript
  // ── Discover pi skills ──

  const skillNames = await discoverSkills({
    cwd: resolved.cwd,
    piArgs: [],
    appendSystemPrompt: toolSystemPromptArg,
  });

  if (skillNames.length > 0) {
    log.boot(`发现 ${skillNames.length} 个技能: ${skillNames.join(", ")}`);
  } else {
    log.warn("未发现任何 pi 技能，所有 slash 命令将被忽略");
  }
```

- [ ] **Step 3: Pass `skillNames` to `createBot`**

In the `createBot()` call (around line 274), add the `skillNames` property:

```typescript
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
    skillNames,
    onStreamModeChange: async (chatId, enabled) => {
      // ... existing callback unchanged ...
    },
  });
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Manual smoke test**

Run: `npm run dev`

Expected startup log output should include one of:
- `[boot] 发现 N 个技能: img-gen` (if skills are installed)
- `[warn] 未发现任何 pi 技能，所有 slash 命令将被忽略` (if no skills)

Verify the bot starts and begins polling normally after skill discovery.

- [ ] **Step 6: Commit**

```bash
git add src/app/runtime.ts
git commit -m "feat(runtime): wire skill discovery into startup flow"
```
