import { env } from './env.js';

function normalizeOrigin(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `https://${trimmed}`;
}

function originFromReferer(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    const url = new URL(referer);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

/** Expand https allowlist entries with http twins (Cloudflare often serves both). */
function withHttpTwin(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') {
      return [origin, `http://${url.host}`];
    }
    if (url.protocol === 'http:') {
      return [origin, `https://${url.host}`];
    }
  } catch {
    /* skip */
  }
  return [origin];
}

/** All browser origins allowed for CORS and wallet sign-in (SIWE/SIWS). */
export function allowedWebOrigins(): string[] {
  const out = new Set<string>();
  for (const candidate of [
    env.PUBLIC_WEB_URL,
    env.PUBLIC_API_URL,
    env.PUBLIC_PLATFORM_URL,
    ...env.CORS_ORIGINS,
    'https://copyra.fun',
    'http://copyra.fun',
  ]) {
    if (!candidate) continue;
    try {
      const normalized = normalizeOrigin(candidate);
      for (const variant of withHttpTwin(normalized)) out.add(variant);
    } catch {
      /* skip invalid */
    }
  }
  return [...out];
}

function isAllowedOrigin(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  const allowed = allowedWebOrigins();
  if (allowed.includes(normalized)) return true;
  try {
    const host = new URL(normalized).host.toLowerCase();
    return allowed.some((a) => {
      try {
        return new URL(a).host.toLowerCase() === host;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export type OriginRequestHints = {
  requestHost?: string;
  originHeader?: string;
  referer?: string;
  forwardedProto?: string;
};

/**
 * Pick the sign-in origin for this browser request.
 * Prefer the real Origin/Referer so SIWE/SIWS domain + URI match the page
 * (http vs https). Falling back to PUBLIC_WEB_URL alone caused Phantom’s
 * “domain does not match the requesting app's origin” error.
 */
export function resolveWebOrigin(hints: OriginRequestHints | string | undefined): string {
  const opts: OriginRequestHints =
    typeof hints === 'string' || hints === undefined
      ? { requestHost: hints }
      : hints;

  const fromOrigin = opts.originHeader?.trim();
  if (fromOrigin && isAllowedOrigin(fromOrigin)) {
    return normalizeOrigin(fromOrigin);
  }

  const fromReferer = originFromReferer(opts.referer);
  if (fromReferer && isAllowedOrigin(fromReferer)) {
    return normalizeOrigin(fromReferer);
  }

  const host = (opts.requestHost ?? '').split(',')[0]?.trim().toLowerCase();
  const proto = (opts.forwardedProto ?? '').split(',')[0]?.trim().toLowerCase();
  if (host && (proto === 'http' || proto === 'https')) {
    const reconstructed = `${proto}://${host}`;
    if (isAllowedOrigin(reconstructed)) return reconstructed;
  }

  if (host) {
    for (const origin of allowedWebOrigins()) {
      try {
        if (new URL(origin).host.toLowerCase() === host) return origin;
      } catch {
        /* skip */
      }
    }
  }

  return env.PUBLIC_WEB_URL;
}

/** Public Reown / WalletConnect project id (safe to expose to the browser). */
export function publicReownProjectId(): string {
  return (
    process.env.VITE_REOWN_PROJECT_ID?.trim() ||
    process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim() ||
    process.env.REOWN_PROJECT_ID?.trim() ||
    ''
  );
}
