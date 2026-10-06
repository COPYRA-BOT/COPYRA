import {
  buildEvmDepositIntent,
  buildSolanaDepositTransaction,
  broadcastSolanaDeposit,
  getTradingAvailableQuote,
  moveBucket,
  multiUserCustodyEnabled,
  recordEvmCustodyDeposit,
  withdrawToWallet,
} from '@copyra/core';
import { Chain } from '@copyra/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readSession } from './auth.js';
import { jsonSafe } from './serialize.js';

const chainSchema = z.nativeEnum(Chain);

async function requireSession(request: FastifyRequest, reply: FastifyReply) {
  const session = await readSession(request);
  if (!session) {
    reply.code(401).send({
      error: 'Connect a wallet and sign in first. COPYRA never asks for your private key.',
    });
    return null;
  }
  return session;
}

function modeChain(mode: 'sol' | 'evm', preferred?: Chain): Chain {
  if (mode === 'sol') return Chain.SOLANA;
  if (preferred && preferred !== Chain.SOLANA) return preferred;
  return Chain.BASE;
}

export async function registerFundsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/funds', async (request, reply) => {
    const query = z
      .object({
        chain: chainSchema.optional(),
        mode: z.enum(['sol', 'evm']).optional(),
      })
      .parse(request.query);
    const chain = query.chain ?? (query.mode === 'evm' ? Chain.BASE : Chain.SOLANA);
    const session = await readSession(request);
    const userId = session?.user.id;
    if (multiUserCustodyEnabled() && !userId) {
      return reply.code(401).send({
        error: 'Sign in with your wallet to view your custody balances.',
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
            : 'No bot signing key — deposit destination and withdraw are unavailable until the host secret store has the Solana/EVM bot signing material.',
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
    const session = await requireSession(request, reply);
    if (!session) return;
    const body = z
      .object({
        mode: z.enum(['sol', 'evm']),
        direction: z.enum(['t2s', 's2t']),
        amount: z.number().positive(),
        chain: chainSchema.optional(),
      })
      .parse(request.body);
    const chain = modeChain(body.mode, body.chain);
    try {
      const result = await moveBucket({
        chain,
        direction: body.direction,
        amountQuote: body.amount,
        userId: session.user.id,
      });
      return jsonSafe({ ok: true, ...result });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/funds/deposit/build', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const body = z
      .object({
        mode: z.enum(['sol', 'evm']),
        amount: z.number().positive(),
        chain: chainSchema.optional(),
      })
      .parse(request.body);

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
        kind: 'evm',
        ...intent,
        fromAddress: session.user.address,
        note: 'Send this transaction from your connected EVM wallet. Funds move on-chain to your COPYRA custody wallet.',
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/funds/deposit/broadcast', async (request, reply) => {
    const session = await requireSession(request, reply);
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
    const session = await requireSession(request, reply);
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

  app.post('/api/funds/withdraw', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const body = z
      .object({
        mode: z.enum(['sol', 'evm']),
        amount: z.number().positive(),
        fromBucket: z.enum(['savings', 'trading']).default('savings'),
        chain: chainSchema.optional(),
      })
      .parse(request.body);

    const chain = modeChain(body.mode, body.chain);
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
      return jsonSafe({ ok: true, ...result });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
