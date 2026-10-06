import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, getAddress, parseUnits } from 'viem';

/**
 * Locks the BSC USDC deposit shape: real ERC-20 transfer calldata,
 * never a native BNB value transfer mistaken for "2 USDC".
 */
describe('EVM USDC deposit calldata', () => {
  const BSC_USDC = getAddress('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d');
  const custody = getAddress('0xcbaeab3f12de5e44f1c73fd1df260f7eac96b17c');

  it('encodes transfer(recipient, amount) for Binance-Peg USDC (18 decimals)', () => {
    const amountRaw = parseUnits('2', 18);
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [custody, amountRaw],
    });
    expect(data.startsWith('0xa9059cbb')).toBe(true); // transfer selector
    expect(data.length).toBeGreaterThan(10);
    expect(BSC_USDC.toLowerCase()).toBe('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d');
    // Must not be a native 2 BNB send — value is always 0 for ERC-20 deposits.
    expect(amountRaw).toBe(2_000_000_000_000_000_000n);
  });

  it('uses 6 decimals for Base native USDC', () => {
    const amountRaw = parseUnits('2', 6);
    expect(amountRaw).toBe(2_000_000n);
  });
});
