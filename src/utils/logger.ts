/**
 * Simple structured logger with levels and timestamps.
 * No external deps — just console with formatting.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: " INFO",
  [LogLevel.WARN]: " WARN",
  [LogLevel.ERROR]: "ERROR",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "\x1b[90m",
  [LogLevel.INFO]: "\x1b[36m",
  [LogLevel.WARN]: "\x1b[33m",
  [LogLevel.ERROR]: "\x1b[31m",
};

const RESET = "\x1b[0m";

let currentLevel: LogLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(level: LogLevel, context: string, message: string, data?: unknown): void {
  if (level < currentLevel) return;

  const color = LEVEL_COLORS[level];
  const label = LEVEL_LABELS[level];
  const ts = formatTimestamp();
  const prefix = `${color}[${ts}] ${label}${RESET} [${context}]`;

  if (data !== undefined) {
    console.log(`${prefix} ${message}`, typeof data === "object" ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const logger = {
  debug: (ctx: string, msg: string, data?: unknown) => log(LogLevel.DEBUG, ctx, msg, data),
  info: (ctx: string, msg: string, data?: unknown) => log(LogLevel.INFO, ctx, msg, data),
  warn: (ctx: string, msg: string, data?: unknown) => log(LogLevel.WARN, ctx, msg, data),
  error: (ctx: string, msg: string, data?: unknown) => log(LogLevel.ERROR, ctx, msg, data),

  progress: (ctx: string, current: number, total: number, label: string) => {
    const pct = total > 0 ? ((current / total) * 100).toFixed(1) : "0.0";
    log(LogLevel.INFO, ctx, `[${current}/${total}] (${pct}%) ${label}`);
  },
};
