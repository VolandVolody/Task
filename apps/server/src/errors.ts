import { ParseError, WorkflowError } from "@taskos/core";

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function publicError(error: unknown): { status: number; code: string; message: string; details?: string } {
  if (error instanceof AppError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof WorkflowError) return { status: 409, code: "WORKFLOW", message: error.message };
  if (error instanceof ParseError) {
    return { status: 502, code: "AI_PARSE", message: "Не удалось разобрать ответ Grok", details: error.message };
  }
  const details = error instanceof Error ? error.message : String(error);
  return { status: 500, code: "INTERNAL", message: "Внутренняя ошибка", details };
}

export function abortError(): Error {
  const error = new Error("Остановлено");
  error.name = "AbortError";
  return error;
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
