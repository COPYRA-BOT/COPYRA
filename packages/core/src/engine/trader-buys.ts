import { Chain, prisma, TxClassification } from '@copyra/db';

/**
 * True when this watched trader already has an earlier BUY of `tokenAddress`
 * recorded (excluding the current source tx). Used for First-buy-only mode:
 * only the trader wallet's first buy of a token is copied; later buys skip.
 */
export async function traderHasPriorBuyOfToken(input: {
  traderId: string;
  chain: Chain;
  tokenAddress: string;
  excludeTxHash: string;
}): Promise<boolean> {
  const prior = await prisma.detectedTransaction.findFirst({
    where: {
      traderId: input.traderId,
      chain: input.chain,
      classification: TxClassification.BUY,
      tokenOutAddress: input.tokenAddress,
      NOT: { txHash: input.excludeTxHash },
    },
    select: { id: true },
  });
  return prior !== null;
}
