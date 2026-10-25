import { describe, expect, it } from 'vitest';
import { loadConfig, type ScoringConfig } from '../src/config.js';
import { scoreSignal, type ScoredInput } from '../src/research/scoring.js';

const cfg: ScoringConfig = loadConfig().scoring;

const KEYWORDS = ['ai crm', 'cold email', 'outreach', 'lead generation'];

function makeInput(overrides: Partial<ScoredInput> = {}): ScoredInput {
  return {
    signalType: 'need',
    sourceType: 'official',
    title: 'AI CRM for personal agents',
    content: 'We need a cold email outreach tool for lead generation',
    publishedAt: undefined,
    ...overrides,
  };
}

// A timestamp in the future resolves to age 0 -> freshness exactly 1, keeping
// the ceiling/no-date cases deterministic regardless of the wall clock.
const freshDate = (): string => new Date(Date.now() + 60_000).toISOString();

describe('scoreSignal (deterministic, explainable)', () => {
  it('caps at 100 and a max-weighted input reaches the expected ceiling', () => {
    const { score, breakdown } = scoreSignal(
      makeInput({ signalType: 'intent', sourceType: 'official', publishedAt: freshDate() }),
      KEYWORDS,
      cfg,
    );
    // type 1.0*0.45 + source 0.9*0.2 + fresh 1.0*0.15 + keyword 1.0*0.2 = 0.98
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBe(98);
    expect(breakdown.total).toBeCloseTo(0.98, 3);
  });

  it('zero keyword hits drive the keyword part to zero and lower the total', () => {
    const hit = scoreSignal(
      makeInput({ sourceType: 'official', publishedAt: freshDate() }),
      KEYWORDS,
      cfg,
    );
    const noHit = scoreSignal(
      makeInput({ sourceType: 'official', publishedAt: freshDate() }),
      ['unrelated topic'],
      cfg,
    );
    expect(noHit.breakdown.keyword).toBe(0);
    expect(hit.breakdown.keyword).toBeCloseTo(0.2, 3); // all keywords hit -> 1.0 * 0.2
    expect(noHit.score).toBeLessThan(hit.score);
  });

  it('missing date uses neutral freshness (0.5)', () => {
    const { breakdown } = scoreSignal(makeInput({ publishedAt: undefined }), KEYWORDS, cfg);
    expect(breakdown.fresh).toBeCloseTo(0.15 * 0.5, 3);
  });

  it('older content decays freshness and total score', () => {
    const recent = scoreSignal(makeInput({ publishedAt: freshDate() }), KEYWORDS, cfg);
    const old = scoreSignal(
      makeInput({
        publishedAt: new Date(Date.now() - 2 * cfg.halfLifeDays * 86_400_000).toISOString(),
      }),
      KEYWORDS,
      cfg,
    );
    expect(old.breakdown.fresh).toBeLessThan(recent.breakdown.fresh);
    expect(old.score).toBeLessThan(recent.score);
    // two half-lives -> freshness ~0.25 -> weighted fresh part ~0.0375
    // (relaxed precision: round3() half-rounds at the .0375 boundary)
    expect(old.breakdown.fresh).toBeCloseTo(0.15 * 0.25, 2);
  });

  it('stays within 0..100 and breakdown parts reconcile with total', () => {
    const cases = [
      makeInput({ signalType: 'trend', sourceType: 'social', publishedAt: undefined }),
      makeInput({ signalType: 'intent', sourceType: 'official', publishedAt: freshDate() }),
      makeInput({
        signalType: 'comparison',
        sourceType: 'web',
        publishedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      }),
    ];
    for (const c of cases) {
      const { score, breakdown } = scoreSignal(c, KEYWORDS, cfg);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      const parts = breakdown.type + breakdown.source + breakdown.fresh + breakdown.keyword;
      expect(parts).toBeCloseTo(breakdown.total, 3);
    }
  });
});
