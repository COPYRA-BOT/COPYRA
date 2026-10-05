import { Keypair } from '@solana/web3.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { EvmSigner, InvalidSigningKeyError, NoSignerError, SolanaSigner } from './signer.js';

describe('SolanaSigner', () => {
  it('is unavailable when no material is configured and signing throws', () => {
    const signer = new SolanaSigner(undefined);
    expect(signer.available).toBe(false);
    expect(signer.address).toBeNull();
    expect(() => signer.requireAddress()).toThrow(NoSignerError);
    expect(JSON.stringify(signer)).not.toMatch(/secret|private|\[/i);
  });

  it('loads a generated keypair and never exposes the secret via JSON', () => {
    const keypair = Keypair.generate();
    const signer = new SolanaSigner(JSON.stringify(Array.from(keypair.secretKey)));
    expect(signer.available).toBe(true);
    expect(signer.address).toBe(keypair.publicKey.toBase58());
    const dumped = JSON.stringify(signer);
    expect(dumped).not.toContain(Buffer.from(keypair.secretKey).toString('hex'));
    expect(dumped).toContain(keypair.publicKey.toBase58());
  });

  it('rejects an unparseable key without leaking the input', () => {
    expect(() => new SolanaSigner('not-a-key')).toThrow(InvalidSigningKeyError);
  });
});

describe('EvmSigner', () => {
  it('is unavailable when no material is configured', () => {
    const signer = new EvmSigner(undefined);
    expect(signer.available).toBe(false);
    expect(() => signer.requireAccount()).toThrow(NoSignerError);
  });

  it('loads a generated account and JSON-dumps only the address', () => {
    const generated = generatePrivateKey();
    const account = privateKeyToAccount(generated);
    const signer = new EvmSigner(generated);
    expect(signer.available).toBe(true);
    expect(signer.address).toBe(account.address);
    const dumped = JSON.stringify(signer);
    expect(dumped).not.toContain(generated.slice(2));
    expect(dumped).toContain(account.address);
  });

  it('rejects a short hex string', () => {
    expect(() => new EvmSigner('0x1234')).toThrow(InvalidSigningKeyError);
  });
});
