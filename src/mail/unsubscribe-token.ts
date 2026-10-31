// growth-os T-G3-07 one-click unsubscribe tokens. The token binds the email
// address with an HMAC so the public unsubscribe endpoint cannot be used to
// suppress arbitrary addresses. Verification is constant-time.

import { createHmac, timingSafeEqual } from 'node:crypto';

function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function fromBase64Url(encoded: string): string | undefined {
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

export function signUnsubscribeToken(email: string, secret: string): string {
  const payload = toBase64Url(email);
  const mac = createHmac('sha256', secret).update(email, 'utf8').digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyUnsubscribeToken(token: string, secret: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 2) return undefined;
  const payload = parts[0] ?? '';
  const mac = parts[1] ?? '';
  const email = fromBase64Url(payload);
  if (email === undefined) return undefined;

  const expected = createHmac('sha256', secret).update(email, 'utf8').digest('base64url');
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (macBuf.length !== expectedBuf.length) return undefined;
  if (!timingSafeEqual(macBuf, expectedBuf)) return undefined;
  return email;
}
