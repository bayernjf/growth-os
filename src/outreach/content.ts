// growth-os G3 draft writer port. The local TemplateDraftWriter personalizes
// deterministic text from the lead signal; a loom ContentClient adapter is a
// future (optional) implementation behind the same port (design §13.2).

import type { Contact, Lead } from '../crm/types.js';

export interface DraftContext {
  lead: Lead;
  contact?: Contact;
}

export interface DraftWriter {
  readonly name: string;
  readonly online: boolean;
  write(ctx: DraftContext): Promise<{ subject: string; text: string }>;
}

export class TemplateDraftWriter implements DraftWriter {
  readonly name = 'template';
  readonly online = false;

  async write(ctx: DraftContext): Promise<{ subject: string; text: string }> {
    const name = ctx.contact?.name ?? 'there';
    const subject = `Quick question about ${ctx.lead.title}`;
    const summary = ctx.lead.summary
      ? `I noticed: ${ctx.lead.summary}`
      : `I came across ${ctx.lead.title}.`;
    const text = ['', `Hi ${name},`, '', summary, '', 'Would you be open to a short chat this week?', '', 'Best', ''].join(
      '\n',
    );
    return { subject, text };
  }
}
