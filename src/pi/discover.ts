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

export interface DiscoveredSkill {
  name: string;
  description: string;
}

export async function discoverSkills(opts: DiscoverOptions): Promise<DiscoveredSkill[]> {
  const args = ["--mode", "rpc", "--no-session", ...opts.piArgs];

  const append = (opts.appendSystemPrompt || "").trim();
  if (append && !args.includes("--append-system-prompt")) {
    args.push("--append-system-prompt", append);
  }

  const isWin = process.platform === "win32";
  const cmd = isWin ? "cmd.exe" : "pi";
  const cmdArgs = isWin ? ["/d", "/s", "/c", "pi", ...args] : args;

  return new Promise<DiscoveredSkill[]>((resolve) => {
    const proc = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      log.warn("skill 探测超时（10s），跳过");
      cleanup();
      resolve([] as DiscoveredSkill[]);
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
          .map((c) => ({
            name: c.name.replace(/^skill:/, ""),
            description: c.description || "",
          }));

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
