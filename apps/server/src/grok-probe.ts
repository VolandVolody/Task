import { execFile } from "node:child_process";
import fs from "node:fs";

export const REQUIRED_GROK_FLAGS = ["--prompt-file", "--output-format", "--json-schema", "--permission-mode"] as const;

export interface GrokProbe {
  available: boolean;
  compatible: boolean;
  version: string | null;
  missing: string[];
  message: string | null;
}

export function missingGrokFlags(help: string): string[] {
  return REQUIRED_GROK_FLAGS.filter((flag) => !help.includes(flag));
}

export async function probeGrok(command: string): Promise<GrokProbe> {
  const binary = await locate(command);
  if (!binary) {
    return {
      available: false,
      compatible: false,
      version: null,
      missing: [],
      message: `Команда ${command} не найдена. Установите Grok Build и проверьте PATH.`,
    };
  }
  const version = (await run(binary, ["--version"])).trim().split(/\r?\n/).find(Boolean) ?? null;
  const help = await run(binary, ["--help"]);
  const missing = missingGrokFlags(help);
  if (missing.length > 0) {
    return {
      available: true,
      compatible: false,
      version,
      missing,
      message: `Grok Build не подходит для TaskOS: нет флагов ${missing.join(", ")}.`,
    };
  }
  return { available: true, compatible: true, version, missing: [], message: null };
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) reject(error);
      else resolve(`${stdout}\n${stderr}`);
    });
  });
}

function locate(command: string): Promise<string | null> {
  if (command.includes("\\") || command.includes("/") || /^[A-Za-z]:/.test(command)) {
    return Promise.resolve(fs.existsSync(command) ? command : null);
  }
  const which = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolve) => {
    execFile(which, [command], { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? null);
    });
  });
}
