import { execFile } from "node:child_process";
import { isSecretPath } from "@taskos/core";
import { AppError } from "./errors.js";

export type SyncState = "synced" | "local" | "remote" | "conflict" | "offline";

export interface SyncSnapshot {
  state: SyncState;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  message: string;
}

export class MetadataSync {
  constructor(private readonly root: string) {}

  async status(): Promise<SyncSnapshot> {
    try {
      return await this.inspect(false);
    } catch (error) {
      return {
        state: "offline",
        branch: null,
        ahead: null,
        behind: null,
        dirty: false,
        message: error instanceof Error ? error.message : "Git недоступен",
      };
    }
  }

  async fetch(): Promise<SyncSnapshot> {
    await this.git(["fetch", "--prune"]);
    return this.inspect(true);
  }

  async pull(): Promise<SyncSnapshot> {
    await this.git(["fetch", "--prune"]);
    const current = await this.inspect(true);
    if (current.state === "conflict") return current;
    if ((current.behind ?? 0) === 0) return { ...current, message: "Удалённых изменений метаданных нет" };
    const names = await this.names(["diff", "--name-only", "HEAD...@{upstream}"]);
    const outside = names.filter((name) => !isTaskos(name));
    if (outside.length > 0) {
      return {
        ...current,
        state: "conflict",
        message: "В удалённых коммитах есть файлы вне .taskos. Автослияние остановлено.",
      };
    }
    await this.git(["merge", "--ff-only", "@{upstream}"]);
    return this.inspect(true);
  }

  async commit(): Promise<SyncSnapshot> {
    const branch = await this.branch();
    this.refuseProtected(branch);
    await this.git(["add", "--", ".taskos"]);
    const staged = await this.names(["diff", "--cached", "--name-only", "--", ".taskos"]);
    const secrets = staged.filter(isSecretPath);
    if (secrets.length > 0) {
      await this.git(["restore", "--staged", "--", ...secrets]).catch(() => undefined);
      throw new AppError(409, "SECRET", "Коммит метаданных остановлен: похоже на секреты.", secrets.join("\n"));
    }
    const left = await this.names(["diff", "--cached", "--name-only", "--", ".taskos"]);
    if (left.length === 0) {
      const current = await this.inspect(false);
      return { ...current, message: "В .taskos нет изменений для коммита" };
    }
    await this.git(["commit", "-m", "taskos: sync metadata"]);
    const current = await this.inspect(false);
    return { ...current, message: "Метаданные закоммичены" };
  }

  async push(): Promise<SyncSnapshot> {
    const branch = await this.branch();
    this.refuseProtected(branch);
    const upstream = await this.upstream();
    if (upstream) await this.git(["push", "origin", "HEAD"]);
    else await this.git(["push", "-u", "origin", "HEAD"]);
    const current = await this.inspect(false);
    return { ...current, message: "Метаданные отправлены" };
  }

  private refuseProtected(branch: string): void {
    if (branch === "main" || branch === "master") {
      throw new AppError(409, "BRANCH", "Коммит и push метаданных с main/master запрещены");
    }
  }

  private async inspect(afterFetch: boolean): Promise<SyncSnapshot> {
    const branch = await this.branch();
    const dirty = (await this.names(["status", "--porcelain", "--", ".taskos"])).length > 0;
    const upstream = await this.upstream();
    if (!upstream) {
      return {
        state: dirty ? "local" : "synced",
        branch,
        ahead: null,
        behind: null,
        dirty,
        message: dirty ? "Есть локальные изменения .taskos" : afterFetch ? "Ветка без upstream" : "Локально чисто",
      };
    }
    const counts = await this.aheadBehind();
    const ahead = counts?.ahead ?? 0;
    const behind = counts?.behind ?? 0;
    if ((ahead > 0 && behind > 0) || (dirty && behind > 0)) {
      return { state: "conflict", branch, ahead, behind, dirty, message: "Ветки разошлись или локальные правки мешают pull. Автоисправление не делается." };
    }
    if (dirty || ahead > 0) {
      return { state: "local", branch, ahead, behind, dirty, message: dirty ? "Есть локальные изменения .taskos" : `Локально впереди на ${ahead}` };
    }
    if (behind > 0) {
      return { state: "remote", branch, ahead, behind, dirty, message: `На remote есть ${behind} коммит(ов)` };
    }
    return { state: "synced", branch, ahead, behind, dirty, message: "Синхронизировано" };
  }

  private async branch(): Promise<string> {
    return (await this.git(["branch", "--show-current"])).trim();
  }

  private async upstream(): Promise<string | null> {
    try {
      const name = (await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim();
      return name || null;
    } catch {
      return null;
    }
  }

  private async aheadBehind(): Promise<{ ahead: number; behind: number } | null> {
    const text = (await this.git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).trim();
    const [ahead, behind] = text.split(/\s+/).map((item) => Number(item));
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  }

  private async names(args: string[]): Promise<string[]> {
    return (await this.git(args)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  private git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd: this.root, windowsHide: true, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        (error, stdout, stderr) => {
          if (error) reject(new Error((stderr || error.message).trim()));
          else resolve(stdout);
        },
      );
    });
  }
}

function isTaskos(file: string): boolean {
  const name = file.replace(/\\/g, "/");
  return name === ".taskos" || name.startsWith(".taskos/");
}
