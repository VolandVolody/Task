import fs from "node:fs";
import path from "node:path";

export class InstanceLock {
  constructor(private readonly file: string) {}

  acquire(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      const owner = readPid(this.file);
      if (owner && owner !== process.pid && pidAlive(owner)) {
        throw new Error("TaskOS уже запущен для этого workspace");
      }
      fs.rmSync(this.file, { force: true });
    }
    fs.writeFileSync(this.file, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  }

  release(): void {
    if (!fs.existsSync(this.file)) return;
    const owner = readPid(this.file);
    if (owner === process.pid) fs.rmSync(this.file, { force: true });
  }
}

function readPid(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
