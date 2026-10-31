// growth-os T-G3-07 multilingual email templates. Pure rendering: given a
// locale and compliance inputs it produces subject/text/html. The compliance
// footer carries the sender identity and one-click unsubscribe link required
// by design §14.2 (CAN-SPAM/CASL/GDPR ePrivacy spirit).

export type EmailLocale = 'en' | 'zh';

export const EMAIL_LOCALES: readonly EmailLocale[] = ['en', 'zh'];

export function isEmailLocale(value: unknown): value is EmailLocale {
  return typeof value === 'string' && (EMAIL_LOCALES as readonly string[]).includes(value);
}

export interface EmailCompliance {
  /** Sender identity statement / physical address (§14.2.1). */
  identity: string;
  /** Fully formed one-click unsubscribe URL. */
  unsubscribeUrl: string;
}

export interface EmailTemplateInput {
  locale: EmailLocale;
  recipientName: string;
  leadTitle: string;
  leadSummary: string;
  compliance?: EmailCompliance;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

interface LocalizedCopy {
  subject: string;
  greeting: string;
  cta: string;
  signoff: string;
  unsubscribeLabel: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderEmailTemplate(input: EmailTemplateInput): RenderedEmail {
  const name = input.recipientName.trim() || (input.locale === 'zh' ? '您好' : 'there');
  const hasSummary = input.leadSummary.trim().length > 0;

  let copy: LocalizedCopy;
  let summaryLine: string;
  if (input.locale === 'zh') {
    copy = {
      subject: `关于${input.leadTitle}的简短沟通`,
      greeting: `${name}，你好：`,
      cta: '不知本周是否方便简单沟通一下？',
      signoff: '此致',
      unsubscribeLabel: '退订',
    };
    summaryLine = hasSummary ? `注意到：${input.leadSummary}` : `我关注到${input.leadTitle}。`;
  } else {
    copy = {
      subject: `Quick question about ${input.leadTitle}`,
      greeting: `Hi ${name},`,
      cta: 'Would you be open to a short chat this week?',
      signoff: 'Best',
      unsubscribeLabel: 'Unsubscribe',
    };
    summaryLine = hasSummary ? `I noticed: ${input.leadSummary}` : `I came across ${input.leadTitle}.`;
  }

  const textLines: string[] = ['', copy.greeting, '', summaryLine, '', copy.cta, '', copy.signoff];
  if (input.compliance) {
    textLines.push('---');
    if (input.compliance.identity.trim()) textLines.push(input.compliance.identity.trim());
    textLines.push(`${copy.unsubscribeLabel}: ${input.compliance.unsubscribeUrl}`);
  }
  const text = textLines.join('\n');

  const htmlParts: string[] = [
    `<p>${escapeHtml(copy.greeting)}</p>`,
    `<p>${escapeHtml(summaryLine)}</p>`,
    `<p>${escapeHtml(copy.cta)}</p>`,
    `<p>${escapeHtml(copy.signoff)}</p>`,
  ];
  if (input.compliance) {
    const footerBits: string[] = [];
    if (input.compliance.identity.trim()) footerBits.push(escapeHtml(input.compliance.identity.trim()));
    footerBits.push(
      `<a href="${escapeHtml(input.compliance.unsubscribeUrl)}">${escapeHtml(copy.unsubscribeLabel)}</a>`,
    );
    htmlParts.push(`<hr><footer>${footerBits.join('<br>')}</footer>`);
  }
  const html = htmlParts.join('');

  return { subject: copy.subject, text, html };
}
