import { describe, expect, it } from 'vitest';
import {
  OfflineReplyTranslator,
  classifyReplyIntent,
  detectLocale,
} from '../src/mail/reply-translator.js';

describe('detectLocale (T-G3-07)', () => {
  it('detects zh from CJK text', () => {
    expect(detectLocale('你好，有兴趣')).toBe('zh');
  });

  it('detects en from latin text', () => {
    expect(detectLocale('Interested, call me.')).toBe('en');
  });

  it('returns unknown when neither writing system appears', () => {
    expect(detectLocale('12345 ツ')).toBe('unknown');
  });
});

describe('classifyReplyIntent (T-G3-07)', () => {
  it('classifies unsubscribe with precedence', () => {
    expect(classifyReplyIntent('Please unsubscribe me')).toBe('unsubscribe');
    expect(classifyReplyIntent('退订')).toBe('unsubscribe');
    expect(classifyReplyIntent('取消订阅')).toBe('unsubscribe');
  });

  it('classifies auto replies before other intents', () => {
    expect(classifyReplyIntent('Out of office until Monday')).toBe('auto');
    expect(classifyReplyIntent('自动回复')).toBe('auto');
  });

  it('classifies questions', () => {
    expect(classifyReplyIntent('What is the price?')).toBe('question');
    expect(classifyReplyIntent('价格多少？')).toBe('question');
  });

  it('classifies interest signals', () => {
    expect(classifyReplyIntent('Sounds good, call me')).toBe('interest');
    expect(classifyReplyIntent('有兴趣，方便聊聊')).toBe('interest');
  });

  it('falls back to other', () => {
    expect(classifyReplyIntent('thanks')).toBe('other');
  });
});

describe('OfflineReplyTranslator (T-G3-07)', () => {
  it('never fabricates a translation offline: keeps the original and classifies', async () => {
    const t = new OfflineReplyTranslator();
    expect(t.name).toBe('offline');
    const out = await t.translate('有兴趣，想了解一下', 'en');
    expect(out.translatedText).toBe('有兴趣，想了解一下');
    expect(out.originalText).toBe('有兴趣，想了解一下');
    expect(out.detectedLocale).toBe('zh');
    expect(out.intent).toBe('interest');
  });

  it('works for english replies', async () => {
    const t = new OfflineReplyTranslator();
    const out = await t.translate('Interested, call me.', 'en');
    expect(out.detectedLocale).toBe('en');
    expect(out.intent).toBe('interest');
  });
});
