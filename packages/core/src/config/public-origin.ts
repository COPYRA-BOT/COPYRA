import { env } from './env.js';

function normalizeOrigin(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `https://${trimmed}`;
}

/** All browser origins allowed for CORS and wallet sign-in (SIWE/SIWS). */
export function allowedWebOrigins(): string[] {
  const out = new Set<string>();
  for (const candidate of [
    env.PUBLIC_WEB_URL,
    env.PUBLIC_API_URL,
    env.PUBLIC_PLATFORM_URL,
    ...env.CORS_ORIGINS,
  ]) {
    if (!candidate) continue;
    try {
      out.add(normalizeOrigin(candidate));
    } catch {
      /* skip invalid */
    }
  }
  return [...out];
}

/** Pick the sign-in origin for this request when the Host is allowlisted. */
export function resolveWebOrigin(requestHost: string | undefined): string {
  const host = (requestHost ?? '').split(',')[0]?.trim().toLowerCase();
  if (!host) return env.PUBLIC_WEB_URL;

  for (const origin of allowedWebOrigins()) {
    try {
      if (new URL(origin).host.toLowerCase() === host) return origin;
    } catch {
      /* skip */
    }
  }
  return env.PUBLIC_WEB_URL;
}
