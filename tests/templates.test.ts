import { describe, expect, it } from 'vitest';
import { isEmailLocale, renderEmailTemplate } from '../src/mail/templates.js';

const COMPLIANCE = {
  identity: 'BayJF · owner@example.com · Guangzhou, CN',
  unsubscribeUrl: 'https://growth-os.test/pub/v1/outreach/unsubscribe?token=t1',
};

describe('renderEmailTemplate en (T-G3-07)', () => {
  it('renders English subject, greeting and CTA', () => {
    const out = renderEmailTemplate({
      locale: 'en',
      recipientName: 'Jane',
      leadTitle: 'AI sales agent',
      leadSummary: 'Looking for automation',
      compliance: COMPLIANCE,
    });
    expect(out.subject).toContain('AI sales agent');
    expect(out.text).toContain('Hi Jane');
    expect(out.text).toContain('short chat this week');
    expect(out.html).toContain('<p>Hi Jane,</p>');
  });

  it('includes the compliance footer with identity and unsubscribe link (§14.2.1)', () => {
    const out = renderEmailTemplate({
      locale: 'en',
      recipientName: 'Jane',
      leadTitle: 'T',
      leadSummary: '',
      compliance: COMPLIANCE,
    });
    expect(out.text).toContain('BayJF');
    expect(out.text).toContain('Unsubscribe:');
    expect(out.text).toContain(COMPLIANCE.unsubscribeUrl);
    expect(out.html).toContain('<a href="');
    expect(out.html).toContain(COMPLIANCE.unsubscribeUrl);
  });

  it('omits the footer when compliance is absent', () => {
    const out = renderEmailTemplate({ locale: 'en', recipientName: 'Jane', leadTitle: 'T', leadSummary: '' });
    expect(out.text).not.toContain('Unsubscribe');
    expect(out.text).not.toContain('---');
    expect(out.html).not.toContain('footer');
  });
});

describe('renderEmailTemplate zh (T-G3-07)', () => {
  it('renders Chinese copy and unsubscribe label', () => {
    const out = renderEmailTemplate({
      locale: 'zh',
      recipientName: '王先生',
      leadTitle: 'AI 销售代理',
      leadSummary: '',
      compliance: COMPLIANCE,
    });
    expect(out.subject).toContain('AI 销售代理');
    expect(out.text).toContain('王先生，你好');
    expect(out.text).toContain('退订');
    expect(out.text).toContain(COMPLIANCE.unsubscribeUrl);
    expect(out.html).toContain('退订');
  });
});

describe('html escaping', () => {
  it('escapes recipient and lead content in the html part', () => {
    const out = renderEmailTemplate({
      locale: 'en',
      recipientName: '<script>alert(1)</script>',
      leadTitle: 'a<b',
      leadSummary: '',
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });
});

describe('isEmailLocale', () => {
  it('accepts en/zh and rejects anything else', () => {
    expect(isEmailLocale('en')).toBe(true);
    expect(isEmailLocale('zh')).toBe(true);
    expect(isEmailLocale('fr')).toBe(false);
    expect(isEmailLocale('')).toBe(false);
    expect(isEmailLocale(undefined)).toBe(false);
  });
});
