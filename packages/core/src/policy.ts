const BLOCKS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+-[a-z]*rf[a-z]*\s+\/(\s|$|\*)/i, reason: "Заблокировано: удаление корня файловой системы" },
  { pattern: /\bdel\b[^\n]*\/s\b/i, reason: "Заблокировано: рекурсивное удаление" },
  { pattern: /\bformat\s+[a-z]:/i, reason: "Заблокировано: форматирование диска" },
  { pattern: /\b(shutdown|reboot)\b/i, reason: "Заблокировано: выключение или перезагрузка" },
  { pattern: /\bdiskpart\b/i, reason: "Заблокировано: diskpart" },
  { pattern: /remove-item\b[^\n]*-recurse\b[^\n]*[a-z]:\\/i, reason: "Заблокировано: рекурсивное удаление диска" },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: "Заблокировано: форматирование" },
  { pattern: /\bdd\s+if=/i, reason: "Заблокировано: запись на устройство" },
];

export function blockedCommandReason(command: string): string | null {
  const text = command.trim();
  if (!text) return null;
  for (const rule of BLOCKS) {
    if (rule.pattern.test(text)) return rule.reason;
  }
  return null;
}
