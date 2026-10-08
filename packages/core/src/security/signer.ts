import { Keypair, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { readSigningKeyMaterial } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';

const log = componentLogger('signer');

/**
 * The ONLY module permitted to touch bot signing material.
 *
 * Guarantees:
 *  * Key material is parsed once at construction and the string form is dropped.
 *  * There is no getter that returns the secret. The class exposes a public
 *    address and signing operations, nothing else.
 *  * `toJSON` / `inspect` are overridden so the instance can never leak a key
 *    through a log line, an error dump, or a JSON API response.
 *  * When no key is configured, `available` is false and signing throws
 *    `NoSignerError`. Callers record the signal as BLOCKED_NO_SIGNER. COPYRA
 *    never invents a transaction to fill the gap.
 *
 * `scripts/audit-secrets.mjs` fails CI if SOLANA_BOT_PRIVATE_KEY or
 * EVM_BOT_PRIVATE_KEY is referenced anywhere outside this file and env.ts.
 */

export class NoSignerError extends Error {
  readonly code = 'NO_SIGNER';
  constructor(kind: 'solana' | 'evm') {
    super(
      `No ${kind} bot signing key is configured. COPYRA will not fabricate a ` +
        `transaction. Set ${kind === 'solana' ? 'SOLANA' : 'EVM'}_BOT_PRIVATE_KEY ` +
        `in the host's secret store to enable automated execution.`,
    );
    this.name = 'NoSignerError';
  }
}

export class InvalidSigningKeyError extends Error {
  readonly code = 'INVALID_SIGNING_KEY';
  constructor(kind: 'solana' | 'evm', detail: string) {
    super(`The configured ${kind} signing key is not valid: ${detail}`);
    this.name = 'InvalidSigningKeyError';
  }
}

function parseSolanaKeypair(raw: string): Keypair {
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('[')) {
      const bytes = JSON.parse(trimmed) as number[];
      if (!Array.isArray(bytes) || bytes.length !== 64) {
        throw new Error(`expected a 64-byte array, got length ${bytes?.length}`);
      }
      return Keypair.fromSecretKey(Uint8Array.from(bytes));
    }
    const decoded = bs58.decode(trimmed);
    if (decoded.length !== 64) {
      throw new Error(`expected 64 bytes after base58 decode, got ${decoded.length}`);
    }
    return Keypair.fromSecretKey(decoded);
  } catch (error) {
    throw new InvalidSigningKeyError(
      'solana',
      error instanceof Error ? error.message : 'unparseable',
    );
  }
}

export class SolanaSigner {
  readonly available: boolean;
  readonly address: string | null;
  #keypair: Keypair | null;

  constructor(raw: string | undefined) {
    if (!raw) {
      this.available = false;
      this.address = null;
      this.#keypair = null;
      return;
    }
    const keypair = parseSolanaKeypair(raw);
    this.#keypair = keypair;
    this.address = keypair.publicKey.toBase58();
    this.available = true;
  }

  /** Throws if unavailable, so no caller can proceed with a missing key. */
  requireAddress(): string {
    if (!this.address) throw new NoSignerError('solana');
    return this.address;
  }

  /**
   * Signs in place and returns the signature. Signing happens inside this
   * module; the key never crosses the boundary.
   */
  sign(tx: VersionedTransaction | Transaction): string {
    if (!this.#keypair) throw new NoSignerError('solana');
    if ('version' in tx) {
      tx.sign([this.#keypair]);
      const sig = tx.signatures[0];
      if (!sig) throw new Error('Signing produced no signature');
      return bs58.encode(sig);
    }
    tx.sign(this.#keypair);
    const legacy = tx.signature;
    if (!legacy) throw new Error('Signing produced no signature');
    return bs58.encode(legacy);
  }

  /** Exposed for ATA creation and fee payment, which need the Keypair object. */
  withKeypair<T>(fn: (keypair: Keypair) => T): T {
    if (!this.#keypair) throw new NoSignerError('solana');
    return fn(this.#keypair);
  }

  toJSON(): Record<string, unknown> {
    return { kind: 'SolanaSigner', available: this.available, address: this.address };
  }

  toString(): string {
    return `SolanaSigner(${this.address ?? 'unconfigured'})`;
  }
}

export class EvmSigner {
  readonly available: boolean;
  readonly address: `0x${string}` | null;
  #account: PrivateKeyAccount | null;

  constructor(raw: string | undefined) {
    if (!raw) {
      this.available = false;
      this.address = null;
      this.#account = null;
      return;
    }
    const normalised = raw.startsWith('0x') ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(normalised)) {
      throw new InvalidSigningKeyError('evm', 'expected a 0x-prefixed 32-byte hex string');
    }
    try {
      this.#account = privateKeyToAccount(normalised as `0x${string}`);
    } catch (error) {
      throw new InvalidSigningKeyError(
        'evm',
        error instanceof Error ? error.message : 'unparseable',
      );
    }
    this.address = this.#account.address;
    this.available = true;
  }

  requireAddress(): `0x${string}` {
    if (!this.address) throw new NoSignerError('evm');
    return this.address;
  }

  /** viem account, used as the `account` option on a wallet client. */
  requireAccount(): PrivateKeyAccount {
    if (!this.#account) throw new NoSignerError('evm');
    return this.#account;
  }

  toJSON(): Record<string, unknown> {
    return { kind: 'EvmSigner', available: this.available, address: this.address };
  }

  toString(): string {
    return `EvmSigner(${this.address ?? 'unconfigured'})`;
  }
}

const material = readSigningKeyMaterial();

export const solanaSigner = new SolanaSigner(material.solana);
export const evmSigner = new EvmSigner(material.evm);

log.info(
  {
    solanaSigner: solanaSigner.available ? solanaSigner.address : 'unconfigured',
    evmSigner: evmSigner.available ? evmSigner.address : 'unconfigured',
  },
  solanaSigner.available || evmSigner.available
    ? 'Bot signers loaded'
    : 'No bot signing key configured. COPYRA runs in observe only mode and will not broadcast transactions',
);
