import type { Insight, InsightCategory, Signal } from './types.js';
import { newId } from '../util/hash.js';

const CATEGORY_LABEL: Record<InsightCategory, string> = {
  need: '需求',
  pain: '痛点',
  comparison: '对比选型',
};

const CATEGORY_TYPES: InsightCategory[] = ['need', 'pain', 'comparison'];

function hitKeyword(signal: Signal, keywords: string[]): string | undefined {
  const hay = `${signal.title} ${signal.content}`.toLowerCase();
  return keywords
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .find((k) => hay.includes(k.toLowerCase()));
}

export interface ClusterInput {
  topicId: string;
  signals: Signal[];
  keywords: string[];
  minScore: number;
  now?: string;
}

/**
 * Deterministic clustering of high-score need/pain/comparison signals into
 * review-pending insights. Group key = (category, first matched topic
 * keyword). Signals without a keyword hit are not clustered (noise guard).
 * No model is used in G1; LLM clustering is a later explicit opt-in.
 */
export function clusterInsights(input: ClusterInput): Insight[] {
  const now = input.now ?? new Date().toISOString();
  const groups = new Map<string, { category: InsightCategory; keyword: string; signals: Signal[] }>();

  for (const s of input.signals) {
    if (!CATEGORY_TYPES.includes(s.signalType as InsightCategory)) continue;
    if (s.score < input.minScore) continue;
    const kw = hitKeyword(s, input.keywords);
    if (!kw) continue;
    const category = s.signalType as InsightCategory;
    const key = `${category}::${kw.toLowerCase()}`;
    const group = groups.get(key) ?? { category, keyword: kw, signals: [] };
    group.signals.push(s);
    groups.set(key, group);
  }

  return [...groups.values()].map((g) => {
    const ordered = [...g.signals].sort((a, b) => b.score - a.score);
    const points = ordered
      .slice(0, 3)
      .map((s, i) => `${i + 1}) ${s.title}`)
      .join('；');
    return {
      id: newId('ins'),
      topicId: input.topicId,
      category: g.category,
      title: `${CATEGORY_LABEL[g.category]}：${g.keyword}`,
      summary: `命中 ${ordered.length} 条相关信号（关键词「${g.keyword}」）。${points}`,
      signalIds: ordered.map((s) => s.id),
      status: 'pending_review' as const,
      createdAt: now,
    };
  });
}
