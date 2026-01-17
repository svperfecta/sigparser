type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  requestId?: string | undefined;
  [key: string]: unknown;
}

export interface Logger {
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}

export function createLogger(requestId?: string): Logger {
  const log = (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      requestId,
      ...data,
    };

    // Cloudflare Workers logs to console are captured
    if (level === 'error') {
      console.error(JSON.stringify(entry));
    } else if (level === 'warn') {
      console.warn(JSON.stringify(entry));
    } else {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(entry));
    }
  };

  return {
    debug: (msg: string, data?: Record<string, unknown>): void => {
      log('debug', msg, data);
    },
    info: (msg: string, data?: Record<string, unknown>): void => {
      log('info', msg, data);
    },
    warn: (msg: string, data?: Record<string, unknown>): void => {
      log('warn', msg, data);
    },
    error: (msg: string, data?: Record<string, unknown>): void => {
      log('error', msg, data);
    },
  };
}
