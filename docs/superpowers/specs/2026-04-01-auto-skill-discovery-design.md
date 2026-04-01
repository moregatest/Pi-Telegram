# Auto Skill Discovery Design

## Problem

Pi-Telegram 的 slash command passthrough 目前是硬編碼的：`passthroughCommands = ["img_gen"]`。每新增一個 pi skill 都需要改程式碼。需要改為自動探測 pi 已載入的 skills，動態建立 passthrough 清單。

## Decision Summary

- **探測方式：** 啟動時 spawn 臨時 pi RPC 進程，呼叫 `get_commands`
- **過濾範圍：** 只處理 `source: "skill"` 的項目（不含 extensions、prompt templates）
- **ACK 訊息：** 所有 passthrough 命令發送通用 ACK「⏳ 正在处理，请稍候...」
- **失敗策略：** 探測失敗時 log warning，回傳空陣列，不阻擋 bot 啟動

## Architecture

### 新增模組：`src/pi/discover.ts`

```typescript
discoverSkills(opts: { cwd: string; piArgs: string[]; appendSystemPrompt?: string }): Promise<string[]>
```

行為：
1. Spawn `pi --mode rpc` 進程，帶跟正式進程相同的參數（`--append-system-prompt` 等）
2. 透過 JSONL stdin 送 `{ type: "get_commands" }`
3. 從 stdout 讀取 response，過濾 `source === "skill"`
4. 提取 skill name，去掉 `skill:` 前綴
5. Kill 進程，回傳 `string[]`

約束：
- 10 秒 timeout，防止探測卡住
- 使用現有的 `readJsonlLine` / JSONL 工具解析
- 探測失敗 catch all，log warning 並回傳 `[]`

### 修改：`src/telegram/create-bot.ts`

- `createBot()` 新增 `skillNames: string[]` 參數
- 刪除硬編碼的 `passthroughCommands = ["img_gen"]`
- 從 `skillNames` 動態建立 passthrough 清單
- 名稱正規化：pi skill 用 kebab-case（`img-gen`），Telegram 命令用 underscore（`img_gen`），匹配時做 `hyphen → underscore` 轉換
- ACK 訊息改為通用的 `"⏳ 正在处理，请稍候..."`
- `isPassthroughCommand()` 改為基於正規化後的 skill 清單判斷

### 修改：`src/app/runtime.ts`

啟動流程從：
```
loadConfig → createPiPool → createCronService → createBot → startPolling
```

改為：
```
loadConfig → discoverSkills → createPiPool → createCronService → createBot(skillNames) → startPolling
```

- `discoverSkills()` 的參數從 `ResolvedConfig` 取得（`config.cwd`、`appendSystemPrompt`）
- 啟動時 log 探測結果：`[bot] 发现 N 个技能: skill1, skill2`
- 空陣列時 log warning 但正常啟動

## Data Flow

```
Bot startup
  │
  ├─ discoverSkills()
  │    ├─ spawn pi --mode rpc (temp)
  │    ├─ send { type: "get_commands" }
  │    ├─ receive { commands: [{ name: "skill:img-gen", source: "skill", ... }] }
  │    ├─ filter source === "skill" → ["img-gen"]
  │    └─ kill process, return ["img-gen"]
  │
  ├─ createBot(config, pool, cronService, ["img-gen"])
  │    ├─ normalize: ["img-gen"] → Set {"img_gen"}
  │    └─ isPassthroughCommand("/img_gen ...") → true
  │
  └─ User sends "/img_gen a cat"
       ├─ isPassthroughCommand → true
       ├─ send ACK: "⏳ 正在处理，请稍候..."
       └─ forward full text to pi as prompt
```

## Naming Convention

| Context | Format | Example |
|---------|--------|---------|
| Pi skill name | kebab-case | `img-gen` |
| `get_commands` response | `skill:` prefix | `skill:img-gen` |
| Telegram command | underscore | `/img_gen` |
| Matching logic | normalize hyphen→underscore | `img-gen` → `img_gen` |

## Files Changed

| File | Change |
|------|--------|
| `src/pi/discover.ts` | 新增 — skill 探測函數 |
| `src/telegram/create-bot.ts` | 修改 — 動態 passthrough，刪除硬編碼 |
| `src/app/runtime.ts` | 修改 — 啟動時呼叫 discoverSkills |
