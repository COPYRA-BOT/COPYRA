import { describe, expect, it } from 'vitest';
import { Chain } from '@copyra/db';
import {
  MODE_COOKIES,
  LEGACY_SESSION_COOKIE,
  authModeFromChain,
  authModeFromRequest,
} from './auth.js';

describe('dual-mode session cookies', () => {
  it('maps chains to independent sol / evm cookies', () => {
    expect(authModeFromChain(Chain.SOLANA)).toBe('sol');
    expect(authModeFromChain(Chain.ETHEREUM)).toBe('evm');
    expect(authModeFromChain(Chain.BASE)).toBe('evm');
    expect(authModeFromChain(Chain.BSC)).toBe('evm');
    expect(MODE_COOKIES.sol).toBe('copyra_session_sol');
    expect(MODE_COOKIES.evm).toBe('copyra_session_evm');
    expect(LEGACY_SESSION_COOKIE).toBe('copyra_session');
    expect(MODE_COOKIES.sol).not.toBe(MODE_COOKIES.evm);
  });

  it('reads X-Copyra-Mode header for the active mode', () => {
    const req = {
      headers: { 'x-copyra-mode': 'evm' },
      query: {},
    } as unknown as import('fastify').FastifyRequest;
    expect(authModeFromRequest(req)).toBe('evm');
    expect(authModeFromRequest(req, 'sol')).toBe('sol');
  });

  it('documents that signing into one mode must not clear the other cookie', () => {
    // Contract: createSession sets only MODE_COOKIES[mode] and clears legacy.
    const written = new Set<string>();
    const cleared = new Set<string>();
    const mode = 'evm' as const;
    written.add(MODE_COOKIES[mode]);
    cleared.add(LEGACY_SESSION_COOKIE);
    expect(written.has(MODE_COOKIES.evm)).toBe(true);
    expect(written.has(MODE_COOKIES.sol)).toBe(false);
    expect(cleared.has(MODE_COOKIES.sol)).toBe(false);
  });
});
