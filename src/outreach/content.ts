// growth-os G3 draft writer port. The local TemplateDraftWriter renders a
// localized deterministic email from the lead/contact; a loom ContentClient
// adapter is a future (optional) implementation behind the same port
// (design §13.2). Compliance footers are built per recipient (§14.2).

import type { Contact, Lead } from '../crm/types.js';
import type { EmailCompliance, EmailLocale } from '../mail/templates.js';
import { renderEmailTemplate } from '../mail/templates.js';

export interface DraftContext {
  lead: Lead;
  contact?: Contact;
  locale?: EmailLocale;
}

export interface DraftWriter {
  readonly name: string;
  readonly online: boolean;
  write(ctx: DraftContext): Promise<{ subject: string; text: string; html?: string }>;
}

/** Builds the per-recipient compliance footer; undefined when compliance is off. */
export type ComplianceFactory = (email: string) => EmailCompliance | undefined;

export class TemplateDraftWriter implements DraftWriter {
  readonly name = 'template';
  readonly online = false;

  constructor(private readonly buildCompliance?: ComplianceFactory) {}

  async write(ctx: DraftContext): Promise<{ subject: string; text: string; html?: string }> {
    const email = ctx.contact?.email ?? '';
    const compliance = this.buildCompliance ? this.buildCompliance(email) : undefined;
    const rendered = renderEmailTemplate({
      locale: ctx.locale ?? 'en',
      recipientName: ctx.contact?.name ?? '',
      leadTitle: ctx.lead.title,
      leadSummary: ctx.lead.summary,
      ...(compliance ? { compliance } : {}),
    });
    return { subject: rendered.subject, text: rendered.text, html: rendered.html };
  }
}
