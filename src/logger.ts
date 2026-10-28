import type { Redactor } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

function describe(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) {
    const stack = meta.stack ? `\n${meta.stack.split('\n').slice(1, 6).join('\n')}` : '';
    return ` ${meta.name}: ${meta.message}${stack}`;
  }
  if (typeof meta === 'string') return ` ${meta}`;
  try {
    const s = JSON.stringify(meta);
    return ` ${s.length > 2000 ? s.slice(0, 2000) + '…' : s}`;
  } catch {
    return ' [unserializable]';
  }
}

/** Every line passes through the redactor, so tokens never reach stdout/log files. */
export function createLogger(redactor: Redactor, level: LogLevel = 'info', sink: (line: string) => void = console.log): Logger {
  const write = (lvl: LogLevel, msg: string, meta?: unknown) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}${describe(meta)}`;
    try {
      sink(redactor.redact(line));
    } catch {
      /* logging must never throw */
    }
  };
  return {
    debug: (m, x) => write('debug', m, x),
    info: (m, x) => write('info', m, x),
    warn: (m, x) => write('warn', m, x),
    error: (m, x) => write('error', m, x),
  };
}
