// growth-os G3 mail port. Transport-only: implementations deliver an outbound
// email and never make a sending decision (that is zeus's job, design §13).

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Associated lead id, recorded in the audit trail (not sent as content). */
  leadId?: string;
  inReplyTo?: string;
}

export interface MailPort {
  readonly name: string;
  readonly online: boolean;
  send(message: OutboundEmail): Promise<{ messageId: string }>;
}
