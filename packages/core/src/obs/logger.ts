import pino from 'pino';
import { env, isProduction } from '../config/env.js';
import { redact } from './redact.js';

const base = pino({
  level: env.LOG_LEVEL,
  base: { service: 'copyra' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Structural redaction as a second line of defence behind `redact()`.
  redact: {
    paths: [
      'privateKey',
      'secretKey',
      'mnemonic',
      'seedPhrase',
      'password',
      'apiKey',
      'token',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.privateKey',
      '*.secretKey',
      '*.apiKey',
    ],
    censor: '[REDACTED]',
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino/file',
        options: { destination: 1 },
      },
});

export interface Logger {
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  fatal(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

function wrap(instance: pino.Logger): Logger {
  const emit =
    (level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal') =>
    (obj: unknown, msg?: string): void => {
      if (typeof obj === 'string') {
        instance[level](redact({ msg: obj }));
        return;
      }
      instance[level](redact(obj as Record<string, unknown>), msg);
    };

  return {
    trace: emit('trace'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    fatal: emit('fatal'),
    child: (bindings) => wrap(instance.child(redact(bindings))),
  };
}

export const logger: Logger = wrap(base);

export function componentLogger(component: string): Logger {
  return logger.child({ component });
}
