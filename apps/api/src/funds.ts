import {
  buildEvmDepositIntent,
  buildSolanaDepositTransaction,
  broadcastSolanaDeposit,
  getTradingAvailableQuote,
  listEvmChainFunds,
  moveBucket,
  multiUserCustodyEnabled,
  pickBestEvmChain,
  prepareEvmWithdrawGas,
  recordEvmCustodyDeposit,
  withdrawToWallet,
} from '@copyra/core';
import { Chain } from '@copyra/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuthMode, readSession } from './auth.js';
import { jsonSafe } from './serialize.js';

const chainSchema = z.nativeEnum(Chain);

async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  mode?: AuthMode,
) {
  const session = await readSession(request, mode);
  if (!session) {
    reply.code(401).send({
      error: `Connect your ${mode === 'evm' ? 'EVM' : 'Solana'} wallet and sign in first. Each mode has its own account session.`,
    });
    return null;
  }
  return session;
}

function modeChain(mode: 'sol' | 'evm', preferred?: Chain): Chain {
  if (mode === 'sol') return Chain.SOLANA;
  if (preferred && preferred !== Chain.SOLANA) return preferred;
  // Fallback only — callers should pick via pickBestEvmChain when possible.
  return Chain.BSC;
}

export async function registerFundsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/funds', async (request, reply) => {
    const query = z
      .object({
        chain: chainSchema.optional(),
        mode: z.enum(['sol', 'evm']).optional(),
      })
      .parse(request.query);
    const mode: AuthMode = query.mode ?? (query.chain === Chain.SOLANA || !query.chain ? 'sol' : 'evm');
    const chain = query.chain ?? modeChain(mode);
    const session = await readSession(request, mode);
    const userId = session?.user.id;
    if (multiUserCustodyEnabled() && !userId) {
      return reply.code(401).send({
        error: `Sign in with your ${mode === 'evm' ? 'EVM' : 'Solana'} wallet to view custody balances.`,
      });
    }
    try {
      const funds = await getTradingAvailableQuote(chain, userId);
      return jsonSafe({
        chain,
        ...funds,
        buckets: {
          trading: funds.availableQuote,
          savings: funds.savingsQuote,
          onChain: funds.onChainQuote,
        },
        note: funds.configured
          ? funds.multiUser
            ? 'Your personal custody wallet on-chain. Trading available = on-chain minus savings reservation and fee buffer.'
            : 'Trading available = on-chain bot wallet minus savings reservation and fee buffer. Savings is a ledger reservation on the same wallet.'
          : multiUserCustodyEnabled()
            ? 'Could not read RPC balance for your custody wallet. Check SOLANA_RPC_URL / EVM RPC env vars on the API component.'
            : 'No bot signing key. Deposit destination and withdraw are unavailable until the host secret store has the Solana/EVM bot signing material.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(503).send({
        error: message,
        chain,
        hint:
          'Set SOLANA_RPC_URL / EVM_*_RPC_URL (and WS) as encrypted App-Level env vars scoped to ALL components, then redeploy.',
      });
    }
  });

  app.post('/api/funds/move', async (request, reply) => {
    const body = z
      .object({
        mode: z.enum(['sol', 'evm']),
        direction: z.enum(['t2s', 's2t']),
        amount: z.number().positive(),
        chain: chainSchema.optional(),
      })
      .parse(request.body);
    const session = await requireSession(request, reply, body.mode);
    if (!session) return;
    let chain = modeChain(body.mode, body.chain);
    if (body.mode === 'evm') {
      // Always resolve against live balances across all EVM chains — never stick on empty Ethereum.
      const prefer = body.direction === 's2t' ? 'savings' : 'trading';
      if (!body.chain || body.chain === Chain.SOLANA) {
        const picked = await pickBestEvmChain({ userId: session.user.id, prefer });
        chain = picked.chain;
      } else {
        // If the client picked a chain with nothing in that bucket, auto-correct.
        try {
          const funds = await getTradingAvailableQuote(body.chain, session.user.id);
          const amt = prefer === 'savings' ? funds.savingsQuote : funds.availableQuote;
          if (!(amt > 0)) {
            const picked = await pickBestEvmChain({ userId: session.user.id, prefer });
            chain = picked.chain;
          }
        } catch {
          const picked = await pickBestEvmChain({ userId: session.user.id, prefer });
          chain = picked.chain;
        }
      }
    }
    try {
      const result = await moveBucket({
        chain,
        direction: body.direction,
        amountQuote: body.amount,
        userId: session.user.id,
      });
      return jsonSafe({ ok: true, ...result, chain });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/funds/deposit/build', async (request, reply) => {
    const body = z
      .object({
        mode: z.enum(['sol', 'evm']),
        amount: z.number().positive(),
        chain: chainSchema.optional(),
      })
      .parse(request.body);
    const session = await requireSession(request, reply, body.mode);
    if (!session) return;

    try {
      if (body.mode === 'sol') {
        if (session.user.chain !== Chain.SOLANA) {
          return reply.code(400).send({ error: 'Sign in with a Solana wallet to deposit SOL.' });
        }
        const built = await buildSolanaDepositTransaction({
          fromAddress: session.user.address,
          amountSol: body.amount,
          userId: session.user.id,
        });
        return jsonSafe({
          kind: 'solana',
          ...built,
          fromAddress: session.user.address,
          note: 'Sign this transfer in your wallet. Funds move on-chain to your COPYRA custody wallet.',
        });
      }
      const chain = modeChain('evm', body.chain);
      const intent = await buildEvmDepositIntent({
        chain,
        amountNative: body.amount,
        userId: session.user.id,
      });
      return jsonSafe({
        ...intent,
        kind: 'evm',
        fromAddress: session.user.address,
        note: 'Pick Ethereum, Base, Arbitrum, or BNB Chain in the deposit modal. This builds a real USDC token transfer on that network. Your wallet must switch to the same network and hold USDC + a little native gas (ETH on Ethereum/Base/Arbitrum, BNB on BNB Chain).',
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/funds/deposit/broadcast', async (request, reply) => {
    const session = await requireSession(request, reply, 'sol');
    if (!session) return;
    const body = z
      .object({
        signedTransaction: z.string().min(32),
        lastValidBlockHeight: z.number().int().positive(),
        lamports: z.string().regex(/^[0-9]+$/),
      })
      .parse(request.body);
    try {
      const result = await broadcastSolanaDeposit({
        signedTransactionBase64: body.signedTransaction,
        lastValidBlockHeight: body.lastValidBlockHeight,
        fromAddress: session.user.address,
        lamports: body.lamports,
        userId: session.user.id,
      });
      return jsonSafe(result);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/funds/deposit/record-evm', async (request, reply) => {
    const session = await requireSession(request, reply, 'evm');
    if (!session) return;
    const body = z
      .object({
        chain: chainSchema,
        txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        amount: z.number().positive(),
      })
      .parse(request.body);
    try {
      const result = await recordEvmCustodyDeposit({
        userId: session.user.id,
        chain: body.chain,
        txHash: body.txHash as `0x${string}`,
        amountQuote: body.amount,
        fromAddress: session.user.address,
      });
      return jsonSafe({
        ...result,
        wallet: session.user.address,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/funds/withdraw/prepare', async (request, reply) => {
    const body = z
      .object({
        mode: z.literal('evm'),
        chain: chainSchema.optional(),
        /** When true (default), return gas+balance for every EVM custody chain. */
        allChains: z.boolean().optional(),
      })
      .parse(request.body);
    const session = await requireSession(request, reply, 'evm');
    if (!session) return;
    try {
      if (body.allChains !== false && !body.chain) {
        const rows = await listEvmChainFunds(session.user.id);
        const picked = await pickBestEvmChain({
          userId: session.user.id,
          prefer: 'withdraw',
          fromBucket: 'trading',
        });
        return jsonSafe({ chains: rows, bestChain: picked.chain });
      }
      const chain = body.chain && body.chain !== Chain.SOLANA ? body.chain : (
        await pickBestEvmChain({ userId: session.user.id, prefer: 'withdraw' })
      ).chain;
      const prep = await prepareEvmWithdrawGas({
        chain,
        userId: session.user.id,
      });
      return jsonSafe(prep);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/funds/evm/overview', async (request, reply) => {
    const session = await requireSession(request, reply, 'evm');
    if (!session) return;
    try {
      const rows = await listEvmChainFunds(session.user.id);
      const forTrading = await pickBestEvmChain({
        userId: session.user.id,
        prefer: 'trading',
      });
      const forSavings = await pickBestEvmChain({
        userId: session.user.id,
        prefer: 'savings',
      });
      const forWithdraw = await pickBestEvmChain({
        userId: session.user.id,
        prefer: 'withdraw',
        fromBucket: 'trading',
      });
      return jsonSafe({
        chains: rows,
        bestTradingChain: forTrading.chain,
        bestSavingsChain: forSavings.chain,
        bestWithdrawChain: forWithdraw.chain,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/funds/withdraw', async (request, reply) => {
    const body = z
      .object({
        mode: z.enum(['sol', 'evm']),
        amount: z.number().positive(),
        fromBucket: z.enum(['savings', 'trading']).default('trading'),
        chain: chainSchema.optional(),
      })
      .parse(request.body);
    const session = await requireSession(request, reply, body.mode);
    if (!session) return;

    let chain = modeChain(body.mode, body.chain);
    if (body.mode === 'evm') {
      // Scan all EVM chains: prefer the network that holds the bucket AND already has gas.
      const picked = await pickBestEvmChain({
        userId: session.user.id,
        prefer: 'withdraw',
        fromBucket: body.fromBucket,
      });
      if (!body.chain || body.chain === Chain.SOLANA) {
        chain = picked.chain;
      } else {
        // Respect client chain when it actually holds the bucket; otherwise correct it.
        try {
          const funds = await getTradingAvailableQuote(body.chain, session.user.id);
          const amt =
            body.fromBucket === 'savings' ? funds.savingsQuote : funds.withdrawableQuote;
          chain = amt > 0 ? body.chain : picked.chain;
        } catch {
          chain = picked.chain;
        }
      }
    }
    if (body.mode === 'sol' && session.user.chain !== Chain.SOLANA) {
      return reply.code(400).send({ error: 'Sign in with a Solana wallet to withdraw SOL.' });
    }
    if (body.mode === 'evm' && session.user.chain === Chain.SOLANA) {
      return reply.code(400).send({ error: 'Sign in with an EVM wallet to withdraw on EVM.' });
    }

    try {
      const result = await withdrawToWallet({
        chain,
        toAddress: session.user.address,
        amountQuote: body.amount,
        fromBucket: body.fromBucket,
        userId: session.user.id,
      });
      return jsonSafe({ ok: true, ...result, chain });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('CUSTODY_NEEDS_GAS:')) {
        const [, wei, symbol, custody, chainId] = message.split(':');
        // Include sibling-chain gas snapshot so the UI can switch to a gas-ready network.
        let altChains: Awaited<ReturnType<typeof listEvmChainFunds>> = [];
        try {
          altChains = await listEvmChainFunds(session.user.id);
        } catch {
          /* ignore */
        }
        const gasReady = altChains.filter(
          (r) =>
            !r.needsTopUp &&
            (body.fromBucket === 'savings' ? r.savingsQuote : r.withdrawableQuote) > 0,
        );
        return reply.code(400).send({
          error: gasReady.length
            ? `Custody on ${chain} needs ${symbol} for gas. ${gasReady.map((g) => g.chain).join(', ')} already has gas. Switch network or top up.`
            : `Custody needs a tiny ${symbol} for network gas (USDC never pays gas). Your wallet will send a small top-up.`,
          code: 'CUSTODY_NEEDS_GAS',
          recommendedTopUpWei: wei,
          nativeSymbol: symbol,
          custodyAddress: custody,
          chainId: Number(chainId),
          chain,
          chains: altChains,
          gasReadyChains: gasReady.map((g) => g.chain),
        });
      }
      return reply.code(400).send({ error: message });
    }
  });
}
