import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface LockInfo {
  token: string;
  pid: number;
  startedAt: string;
}

export class TaskLock {
  constructor(private readonly dir: string) {}

  tryAcquire(taskId: string): { ok: true; token: string } | { ok: false; lock: LockInfo | null } {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(taskId);
    const info: LockInfo = { token: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(file, "wx");
        fs.writeFileSync(fd, JSON.stringify(info));
        fs.closeSync(fd);
        return { ok: true, token: info.token };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        const current = this.read(file);
        if (current && pidAlive(current.pid)) return { ok: false, lock: current };
        fs.rmSync(file, { force: true });
      }
    }
    return { ok: false, lock: this.read(file) };
  }

  release(taskId: string, token?: string): void {
    const file = this.file(taskId);
    if (!fs.existsSync(file)) return;
    if (token) {
      const current = this.read(file);
      if (current && current.token !== token) return;
    }
    fs.rmSync(file, { force: true });
  }

  isLocked(taskId: string): boolean {
    const file = this.file(taskId);
    if (!fs.existsSync(file)) return false;
    const current = this.read(file);
    if (!current) return false;
    if (!pidAlive(current.pid)) return false;
    return true;
  }

  private file(taskId: string): string {
    return path.join(this.dir, `${taskId}.json`);
  }

  private read(file: string): LockInfo | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockInfo>;
      if (!parsed.token || typeof parsed.pid !== "number") return null;
      return { token: parsed.token, pid: parsed.pid, startedAt: parsed.startedAt ?? "" };
    } catch {
      return null;
    }
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
