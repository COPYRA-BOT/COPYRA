import { Chain, CustodyFamily, prisma } from '@copyra/db';
import { Keypair, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from 'node:crypto';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { chainConfig } from '../config/chains.js';
import { env } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';

const log = componentLogger('user-custody');

export class CustodyNotConfiguredError extends Error {
  readonly code = 'CUSTODY_NOT_CONFIGURED';
  constructor() {
    super(
      'Multi-user custody is disabled. Set MULTI_USER_CUSTODY=true to enable per-user deposit wallets.',
    );
    this.name = 'CustodyNotConfiguredError';
  }
}

export function multiUserCustodyEnabled(): boolean {
  return env.MULTI_USER_CUSTODY;
}

function derivationSecret(): string {
  const explicit = env.CUSTODY_DERIVATION_SECRET?.trim();
  if (explicit && explicit.length >= 32) return explicit;
  return env.SESSION_SECRET;
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(`${derivationSecret()}:custody-aes:v1`).digest();
}

export function encryptKeyMaterial(plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptKeyMaterial(payload: string): Buffer {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('Invalid encrypted custody payload.');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/** Deterministic 32-byte seed for a user + family (never logged). */
export function deriveCustodySeed(userId: string, family: CustodyFamily): Buffer {
  const label = family === CustodyFamily.SOLANA ? 'sol:v1' : 'evm:v1';
  return createHmac('sha256', derivationSecret()).update(`${label}:${userId}`).digest();
}

export function deriveSolanaKeypair(userId: string): Keypair {
  const seed = deriveCustodySeed(userId, CustodyFamily.SOLANA).subarray(0, 32);
  return Keypair.fromSeed(seed);
}

export function deriveEvmAccount(userId: string): PrivateKeyAccount {
  const seed = deriveCustodySeed(userId, CustodyFamily.EVM);
  const hex = `0x${seed.toString('hex')}` as `0x${string}`;
  return privateKeyToAccount(hex);
}

function familyForChain(chain: Chain): CustodyFamily {
  return chainConfig(chain).kind === 'solana' ? CustodyFamily.SOLANA : CustodyFamily.EVM;
}

export async function ensureUserCustodyWallet(
  userId: string,
  family: CustodyFamily,
): Promise<{ address: string; family: CustodyFamily }> {
  const existing = await prisma.userCustodyWallet.findUnique({
    where: { userId_family: { userId, family } },
  });
  if (existing) return { address: existing.address, family: existing.family };

  const keypair = family === CustodyFamily.SOLANA ? deriveSolanaKeypair(userId) : null;
  const evm = family === CustodyFamily.EVM ? deriveEvmAccount(userId) : null;
  const address =
    family === CustodyFamily.SOLANA
      ? keypair!.publicKey.toBase58()
      : evm!.address.toLowerCase();
  const secretBytes =
    family === CustodyFamily.SOLANA
      ? Buffer.from(keypair!.secretKey)
      : Buffer.from(deriveCustodySeed(userId, CustodyFamily.EVM));

  const row = await prisma.userCustodyWallet.create({
    data: {
      userId,
      family,
      address,
      encryptedKeyMaterial: encryptKeyMaterial(secretBytes),
      keyVersion: 1,
    },
  });
  log.info({ userId, family, address }, 'Provisioned user custody wallet');
  return { address: row.address, family: row.family };
}

export async function userCustodyAddress(userId: string, chain: Chain): Promise<string> {
  if (!multiUserCustodyEnabled()) {
    throw new CustodyNotConfiguredError();
  }
  const family = familyForChain(chain);
  const wallet = await ensureUserCustodyWallet(userId, family);
  return wallet.address;
}

async function loadSolanaKeypair(userId: string): Promise<Keypair> {
  const row = await prisma.userCustodyWallet.findUnique({
    where: { userId_family: { userId, family: CustodyFamily.SOLANA } },
  });
  if (row) {
    const material = decryptKeyMaterial(row.encryptedKeyMaterial);
    if (material.length === 64) return Keypair.fromSecretKey(Uint8Array.from(material));
  }
  return deriveSolanaKeypair(userId);
}

async function loadEvmAccount(userId: string): Promise<PrivateKeyAccount> {
  const row = await prisma.userCustodyWallet.findUnique({
    where: { userId_family: { userId, family: CustodyFamily.EVM } },
  });
  if (row) {
    const material = decryptKeyMaterial(row.encryptedKeyMaterial);
    const hex = `0x${material.toString('hex')}` as `0x${string}`;
    return privateKeyToAccount(hex);
  }
  return deriveEvmAccount(userId);
}

export async function signUserSolanaTransaction(
  userId: string,
  tx: VersionedTransaction | Transaction,
): Promise<string> {
  const keypair = await loadSolanaKeypair(userId);
  if ('version' in tx) {
    tx.sign([keypair]);
    const sig = tx.signatures[0];
    if (!sig) throw new Error('Signing produced no signature');
    return bs58.encode(sig);
  }
  tx.sign(keypair);
  const legacy = tx.signature;
  if (!legacy) throw new Error('Signing produced no signature');
  return bs58.encode(legacy);
}

export async function userEvmAccount(userId: string): Promise<PrivateKeyAccount> {
  return loadEvmAccount(userId);
}

/** Ensures both Solana and EVM custody wallets exist for a new account. */
export async function provisionUserCustody(userId: string): Promise<void> {
  if (!multiUserCustodyEnabled()) return;
  await Promise.all([
    ensureUserCustodyWallet(userId, CustodyFamily.SOLANA),
    ensureUserCustodyWallet(userId, CustodyFamily.EVM),
  ]);
}
