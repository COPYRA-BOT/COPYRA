import * as Sentry from '@sentry/node';
import { Chain, SystemEventLevel, prisma } from '@copyra/db';
import { env, isProduction } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';
import { redact, redactString } from './redact.js';
import { telegram } from '../notify/telegram.js';
import { renderSystemAlert } from '../notify/messages.js';

const log = componentLogger('sentry');

let initialised = false;

export function initSentry(serviceName: string): void {
  if (initialised) return;
  if (!env.SENTRY_DSN) {
    log.warn({}, 'SENTRY_DSN not set; error reporting is local-only');
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    serverName: serviceName,
    tracesSampleRate: isProduction ? 0.1 : 0,
    // Last-resort redaction: Sentry captures local variables and request data,
    // either of which could otherwise carry a credential.
    beforeSend(event) {
      if (event.message) event.message = redactString(event.message);
      if (event.extra) event.extra = redact(event.extra);
      if (event.request?.headers) delete event.request.headers;
      if (event.request?.cookies) delete event.request.cookies;
      for (const exception of event.exception?.values ?? []) {
        if (exception.value) exception.value = redactString(exception.value);
      }
      return event;
    },
  });
  Sentry.setTag('service', serviceName);
  initialised = true;
  log.info({ service: serviceName }, 'Sentry initialised');
}

export interface ReportOptions {
  component: string;
  code: string;
  chain?: Chain;
  context?: Record<string, unknown>;
  /** Also push to Telegram. Spec §22 requires alerts on any error. */
  notify?: boolean;
  level?: SystemEventLevel;
}

/**
 * Single error path for the whole system: structured log, `system_events` row,
 * Sentry, and (optionally) a Telegram alert.
 *
 * Never throws. An error in the error reporter must not take down a trading
 * worker, so every sink is individually guarded.
 */
export async function reportError(error: unknown, options: ReportOptions): Promise<void> {
  const level = options.level ?? SystemEventLevel.ERROR;
  const message = error instanceof Error ? error.message : String(error);
  const code = options.code;

  log.error(
    { component: options.component, code, chain: options.chain, err: error, ...options.context },
    message,
  );

  try {
    if (initialised) {
      Sentry.withScope((scope) => {
        scope.setTag('component', options.component);
        scope.setTag('code', code);
        if (options.chain) scope.setTag('chain', options.chain);
        scope.setContext('copyra', redact(options.context ?? {}));
        scope.setLevel(level === SystemEventLevel.CRITICAL ? 'fatal' : 'error');
        if (error instanceof Error) Sentry.captureException(error);
        else Sentry.captureMessage(redactString(message));
      });
    }
  } catch (sentryError) {
    log.warn({ err: sentryError }, 'Sentry capture failed');
  }

  try {
    await prisma.systemEvent.create({
      data: {
        level,
        component: options.component,
        code,
        message: redactString(message).slice(0, 2_000),
        context: redact(options.context ?? {}) as object,
        chain: options.chain ?? null,
      },
    });
  } catch (dbError) {
    log.warn({ err: dbError }, 'Could not persist system event');
  }

  if (options.notify) {
    telegram.send(
      renderSystemAlert({
        level: level === SystemEventLevel.CRITICAL ? 'CRITICAL' : 'ERROR',
        component: options.component,
        code,
        message,
        detail: options.chain ? `Chain: ${options.chain}` : undefined,
      }),
      { kind: `error:${code}` },
    );
  }
}

/** Informational system event. Logged and persisted, not sent to Sentry. */
export async function recordEvent(options: {
  component: string;
  code: string;
  message: string;
  level?: SystemEventLevel;
  chain?: Chain;
  context?: Record<string, unknown>;
}): Promise<void> {
  const level = options.level ?? SystemEventLevel.INFO;
  log.info(
    { component: options.component, code: options.code, chain: options.chain, ...options.context },
    options.message,
  );
  try {
    await prisma.systemEvent.create({
      data: {
        level,
        component: options.component,
        code: options.code,
        message: redactString(options.message).slice(0, 2_000),
        context: redact(options.context ?? {}) as object,
        chain: options.chain ?? null,
      },
    });
  } catch (error) {
    log.warn({ err: error }, 'Could not persist system event');
  }
}

export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  if (!initialised) return;
  await Sentry.flush(timeoutMs).catch(() => undefined);
}

export { Sentry };
