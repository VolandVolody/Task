import { execFile } from "node:child_process";
import { isSecretPath } from "@taskos/core";
import { AppError } from "./errors.js";

export interface GitSnapshot {
  branch: string;
  headCommit: string;
  commitsCount: number;
  changedFiles: number;
  changedFileNames: string[];
  diffStat: string;
  dirty: boolean;
}

export class GitAdapter {
  async assertRepo(repo: string): Promise<void> {
    try {
      const inside = (await this.git(repo, ["rev-parse", "--is-inside-work-tree"])).trim();
      if (inside !== "true") throw new AppError(409, "GIT", "Это не git-репозиторий");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, "GIT_UNAVAILABLE", "Git недоступен для этого каталога", errorText(error));
    }
  }

  async ensureBranch(repo: string, base: string, branch: string): Promise<void> {
    if (!branch.startsWith("task/") || branch === "main" || branch === "master" || branch === base) {
      throw new AppError(409, "BRANCH", "Нельзя использовать main как ветку задачи");
    }
    await this.assertRepo(repo);
    if (await this.meaningfulDirty(repo)) {
      const porcelain = await this.git(repo, ["status", "--porcelain"]);
      throw new AppError(
        409,
        "REPO_DIRTY",
        "В репозитории есть незакоммиченные изменения. TaskOS не переключает ветку, пока рабочее дерево грязное.",
        porcelain.trim(),
      );
    }
    const current = (await this.git(repo, ["branch", "--show-current"])).trim();
    if (current === branch) return;
    if (await this.branchExists(repo, branch)) {
      await this.git(repo, ["checkout", branch]);
      return;
    }
    await this.git(repo, ["rev-parse", "--verify", "--quiet", base]).catch(() => {
      throw new AppError(409, "BRANCH", `Базовая ветка ${base} не найдена`);
    });
    await this.git(repo, ["checkout", "-b", branch, base]);
  }

  async commitAll(repo: string, message: string): Promise<string | null> {
    const current = (await this.git(repo, ["branch", "--show-current"])).trim();
    if (current === "main" || current === "master" || !current.startsWith("task/")) {
      throw new AppError(409, "BRANCH", "Отказ: коммит разрешён только в ветке task/…");
    }
    await this.git(repo, ["add", "-A"]);
    await this.git(repo, ["restore", "--staged", "--", ".taskos", ".taskos-local"]).catch(() => undefined);
    let staged = await this.names(repo, ["diff", "--cached", "--name-only"]);
    const secrets = staged.filter(isSecretPath);
    if (secrets.length > 0) {
      await this.git(repo, ["restore", "--staged", "--", ...secrets]).catch(() => undefined);
      throw new AppError(409, "SECRET", "Коммит остановлен: в индексе есть файлы, похожие на секреты.", secrets.join("\n"));
    }
    staged = await this.names(repo, ["diff", "--cached", "--name-only"]);
    if (staged.length === 0) return null;
    try {
      await this.git(repo, ["commit", "-m", message]);
    } catch (error) {
      const details = errorText(error);
      if (/user\.name|user\.email|ident/i.test(details)) {
        throw new AppError(409, "GIT_IDENTITY", "Git не настроен: укажите user.name и user.email в этом репозитории.", details);
      }
      throw error;
    }
    return (await this.git(repo, ["rev-parse", "--short", "HEAD"])).trim();
  }

  async snapshot(repo: string, base: string): Promise<GitSnapshot> {
    await this.assertRepo(repo);
    const branch = (await this.git(repo, ["branch", "--show-current"])).trim();
    const headCommit = (await this.git(repo, ["rev-parse", "--short", "HEAD"])).trim();
    let commitsCount = 0;
    let changedFileNames: string[] = [];
    let diffStat = "";
    try {
      commitsCount = Number((await this.git(repo, ["rev-list", "--count", `${base}..HEAD`])).trim()) || 0;
      changedFileNames = await this.names(repo, ["diff", "--name-only", `${base}...HEAD`]);
      diffStat = (await this.git(repo, ["diff", "--stat", `${base}...HEAD`])).trim();
    } catch {
      commitsCount = 0;
    }
    const dirtyNames = await this.names(repo, ["diff", "--name-only"]);
    const names = [...new Set([...changedFileNames, ...dirtyNames])].slice(0, 100);
    return {
      branch,
      headCommit,
      commitsCount,
      changedFiles: names.length,
      changedFileNames: names,
      diffStat,
      dirty: await this.meaningfulDirty(repo),
    };
  }

  async pullRequest(repo: string): Promise<{ url: string; state: string } | null> {
    try {
      const stdout = await execText("gh", ["pr", "view", "--json", "url,state"], repo);
      const parsed = JSON.parse(stdout) as { url?: string; state?: string };
      if (!parsed.url) return null;
      return { url: parsed.url, state: parsed.state ?? "" };
    } catch {
      return null;
    }
  }

  private async meaningfulDirty(repo: string): Promise<boolean> {
    const lines = (await this.git(repo, ["status", "--porcelain"])).split(/\r?\n/).filter(Boolean);
    return lines.some((line) => !isMetadata(line.slice(3).trim()));
  }

  private async branchExists(repo: string, branch: string): Promise<boolean> {
    try {
      await this.git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async names(repo: string, args: string[]): Promise<string[]> {
    return (await this.git(repo, args)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  private git(repo: string, args: string[]): Promise<string> {
    return execText("git", args, repo).catch((error: unknown) => {
      if (error instanceof AppError) throw error;
      const details = errorText(error);
      if (/ENOENT/.test(details)) throw new AppError(503, "GIT_UNAVAILABLE", "Git не найден в PATH", details);
      if (/conflict/i.test(details)) {
        throw new AppError(409, "BRANCH_CONFLICT", "Конфликт веток. TaskOS не исправляет его автоматически.", details);
      }
      throw new AppError(502, "GIT", "Команда git не выполнилась", details);
    });
  }
}

function isMetadata(file: string): boolean {
  const name = file.replace(/^"|"$/g, "").replace(/\\/g, "/");
  return name === ".taskos" || name === ".taskos-local" || name.startsWith(".taskos/") || name.startsWith(".taskos-local/");
}

function execText(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error((stderr || error.message).trim());
          (wrapped as Error & { code?: string }).code = (error as NodeJS.ErrnoException).code;
          reject(wrapped);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
