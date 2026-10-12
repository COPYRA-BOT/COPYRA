import { describe, expect, it } from 'vitest';
import { httpRpcToWsUrl } from './env.js';

describe('httpRpcToWsUrl', () => {
  it('maps https Helius RPC to wss', () => {
    expect(httpRpcToWsUrl('https://mainnet.helius-rpc.com/?api-key=abc')).toBe(
      'wss://mainnet.helius-rpc.com/?api-key=abc',
    );
  });

  it('maps http to ws', () => {
    expect(httpRpcToWsUrl('http://127.0.0.1:8899')).toBe('ws://127.0.0.1:8899/');
  });

  it('passes through existing wss', () => {
    expect(httpRpcToWsUrl('wss://example.com/ws')).toBe('wss://example.com/ws');
  });

  it('returns undefined for empty/invalid', () => {
    expect(httpRpcToWsUrl(undefined)).toBeUndefined();
    expect(httpRpcToWsUrl('')).toBeUndefined();
    expect(httpRpcToWsUrl('not-a-url')).toBeUndefined();
  });
});
