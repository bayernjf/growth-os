import { describe, expect, it } from 'vitest';
import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { loadConfig } from '../src/config.js';
import { createMailPort } from '../src/mail/registry.js';
import { SmtpMailAdapter } from '../src/mail/smtp.js';

describe('createMailPort fail-closed', () => {
  it('off mode rejects send with MAIL_UNAVAILABLE', async () => {
    const p = createMailPort({ ...loadConfig(), mailMode: 'off' as const });
    expect(p.online).toBe(false);
    await expect(
      p.send({ to: 'x@y.com', subject: 'hi', text: 'hello' }),
    ).rejects.toMatchObject({ code: 'MAIL_UNAVAILABLE', status: 503 });
  });

  it('smtp without host/from rejects with CREDENTIAL_MISSING 422', async () => {
    const p = createMailPort({
      ...loadConfig(),
      mailMode: 'smtp' as const,
      mailHost: undefined,
      mailFrom: undefined,
    });
    expect(p.online).toBe(true);
    await expect(
      p.send({ to: 'x@y.com', subject: 'hi', text: 'hello' }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING', status: 422 });
  });

  it('smtp with host/from returns a live adapter', () => {
    const p = createMailPort({
      ...loadConfig(),
      mailMode: 'smtp' as const,
      mailHost: 'smtp.example.com',
      mailFrom: 'me@example.com',
    });
    expect(p.online).toBe(true);
    expect(p.name).toBe('smtp');
  });
});

describe('SmtpMailAdapter', () => {
  it('delivers via the injected transporter and returns a message id', async () => {
    const transporter = createTransport({ jsonTransport: true });
    const adapter = new SmtpMailAdapter(
      { host: 'smtp.example.com', port: 587, from: 'me@example.com' },
      transporter,
    );
    const res = await adapter.send({
      to: 'x@y.com',
      subject: 'hi',
      text: 'hello',
      leadId: 'l1',
    });
    expect(typeof res.messageId).toBe('string');
    expect(res.messageId.length).toBeGreaterThan(0);
  });

  it('maps send failure to MAIL_UNAVAILABLE 503', async () => {
    const failing = {
      sendMail: async () => {
        throw new Error('SMTP auth failed');
      },
    } as unknown as Transporter;
    const adapter = new SmtpMailAdapter(
      { host: 'smtp.example.com', port: 587, from: 'me@example.com' },
      failing,
    );
    await expect(
      adapter.send({ to: 'x@y.com', subject: 'hi', text: 'hello' }),
    ).rejects.toMatchObject({ code: 'MAIL_UNAVAILABLE', status: 503, retryable: true });
  });
});
