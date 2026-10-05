import { keccak256, toBytes, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { computeEvmTokenDeltas } from './decoder.js';

const TRADER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'));

function padAddress(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}` as `0x${string}`;
}

function transferLog(from: string, to: string, value: bigint): Log {
  return {
    address: TOKEN,
    topics: [TRANSFER_TOPIC, padAddress(from), padAddress(to)],
    data: `0x${value.toString(16).padStart(64, '0')}`,
    blockHash: '0x00',
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: '0x00',
    transactionIndex: 0,
    removed: false,
  } as Log;
}

describe('computeEvmTokenDeltas', () => {
  it('nets inbound and outbound Transfer logs for the monitored wallet only', () => {
    const logs = [
      transferLog(OTHER, TRADER, 1_000n),
      transferLog(TRADER, OTHER, 200n),
      transferLog(OTHER, OTHER, 9_999n),
    ];
    const deltas = computeEvmTokenDeltas(logs, TRADER);
    expect(deltas.get(TOKEN)).toBe(800n);
  });

  it('drops a token whose net movement is zero', () => {
    const logs = [transferLog(OTHER, TRADER, 50n), transferLog(TRADER, OTHER, 50n)];
    const deltas = computeEvmTokenDeltas(logs, TRADER);
    expect(deltas.has(TOKEN)).toBe(false);
  });
});
