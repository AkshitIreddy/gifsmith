/**
 * Tiny logger. gifsmith prints a compact, greppable trace by default and stays
 * silent when `quiet` is set (e.g. when driven as a library or MCP tool).
 */
export type LogLevel = 'silent' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { silent: 0, warn: 1, info: 2, debug: 3 };

export class Logger {
  constructor(private level: LogLevel = 'info') {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private enabled(l: LogLevel): boolean {
    return ORDER[this.level] >= ORDER[l];
  }

  info(...args: unknown[]): void {
    if (this.enabled('info')) console.error('[gifsmith]', ...args);
  }

  warn(...args: unknown[]): void {
    if (this.enabled('warn')) console.error('[gifsmith] ⚠', ...args);
  }

  debug(...args: unknown[]): void {
    if (this.enabled('debug')) console.error('[gifsmith:debug]', ...args);
  }

  /** A discrete pipeline step, e.g. "capture", "loop", "encode". */
  step(name: string, ...args: unknown[]): void {
    if (this.enabled('info')) console.error(`[gifsmith] › ${name}`, ...args);
  }
}

export const defaultLogger = new Logger('info');
