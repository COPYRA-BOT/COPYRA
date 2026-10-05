import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { buildSiweMessage, buildSiwsMessage } from './auth.js';

describe('SIWE / SIWS message builders', () => {
  it('uses EIP-55 checksum address and browser domain for EVM', () => {
    const raw = '0xab5801a7d398351b8be11c439e05c5b3259aec9b';
    const checksum = getAddress(raw);
    const message = buildSiweMessage({
      address: checksum,
      nonce: 'abc123',
      chainId: 1,
      issuedAt: '2026-01-01T00:00:00.000Z',
      webOrigin: 'https://copyra.fun',
      domainHost: 'copyra.fun',
    });
    expect(message.startsWith('copyra.fun wants you to sign in with your Ethereum account:')).toBe(
      true,
    );
    expect(message).toContain(`\n${checksum}\n`);
    expect(message).not.toContain(raw); // lowercase must not appear as the account line
    expect(message).toContain('URI: https://copyra.fun');
    expect(message).toContain('Chain ID: 1');
    expect(message).toContain('Nonce: abc123');
  });

  it('prefers domainHost over origin host for Solana SIWS', () => {
    const message = buildSiwsMessage({
      address: '7EqQdEUSxH4xviK3jY5W8s2nQv8m1kP9oL3rT6uY2xA',
      nonce: 'solnonce',
      issuedAt: '2026-01-01T00:00:00.000Z',
      webOrigin: 'https://copyra.fun',
      domainHost: 'www.copyra.fun',
    });
    expect(message.startsWith('www.copyra.fun wants you to sign in with your Solana account:')).toBe(
      true,
    );
    expect(message).toContain('URI: https://copyra.fun');
  });
});
