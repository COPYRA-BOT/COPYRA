import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chain } from '@copyra/db';
import { getAddress } from 'viem';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';

const mem = new Map<string, string>();

vi.mock('@copyra/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@copyra/core')>();
  return {
    ...actual,
    storeAuthNonce: async (address: string, chain: string, nonce: string) => {
      mem.set(`${chain}:${address}`, nonce);
      return { expiresAt: new Date(Date.now() + 600_000) };
    },
    consumeAuthNonce: async (address: string, chain: string) => {
      const key = `${chain}:${address}`;
      const value = mem.get(key) ?? null;
      mem.delete(key);
      return value;
    },
    peekAuthNonce: async (address: string, chain: string) => mem.get(`${chain}:${address}`) ?? null,
  };
});

describe('Auth nonces (in-memory Redis contract) + SIWE/SIWS verify', () => {
  beforeEach(() => {
    mem.clear();
  });

  it('stores and one-time-consumes a nonce', async () => {
    const { issueNonce } = await import('./auth.js');
    const { peekAuthNonce, consumeAuthNonce } = await import('@copyra/core');
    const address = '7EqQdEUSxH4xviK3jY5W8s2nQv8m1kP9oL3rT6uY2xA';
    const { nonce, expiresAt } = await issueNonce(address, Chain.SOLANA);
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await peekAuthNonce(address, Chain.SOLANA)).toBe(nonce);
    expect(await consumeAuthNonce(address, Chain.SOLANA)).toBe(nonce);
    expect(await consumeAuthNonce(address, Chain.SOLANA)).toBeNull();
  });

  it('rejects replay after nonce consume (rejected signature / double submit)', async () => {
    const { issueNonce, buildSiwsMessage, verifyWalletSignature } = await import('./auth.js');
    const { consumeAuthNonce } = await import('@copyra/core');
    const address = '7EqQdEUSxH4xviK3jY5W8s2nQv8m1kP9oL3rT6uY2xA';
    const { nonce } = await issueNonce(address, Chain.SOLANA);
    const message = buildSiwsMessage({
      address,
      nonce,
      issuedAt: new Date().toISOString(),
      webOrigin: 'https://copyra.fun',
      domainHost: 'copyra.fun',
    });
    await consumeAuthNonce(address, Chain.SOLANA);
    const ok = await verifyWalletSignature({
      address,
      storageAddress: address,
      chain: Chain.SOLANA,
      message,
      signature: bs58.encode(Buffer.alloc(64)),
    });
    expect(ok).toBe(false);
  });

  it('accepts a real Solana ed25519 signature against a one-time nonce', async () => {
    const { issueNonce, buildSiwsMessage, verifyWalletSignature } = await import('./auth.js');
    const kp = Keypair.generate();
    const address = kp.publicKey.toBase58();
    const { nonce } = await issueNonce(address, Chain.SOLANA);
    const message = buildSiwsMessage({
      address,
      nonce,
      issuedAt: new Date().toISOString(),
      webOrigin: 'http://127.0.0.1:41717',
      domainHost: '127.0.0.1:41717',
    });
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    const ok = await verifyWalletSignature({
      address,
      storageAddress: address,
      chain: Chain.SOLANA,
      message,
      signature: bs58.encode(sig),
    });
    expect(ok).toBe(true);
    const replay = await verifyWalletSignature({
      address,
      storageAddress: address,
      chain: Chain.SOLANA,
      message,
      signature: bs58.encode(sig),
    });
    expect(replay).toBe(false);
  });

  it('accepts a real EVM personal_sign against a one-time nonce', async () => {
    const { issueNonce, buildSiweMessage, verifyWalletSignature } = await import('./auth.js');
    const account = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const checksum = getAddress(account.address);
    const storage = checksum.toLowerCase();
    const { nonce } = await issueNonce(storage, Chain.ETHEREUM);
    const message = buildSiweMessage({
      address: checksum,
      nonce,
      chainId: 1,
      issuedAt: new Date().toISOString(),
      webOrigin: 'http://127.0.0.1:41717',
      domainHost: '127.0.0.1:41717',
    });
    const signature = await account.signMessage({ message });
    const ok = await verifyWalletSignature({
      address: checksum,
      storageAddress: storage,
      chain: Chain.ETHEREUM,
      message,
      signature,
    });
    expect(ok).toBe(true);
  });

  it('rejects an invalid EVM signature (user rejected / wrong key)', async () => {
    const { issueNonce, buildSiweMessage, verifyWalletSignature } = await import('./auth.js');
    const account = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const other = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    );
    const checksum = getAddress(account.address);
    const storage = checksum.toLowerCase();
    const { nonce } = await issueNonce(storage, Chain.ETHEREUM);
    const message = buildSiweMessage({
      address: checksum,
      nonce,
      chainId: 1,
      issuedAt: new Date().toISOString(),
      webOrigin: 'http://127.0.0.1:41717',
      domainHost: '127.0.0.1:41717',
    });
    const badSig = await other.signMessage({ message });
    const ok = await verifyWalletSignature({
      address: checksum,
      storageAddress: storage,
      chain: Chain.ETHEREUM,
      message,
      signature: badSig,
    });
    expect(ok).toBe(false);
  });
});
