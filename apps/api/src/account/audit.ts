import { prisma, type Prisma } from '@copyra/db';
import type { FastifyRequest } from 'fastify';

export async function audit(
  action: string,
  opts: {
    userId?: string | null;
    detail?: Record<string, unknown>;
    request?: FastifyRequest;
  } = {},
): Promise<void> {
  const ip =
    opts.request?.ip ??
    (typeof opts.request?.headers['x-forwarded-for'] === 'string'
      ? opts.request.headers['x-forwarded-for'].split(',')[0]?.trim()
      : null);
  await prisma.accountAuditLog.create({
    data: {
      userId: opts.userId ?? null,
      action,
      detail: (opts.detail ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: ip ?? null,
      userAgent: typeof opts.request?.headers['user-agent'] === 'string' ? opts.request.headers['user-agent'] : null,
    },
  });
}
