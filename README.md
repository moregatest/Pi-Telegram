# Pi-Telegram

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Ziphyrien/Pi-Telegram)
[![npm version](https://img.shields.io/npm/v/pi-telegram?logo=npm)](https://www.npmjs.com/package/pi-telegram)
[![npm downloads](https://img.shields.io/npm/dm/pi-telegram)](https://www.npmjs.com/package/pi-telegram)

Pi-Telegram 是一个桥接程序。
它把 Telegram 机器人收到的消息转给 pi coding agent，再把结果发回 Telegram。

> **Fork 说明**：本仓库基于 [Ziphyrien/Pi-Telegram](https://github.com/Ziphyrien/Pi-Telegram) 进行了以下增强，适用于需要在 Telegram 上快速调用 pi 技能（如图片生成）和目录级独立部署的场景。

### 新增功能

**本地模式（Local Mode）**
支持以项目目录为单位独立部署 bot。在任意目录下放置 `.env`（含 `TELEGRAM_BOT_TOKEN`）和 `settings.json`，即可启动一个独立的 bot 实例，运行数据存放在 `cwd/pitg/` 下，不依赖 `~/.pi/telegram/` 全局目录。适合一机多 bot、按项目隔离的部署方式。

**自动技能发现（Auto Skill Discovery）**
bot 启动时自动调用 pi 的 `get_commands` RPC 探测已加载的技能（skills），无需在代码中硬编码。新增或移除 pi 技能后，重启 bot 即可生效。

**Telegram 命令菜单整合**
发现的技能会自动注册到 Telegram 的 `/` 命令菜单中，显示技能名称和描述。用户可以直接从菜单选取技能，bot 会提示输入内容，拼接后自动发送给 pi 执行。

**告警静默化**
附件解析和回复匹配的非关键告警（如 `<tg-reply>` 未匹配到目标消息）不再发送到 Telegram 聊天，改为仅记录在服务端日志中。实际错误（如附件发送失败、pi 执行出错）仍会通知用户。

## 它能做什么

- 在 Telegram 聊天里直接使用 pi
- 支持文本、图片、文档消息
- 每个聊天独立会话，互不干扰
- 支持定时任务
- 支持多个 bot 同时运行

## 运行前准备

1. 安装 Node.js
2. 根据[教程](https://linux.do/t/topic/1680124)安装配置[pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)，并确认终端可以直接执行 `pi`并与其正常对话
3. 在 BotFather 创建 Telegram bot，拿到 token

## 安装

### 全局安装

```bash
npm install -g pi-telegram
pitg
```

### 本地开发运行

```bash
git clone https://github.com/Ziphyrien/Pi-Telegram.git
cd Pi-Telegram
npm install
npm run build
npm start
```

## 首次启动

第一次运行会自动生成配置文件，然后退出：

- Linux/macOS: `~/.pi/telegram/settings.json`
- Windows: `%USERPROFILE%/.pi/telegram/settings.json`

你需要把 token 改成真实值，然后再次启动。

## 配置文件说明

默认模板如下：

```json
{
  "bots": [
    {
      "token": "<YOUR_TELEGRAM_BOT_TOKEN>",
      "name": "Pi-Telegram",
      "allowedUsers": [],
      "cwd": "~/.pi/telegram/workspace",
      "streamByChat": {}
    }
  ],
  "idleTimeoutMs": 600000,
  "maxResponseLength": 4000,
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

关键字段：

- `bots`: bot 列表，可以配置多个
- `bots[].token`: Telegram bot token
- `bots[].name`: bot 名称，用于区分会话目录和任务文件
- `bots[].allowedUsers`: 允许访问的用户列表，支持用户 id 和用户名
- `bots[].cwd`: pi 的工作目录
- `idleTimeoutMs`: 聊天空闲多久后自动回收对应的 pi 进程
- `maxResponseLength`: 单条回复的最大长度，超出会自动分段发送
- `cron`: 定时任务相关配置

`allowedUsers` 为空时，不做访问限制。

## 基本使用

启动后，直接给 bot 发消息即可。

支持的输入：

- 文本消息
- 图片消息
- 文档消息

如果你在 Telegram 里回复某条历史消息，Pi-Telegram 会把被回复内容一起带给 pi，帮助模型理解上下文。

## 命令

- `/status` 查看当前聊天状态
- `/new` 新建会话
- `/abort` 中止当前任务
- `/abortall` 中止当前任务并清空队列
- `/model` 打开模型选择菜单
- `/stream` 切换流式输出或非流式输出
- `/thinking` 设置思考等级
- `/cron` 打开定时任务菜单

## 定时任务

### 常用命令

- `/cron list`
- `/cron stat`
- `/cron add at <ISO时间> <内容>`
- `/cron add every <间隔> <内容>`
- `/cron add cron "<表达式>" [时区] <内容>`
- `/cron on <id>`
- `/cron off <id>`
- `/cron del <id>`
- `/cron rename <id> <新名称>`
- `/cron run <id>`

间隔支持 `s`、`m`、`h`、`d`，例如 `30s`、`10m`、`2h`、`1d`。

你也可以用 `名称||内容` 这种写法给任务单独命名。

示例：

```bash
/cron add every 10m 巡检||检查报警并总结
/cron add at 2026-03-01T09:00:00+08:00 早报||汇总昨日日志
/cron add cron "0 9 * * 1-5" Asia/Shanghai 工作日早报||汇总日报
```

## AI 标签

Pi-Telegram 会给模型注入三种标签协议。模型需要时会自动输出这些标签。

- `tg-reply`: 让回复挂到某条历史消息
- `tg-attachment`: 发送附件
- `tg-cron`: 创建和管理定时任务

你一般不需要手动写这些标签，模型会根据场景决定是否使用。

## 数据目录

`~/.pi/telegram` 下的主要目录：

- `settings.json`: 主配置
- `workspace/`: 默认工作目录
- `sessions/`: 每个 bot 和聊天的会话数据
- `cron/`: 定时任务持久化文件
- `inbound/`: 从 Telegram 下载的图片和文件

## pi --session-dir 说明

Pi-Telegram 启动每个聊天对应的 `pi` 进程时，会固定传入 `--session-dir`。

作用是把该聊天的会话数据落盘，进程重启后还能继续上下文。

目录规则是：

- `~/.pi/telegram/sessions/<bot-name>/bot<token哈希>_chat<chatId>`

简单理解：

- 同一个聊天会一直用同一个 `--session-dir`
- 不同聊天用不同目录，互不影响
- 常规自动拉起时会带 `-c`，会从该目录继续会话
- 你执行 `/new` 后会新建会话，不再沿用旧上下文

一般情况下不需要手动传这个参数，Pi-Telegram 已经自动处理。

### 直接用 pi 查看历史会话

你也可以在终端直接用 `pi` 查看某个聊天的历史会话。
关键是使用该聊天对应的 `--session-dir`。

```bash
pi --session-dir "<会话目录>" -r
```

`-r` 会打开会话列表，你可以选择历史会话继续查看。

常用写法：

- `pi --session-dir "<会话目录>" -c` 继续最近会话
- `pi --session-dir "<会话目录>" --session <会话文件或会话ID>` 打开指定会话
