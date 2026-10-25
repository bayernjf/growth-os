import type { ScoringConfig } from '../config.js';
import { Errors } from './errors.js';
import { collectSignals } from './collector.js';
import { clusterInsights } from './insights.js';
import { generateReport } from './report.js';
import type { SearchProvider } from './provider/types.js';
import { ResearchRepository } from './repository.js';
import {
  SIGNAL_TYPES,
  type Insight,
  type InsightStatus,
  type ResearchReport,
  type ResearchTopic,
  type ResearchTopicInput,
  type RunResult,
  type Signal,
} from './types.js';

export interface ResearchServiceDeps {
  repo: ResearchRepository;
  provider: SearchProvider;
  scoring: ScoringConfig;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

export class ResearchService {
  private readonly repo: ResearchRepository;
  private readonly provider: SearchProvider;
  private readonly scoring: ScoringConfig;
  private readonly now: () => string;

  constructor(deps: ResearchServiceDeps) {
    this.repo = deps.repo;
    this.provider = deps.provider;
    this.scoring = deps.scoring;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async createTopic(input: ResearchTopicInput): Promise<ResearchTopic> {
    if (!input.title || input.title.trim().length === 0) {
      throw Errors.validation('title is required');
    }
    if (!Array.isArray(input.keywords) || input.keywords.length === 0) {
      throw Errors.validation('at least one keyword is required');
    }
    if (input.signalTypes) {
      const bad = input.signalTypes.filter((t) => !SIGNAL_TYPES.includes(t));
      if (bad.length > 0) throw Errors.validation('unknown signal types', { bad });
    }
    return this.repo.createTopic(input, this.now());
  }

  listTopics(): Promise<ResearchTopic[]> {
    return this.repo.listTopics();
  }

  async getTopic(id: string): Promise<ResearchTopic> {
    const topic = await this.repo.getTopic(id);
    if (!topic) throw Errors.notFound(`topic ${id}`);
    return topic;
  }

  listSignals(topicId: string): Promise<Signal[]> {
    return this.repo.listSignals(topicId);
  }

  async getReport(id: string): Promise<ResearchReport> {
    const report = await this.repo.getReport(id);
    if (!report) throw Errors.notFound(`report ${id}`);
    return report;
  }

  /**
   * Run one research pass: fetch (read-only) → collect/dedupe → score →
   * cluster insights → persist a versioned report. Signals accumulate
   * across runs (fingerprint dedup); confirmed/pending insights are not
   * re-created, rejected ones may resurface.
   */
  async run(topicId: string): Promise<RunResult> {
    const topic = await this.getTopic(topicId);
    await this.repo.setTopicStatus(topic.id, 'running', this.now());

    const mentions = await this.provider.search({
      keywords: topic.keywords,
      signalTypes: topic.signalTypes,
      language: topic.language,
    });
    const fresh = collectSignals({
      topicId: topic.id,
      provider: this.provider.name,
      keywords: topic.keywords,
      mentions,
      cfg: this.scoring,
      now: this.now(),
    });
    await this.repo.insertSignals(fresh);

    // Reports and insights are computed over the topic's full, deduped set.
    const signals = await this.repo.listSignals(topic.id);

    const existing = await this.repo.listInsights(topic.id);
    const occupied = new Set(
      existing.filter((i) => i.status !== 'rejected').map((i) => i.title),
    );
    const candidates = clusterInsights({
      topicId: topic.id,
      signals,
      keywords: topic.keywords,
      minScore: this.scoring.insightMinScore,
      now: this.now(),
    }).filter((c) => !occupied.has(c.title));
    await this.repo.insertInsights(candidates);
    const insights = await this.repo.listInsights(topic.id);

    const version = await this.repo.nextReportVersion(topic.id);
    const report = generateReport({
      topic,
      signals,
      insights,
      mode: this.provider.name,
      version,
      topN: this.scoring.reportTopN,
      minScore: this.scoring.insightMinScore,
      now: this.now(),
    });
    await this.repo.insertReport(report);

    await this.repo.setTopicStatus(topic.id, 'done', this.now());
    const finalTopic = await this.getTopic(topic.id);
    return { topic: finalTopic, signals, insights, report };
  }

  /** Human review gate for an insight candidate. */
  async reviewInsight(id: string, action: 'confirm' | 'reject'): Promise<Insight> {
    const insight = await this.repo.getInsight(id);
    if (!insight) throw Errors.notFound(`insight ${id}`);
    if (insight.status !== 'pending_review') {
      throw Errors.conflict(`insight ${id} is already ${insight.status}`);
    }
    const status: InsightStatus = action === 'confirm' ? 'confirmed' : 'rejected';
    const changes = await this.repo.reviewInsight(id, status, this.now());
    if (changes === 0) throw Errors.notFound(`insight ${id}`);
    return { ...insight, status, reviewedAt: this.now() };
  }
}
