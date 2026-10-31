// growth-os T-G3-07 reply understanding and translation. The offline
// translator performs deterministic language detection and intent
// classification without any network call; machine translation is a future
// ReplyTranslator implementation backed by model-hub, so the offline path
// never fabricates a translation and keeps the original text.

import type { EmailLocale } from './templates.js';

export type ReplyIntent = 'interest' | 'question' | 'unsubscribe' | 'auto' | 'other';
export type DetectedLocale = EmailLocale | 'unknown';

export interface TranslatedReply {
  originalText: string;
  translatedText: string;
  detectedLocale: DetectedLocale;
  intent: ReplyIntent;
}

export interface ReplyTranslator {
  readonly name: string;
  translate(text: string, targetLocale: EmailLocale): Promise<TranslatedReply>;
}

/** Detect the writing system: CJK range -> zh, Latin letters -> en, else unknown. */
export function detectLocale(text: string): DetectedLocale {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/[a-zA-Z]/.test(text)) return 'en';
  return 'unknown';
}

/** Classify reply intent from keyword signals (unsubscribe/auto take precedence). */
export function classifyReplyIntent(text: string): ReplyIntent {
  const lower = text.toLowerCase();
  if (
    /unsubscribe|opt[ -]?out|remove me|stop email/.test(lower) ||
    /退订|取消订阅|拒收/.test(text)
  ) {
    return 'unsubscribe';
  }
  if (/out of office|automatic reply|auto[- ]?reply/.test(lower) || /自动回复/.test(text)) {
    return 'auto';
  }
  if (/[?？]/.test(text) || /\b(when|how|what|why|question)\b/.test(lower)) {
    return 'question';
  }
  if (/\b(interested|yes|please|call me|sounds good)\b/.test(lower) || /有兴趣|可以|想|好的/.test(text)) {
    return 'interest';
  }
  return 'other';
}

export class OfflineReplyTranslator implements ReplyTranslator {
  readonly name = 'offline';

  async translate(text: string, _targetLocale: EmailLocale): Promise<TranslatedReply> {
    const detectedLocale = detectLocale(text);
    const intent = classifyReplyIntent(text);
    // No LLM offline: retain the original rather than inventing a translation.
    return {
      originalText: text,
      translatedText: text,
      detectedLocale,
      intent,
    };
  }
}
