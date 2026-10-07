import { TxClassification } from '@copyra/db';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { WRAPPED_SOL_MINT_STR } from './connection.js';
import { computeBalanceDeltas, decodeSolanaTransaction } from './decoder.js';

const TRADER = '5KUc73Yc7rJ8oX1TvunRSjYVb36FUFQwSHNw3LtYTLyr';
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const STAKE = 'Stake11111111111111111111111111111111111111';

function pubkey(address: string) {
  return { pubkey: new PublicKey(address), signer: true, writable: true, source: 'transaction' as const };
}

function tokenBalance(owner: string, mint: string, amount: string, decimals: number, accountIndex: number) {
  return {
    accountIndex,
    mint,
    owner,
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    uiTokenAmount: { amount, decimals, uiAmount: null, uiAmountString: amount },
  };
}

function tx(options: {
  programs: string[];
  preToken?: Array<ReturnType<typeof tokenBalance>>;
  postToken?: Array<ReturnType<typeof tokenBalance>>;
  preSol?: number;
  postSol?: number;
  fee?: number;
  err?: object | null;
}) {
  return {
    slot: 453414341,
    blockTime: 1_759_622_400,
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: [pubkey(TRADER)],
        instructions: options.programs.map((program) => ({
          programId: new PublicKey(program),
          accounts: [],
          data: '',
        })),
        recentBlockhash: '11111111111111111111111111111111',
      },
    },
    meta: {
      err: options.err ?? null,
      fee: options.fee ?? 5_000,
      preBalances: [options.preSol ?? 2_000_000_000],
      postBalances: [options.postSol ?? 2_000_000_000],
      preTokenBalances: options.preToken ?? [],
      postTokenBalances: options.postToken ?? [],
      innerInstructions: [],
      logMessages: [],
    },
  } as unknown as Parameters<typeof decodeSolanaTransaction>[0]['tx'];
}

describe('computeBalanceDeltas', () => {
  it('nets SPL token movement for the monitored wallet only', () => {
    const parsed = tx({
      programs: [JUPITER],
      preToken: [tokenBalance(TRADER, TOKEN, '0', 5, 1)],
      postToken: [tokenBalance(TRADER, TOKEN, '1000', 5, 1)],
      preSol: 2_000_000_000,
      postSol: 1_999_995_000,
      fee: 5_000,
    });
    const deltas = computeBalanceDeltas(parsed, TRADER);
    const token = deltas.find((d) => d.mint === TOKEN);
    expect(token?.deltaRaw).toBe(1000n);
  });

  it('does not treat the fee as a SOL spend when the wallet is the fee payer', () => {
    const parsed = tx({
      programs: [JUPITER],
      preSol: 2_000_000_000,
      postSol: 1_999_995_000,
      fee: 5_000,
    });
    const deltas = computeBalanceDeltas(parsed, TRADER);
    expect(deltas.find((d) => d.mint === WRAPPED_SOL_MINT_STR)).toBeUndefined();
  });
});

describe('decodeSolanaTransaction', () => {
  it('classifies a quote-asset spend + token receive as BUY', () => {
    const decoded = decodeSolanaTransaction({
      tx: tx({
        programs: [JUPITER],
        preToken: [tokenBalance(TRADER, TOKEN, '0', 5, 1)],
        postToken: [tokenBalance(TRADER, TOKEN, '54000000000', 5, 1)],
        preSol: 2_000_000_000,
        postSol: 749_995_000,
        fee: 5_000,
      }),
      signature: 'BuySig',
      traderAddress: TRADER,
    });
    expect(decoded.classification).toBe(TxClassification.BUY);
    expect(decoded.venue).toBe('Jupiter v6');
    expect(decoded.tokenIn?.address).toBe(WRAPPED_SOL_MINT_STR);
    expect(decoded.tokenOut?.address).toBe(TOKEN);
    expect(decoded.classificationBasis).toMatch(/quote units|quote asset/i);
  });

  it('classifies a token spend + quote-asset receive as SELL', () => {
    const decoded = decodeSolanaTransaction({
      tx: tx({
        programs: [JUPITER],
        preToken: [tokenBalance(TRADER, TOKEN, '54000000000', 5, 1)],
        postToken: [tokenBalance(TRADER, TOKEN, '0', 5, 1)],
        preSol: 1_000_000_000,
        postSol: 2_249_995_000,
        fee: 5_000,
      }),
      signature: 'SellSig',
      traderAddress: TRADER,
    });
    expect(decoded.classification).toBe(TxClassification.SELL);
    expect(decoded.tokenOut?.address).toBe(WRAPPED_SOL_MINT_STR);
  });

  it('classifies a receive with no spend as AIRDROP, not a buy', () => {
    const decoded = decodeSolanaTransaction({
      tx: tx({
        programs: [],
        preToken: [tokenBalance(TRADER, TOKEN, '0', 5, 1)],
        postToken: [tokenBalance(TRADER, TOKEN, '999', 5, 1)],
        preSol: 1_000_000_000,
        postSol: 999_995_000,
        fee: 5_000,
      }),
      signature: 'AirdropSig',
      traderAddress: TRADER,
    });
    expect(decoded.classification).toBe(TxClassification.AIRDROP);
  });

  it('classifies a failed transaction as UNKNOWN', () => {
    const decoded = decodeSolanaTransaction({
      tx: tx({
        programs: [JUPITER],
        err: { InstructionError: [0, 'Custom'] },
        preSol: 1_000_000_000,
        postSol: 999_995_000,
        fee: 5_000,
      }),
      signature: 'FailSig',
      traderAddress: TRADER,
    });
    expect(decoded.classification).toBe(TxClassification.UNKNOWN);
    expect(decoded.classificationBasis).toMatch(/failed on-chain/i);
  });

  it('classifies a stake-program interaction with no DEX as STAKE', () => {
    const decoded = decodeSolanaTransaction({
      tx: tx({
        programs: [STAKE],
        preSol: 2_000_000_000,
        postSol: 1_000_000_000,
        fee: 5_000,
      }),
      signature: 'StakeSig',
      traderAddress: TRADER,
    });
    expect(decoded.classification).toBe(TxClassification.STAKE);
  });

  it('classifies multi-leg Pump-style buys (quote spend + token + leftover WSOL) as BUY', () => {
    const pumpAmm = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
    const decoded = decodeSolanaTransaction({
      tx: tx({
        programs: [pumpAmm],
        // Spent SOL + received meme token + dust WSOL leftover (3 legs).
        preToken: [
          tokenBalance(TRADER, TOKEN, '0', 6, 1),
          tokenBalance(TRADER, WRAPPED_SOL_MINT_STR, '0', 9, 2),
        ],
        postToken: [
          tokenBalance(TRADER, TOKEN, '999000000', 6, 1),
          tokenBalance(TRADER, WRAPPED_SOL_MINT_STR, '15000', 9, 2),
        ],
        preSol: 2_000_000_000,
        postSol: 1_499_995_000,
        fee: 5_000,
      }),
      signature: 'PumpMultiLeg',
      traderAddress: TRADER,
    });
    expect(decoded.classification).toBe(TxClassification.BUY);
    expect(decoded.tokenOut?.address).toBe(TOKEN);
    expect(decoded.tokenIn?.address).toBe(WRAPPED_SOL_MINT_STR);
    expect(decoded.venue).toBe('Pump.fun AMM');
  });
});
