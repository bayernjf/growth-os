// SmtpMailAdapter: standard SMTP delivery via nodemailer (STARTTLS on 587,
// implicit TLS on 465). Credentials come from config/env only, never stored.
// A transporter is injectable so tests can use nodemailer's json transport.

import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { Errors } from '../research/errors.js';
import type { MailPort, OutboundEmail } from './types.js';

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
}

export class SmtpMailAdapter implements MailPort {
  readonly name = 'smtp';
  readonly online = true;
  private readonly from: string;
  private readonly transporter: Transporter;

  constructor(config: SmtpConfig, transporter?: Transporter) {
    this.from = config.from;
    this.transporter =
      transporter ??
      createTransport({
        host: config.host,
        port: config.port,
        secure: config.port === 465,
        ...(config.user !== undefined
          ? { auth: { user: config.user, pass: config.pass ?? '' } }
          : {}),
      });
  }

  async send(message: OutboundEmail): Promise<{ messageId: string }> {
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html !== undefined ? { html: message.html } : {}),
        ...(message.inReplyTo !== undefined ? { inReplyTo: message.inReplyTo } : {}),
      });
      return { messageId: info.messageId };
    } catch (err) {
      throw Errors.mailUnavailable(
        `SMTP send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
