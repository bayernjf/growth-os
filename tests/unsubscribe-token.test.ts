import { describe, expect, it } from 'vitest';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../src/mail/unsubscribe-token.js';

const SECRET = 'unsubscribe-secret';

describe('one-click unsubscribe tokens (T-G3-07)', () => {
  it('round-trips a token back to the bound email', () => {
    const token = signUnsubscribeToken('jane@acme.com', SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)).toBe('jane@acme.com');
  });

  it('rejects a token whose MAC was tampered with', () => {
    const token = signUnsubscribeToken('jane@acme.com', SECRET);
    const payload = token.split('.')[0] ?? '';
    expect(verifyUnsubscribeToken(`${payload}.deadbeef`, SECRET)).toBeUndefined();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signUnsubscribeToken('jane@acme.com', SECRET);
    expect(verifyUnsubscribeToken(token, 'other-secret')).toBeUndefined();
  });

  it('rejects malformed tokens', () => {
    expect(verifyUnsubscribeToken('no-dot', SECRET)).toBeUndefined();
    expect(verifyUnsubscribeToken('a.b.c', SECRET)).toBeUndefined();
    expect(verifyUnsubscribeToken('!!!.???', SECRET)).toBeUndefined();
  });

  it('binds tokens to the exact address', () => {
    const a = signUnsubscribeToken('a@b.com', SECRET);
    const b = signUnsubscribeToken('a@b.co', SECRET);
    expect(a).not.toBe(b);
  });
});
