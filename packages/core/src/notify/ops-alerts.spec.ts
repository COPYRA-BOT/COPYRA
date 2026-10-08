import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisSet = vi.fn();
const redisDel = vi.fn();
const send = vi.fn();
const sendNow = vi.fn();

vi.mock('../util/redis.js', () => ({
  redis: () => ({
    set: redisSet,
    del: redisDel,
  }),
}));

vi.mock('./telegram.js', () => ({
  telegram: {
    send,
    sendNow,
  },
}));

vi.mock('../config/env.js', () => ({
  env: { PUBLIC_WEB_URL: 'https://copyra.fun' },
}));

vi.mock('../obs/logger.js', () => ({
  componentLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

describe('ops-alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisSet.mockResolvedValue('OK');
    redisDel.mockResolvedValue(1);
    sendNow.mockResolvedValue(true);
  });

  it('sends alert when cooldown allows', async () => {
    const { alertOps } = await import('./ops-alerts.js');
    const ok = await alertOps('worker-down', 'Worker is down', { awaitDelivery: true });
    expect(ok).toBe(true);
    expect(redisSet).toHaveBeenCalledWith('ops:alert:worker-down', '1', 'EX', 15 * 60, 'NX');
    expect(sendNow).toHaveBeenCalledOnce();
    expect(String(sendNow.mock.calls[0]?.[0])).toContain('COPYRA ALERT');
    expect(String(sendNow.mock.calls[0]?.[0])).toContain('Worker is down');
  });

  it('suppresses duplicate alert during cooldown', async () => {
    redisSet.mockResolvedValue(null);
    const { alertOps } = await import('./ops-alerts.js');
    const ok = await alertOps('worker-down', 'Worker is down', { awaitDelivery: true });
    expect(ok).toBe(false);
    expect(sendNow).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('clears cooldown and sends recovery', async () => {
    const { alertOpsCleared } = await import('./ops-alerts.js');
    await alertOpsCleared('worker-down', 'Worker is back');
    expect(redisDel).toHaveBeenCalledWith('ops:alert:worker-down');
    expect(send).toHaveBeenCalledOnce();
    expect(String(send.mock.calls[0]?.[0])).toContain('COPYRA RECOVERED');
  });
});
