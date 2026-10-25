import type { ScoringConfig } from '../config.js';
import type { RawMention, ScoreBreakdown } from './types.js';

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

function freshness(publishedAt: string | undefined, halfLifeDays: number): number {
  if (!publishedAt) return 0.5; // neutral when unknown
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return 0.5;
  const ageDays = Math.max(0, (Date.now() - t) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function keywordRatio(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const hay = text.toLowerCase();
  const hits = keywords.filter((k) => k.trim().length > 0 && hay.includes(k.toLowerCase())).length;
  return clamp01(hits / keywords.length);
}

export interface ScoredInput {
  signalType: RawMention['signalType'];
  sourceType: RawMention['sourceType'];
  title: string;
  content: string;
  publishedAt?: string | undefined;
}

/**
 * Deterministic, explainable score (0–100). No model, no network.
 * Breakdown carries each weighted contribution so the score is auditable.
 */
export function scoreSignal(
  input: ScoredInput,
  keywords: string[],
  cfg: ScoringConfig,
): { score: number; breakdown: ScoreBreakdown } {
  const typeScore = cfg.typeScore[input.signalType] ?? 0.4;
  const credibility = cfg.credibility[input.sourceType] ?? 0.5;
  const fresh = freshness(input.publishedAt, cfg.halfLifeDays);
  const kw = keywordRatio(`${input.title} ${input.content}`, keywords);

  const w = cfg.weights;
  const typePart = w.type * typeScore;
  const sourcePart = w.source * credibility;
  const freshPart = w.fresh * fresh;
  const keywordPart = w.keyword * kw;
  const total = clamp01(typePart + sourcePart + freshPart + keywordPart);

  return {
    score: Math.round(total * 100),
    breakdown: {
      type: round3(typePart),
      source: round3(sourcePart),
      fresh: round3(freshPart),
      keyword: round3(keywordPart),
      total: round3(total),
    },
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
