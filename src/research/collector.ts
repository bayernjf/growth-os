import type { ScoringConfig } from '../config.js';
import type { RawMention, Signal } from './types.js';
import { fingerprint, newId } from '../util/hash.js';
import { scoreSignal } from './scoring.js';

export interface CollectInput {
  topicId: string;
  provider: string;
  keywords: string[];
  mentions: RawMention[];
  cfg: ScoringConfig;
  now?: string;
}

/**
 * Normalize raw mentions into scored signals, de-duplicating by
 * url+title fingerprint within the batch. Persisted cross-run dedup is
 * enforced by the repository (unique topic/fingerprint).
 */
export function collectSignals(input: CollectInput): Signal[] {
  const seen = new Set<string>();
  const out: Signal[] = [];
  const now = input.now ?? new Date().toISOString();

  for (const m of input.mentions) {
    const fp = fingerprint(m.url);
    if (seen.has(fp)) continue;
    seen.add(fp);

    const { score, breakdown } = scoreSignal(
      {
        signalType: m.signalType,
        sourceType: m.sourceType,
        title: m.title,
        content: m.content,
        ...(m.publishedAt ? { publishedAt: m.publishedAt } : {}),
      },
      input.keywords,
      input.cfg,
    );

    out.push({
      id: newId('sig'),
      topicId: input.topicId,
      provider: input.provider,
      sourceType: m.sourceType,
      signalType: m.signalType,
      title: m.title,
      content: m.content,
      url: m.url,
      ...(m.author ? { author: m.author } : {}),
      ...(m.publishedAt ? { publishedAt: m.publishedAt } : {}),
      fingerprint: fp,
      score,
      scoreBreakdown: breakdown,
      createdAt: now,
    });
  }
  return out;
}
