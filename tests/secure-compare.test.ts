import { describe, expect, it } from 'vitest';
import { secureEqual } from '../src/util/hash.js';

describe('secureEqual (constant-time string comparison)', () => {
  it('matches identical strings', () => {
    expect(secureEqual('Bearer tok-123', 'Bearer tok-123')).toBe(true);
    expect(secureEqual('', '')).toBe(true);
  });

  it('rejects different strings of the same length', () => {
    expect(secureEqual('Bearer tok-123', 'Bearer tok-124')).toBe(false);
  });

  it('rejects strings of different lengths without throwing', () => {
    // timingSafeEqual alone throws on length mismatch; hashing to fixed-size
    // digests first must keep this a plain false.
    expect(secureEqual('Bearer tok-123', 'Bearer tok-123-extra')).toBe(false);
    expect(secureEqual('short', '')).toBe(false);
  });

  it('rejects an empty string against a non-empty one', () => {
    expect(secureEqual('', 'Bearer tok-123')).toBe(false);
  });
});
