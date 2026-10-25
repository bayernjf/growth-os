import type { StorageDriver } from '../storage/driver.js';
import { newId } from '../util/hash.js';
import type {
  Insight,
  InsightStatus,
  ResearchReport,
  ResearchTopic,
  ResearchTopicInput,
  ScoreBreakdown,
  Signal,
  SignalType,
  TopicStatus,
} from './types.js';

interface TopicRow {
  id: string;
  title: string;
  description: string;
  keywords: string;
  signal_types: string;
  language: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface SignalRow {
  id: string;
  topic_id: string;
  provider: string;
  source_type: string;
  signal_type: string;
  title: string;
  content: string;
  url: string;
  author: string | null;
  published_at: string | null;
  fingerprint: string;
  score: number;
  score_breakdown: string;
  created_at: string;
}

interface InsightRow {
  id: string;
  topic_id: string;
  category: string;
  title: string;
  summary: string;
  signal_ids: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
}

interface ReportRow {
  id: string;
  topic_id: string;
  version: number;
  mode: string;
  stats: string;
  top_signals: string;
  insight_ids: string;
  markdown: string;
  generated_at: string;
}

function parse<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export class ResearchRepository {
  constructor(private readonly driver: StorageDriver) {}

  // ---------- topics ----------

  async createTopic(input: ResearchTopicInput, now?: string): Promise<ResearchTopic> {
    const ts = now ?? new Date().toISOString();
    const topic: ResearchTopic = {
      id: newId('topic'),
      title: input.title,
      description: input.description ?? '',
      keywords: input.keywords,
      signalTypes: input.signalTypes ?? (['need', 'pain', 'trend'] as SignalType[]),
      language: input.language ?? 'zh',
      status: 'draft',
      createdAt: ts,
      updatedAt: ts,
    };
    await this.driver.run(
      `INSERT INTO research_topics
        (id,title,description,keywords,signal_types,language,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        topic.id,
        topic.title,
        topic.description,
        JSON.stringify(topic.keywords),
        JSON.stringify(topic.signalTypes),
        topic.language,
        topic.status,
        topic.createdAt,
        topic.updatedAt,
      ],
    );
    return topic;
  }

  async getTopic(id: string): Promise<ResearchTopic | undefined> {
    const row = await this.driver.get<TopicRow>(
      'SELECT * FROM research_topics WHERE id = ?',
      [id],
    );
    return row ? this.mapTopic(row) : undefined;
  }

  async listTopics(): Promise<ResearchTopic[]> {
    const rows = await this.driver.all<TopicRow>(
      'SELECT * FROM research_topics ORDER BY created_at DESC',
    );
    return rows.map((r) => this.mapTopic(r));
  }

  async setTopicStatus(id: string, status: TopicStatus, now?: string): Promise<void> {
    await this.driver.run('UPDATE research_topics SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      now ?? new Date().toISOString(),
      id,
    ]);
  }

  private mapTopic(row: TopicRow): ResearchTopic {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      keywords: parse<string[]>(row.keywords),
      signalTypes: parse<SignalType[]>(row.signal_types),
      language: row.language,
      status: row.status as TopicStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------- signals ----------

  async insertSignals(signals: Signal[]): Promise<void> {
    // Dialect-specific conflict handling for (topic_id, fingerprint) dedup.
    const ignore =
      this.driver.dialect === 'sqlite'
        ? 'INSERT OR IGNORE INTO signals'
        : 'INSERT INTO signals';
    const suffix =
      this.driver.dialect === 'postgres'
        ? ' ON CONFLICT (topic_id, fingerprint) DO NOTHING'
        : '';
    for (const s of signals) {
      await this.driver.run(
        `${ignore}
          (id,topic_id,provider,source_type,signal_type,title,content,url,author,
           published_at,fingerprint,score,score_breakdown,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)${suffix}`,
        [
          s.id,
          s.topicId,
          s.provider,
          s.sourceType,
          s.signalType,
          s.title,
          s.content,
          s.url,
          s.author ?? null,
          s.publishedAt ?? null,
          s.fingerprint,
          s.score,
          JSON.stringify(s.scoreBreakdown),
          s.createdAt,
        ],
      );
    }
  }

  async listSignals(topicId: string): Promise<Signal[]> {
    const rows = await this.driver.all<SignalRow>(
      'SELECT * FROM signals WHERE topic_id = ? ORDER BY score DESC, created_at ASC',
      [topicId],
    );
    return rows.map((r) => this.mapSignal(r));
  }

  private mapSignal(row: SignalRow): Signal {
    return {
      id: row.id,
      topicId: row.topic_id,
      provider: row.provider,
      sourceType: row.source_type,
      signalType: row.signal_type as SignalType,
      title: row.title,
      content: row.content,
      url: row.url,
      ...(row.author ? { author: row.author } : {}),
      ...(row.published_at ? { publishedAt: row.published_at } : {}),
      fingerprint: row.fingerprint,
      score: Number(row.score),
      scoreBreakdown: parse<ScoreBreakdown>(row.score_breakdown),
      createdAt: row.created_at,
    };
  }

  // ---------- insights ----------

  async insertInsights(insights: Insight[]): Promise<void> {
    for (const i of insights) {
      await this.driver.run(
        `INSERT INTO insights
          (id,topic_id,category,title,summary,signal_ids,status,created_at,reviewed_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          i.id,
          i.topicId,
          i.category,
          i.title,
          i.summary,
          JSON.stringify(i.signalIds),
          i.status,
          i.createdAt,
          i.reviewedAt ?? null,
        ],
      );
    }
  }

  async listInsights(topicId: string): Promise<Insight[]> {
    const rows = await this.driver.all<InsightRow>(
      'SELECT * FROM insights WHERE topic_id = ? ORDER BY created_at ASC',
      [topicId],
    );
    return rows.map((r) => this.mapInsight(r));
  }

  async getInsight(id: string): Promise<Insight | undefined> {
    const row = await this.driver.get<InsightRow>('SELECT * FROM insights WHERE id = ?', [id]);
    return row ? this.mapInsight(row) : undefined;
  }

  async reviewInsight(id: string, status: InsightStatus, reviewedAt: string): Promise<number> {
    const result = await this.driver.run(
      'UPDATE insights SET status = ?, reviewed_at = ? WHERE id = ?',
      [status, reviewedAt, id],
    );
    return result.changes;
  }

  private mapInsight(row: InsightRow): Insight {
    return {
      id: row.id,
      topicId: row.topic_id,
      category: row.category as Insight['category'],
      title: row.title,
      summary: row.summary,
      signalIds: parse<string[]>(row.signal_ids),
      status: row.status as InsightStatus,
      createdAt: row.created_at,
      ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    };
  }

  // ---------- reports ----------

  async nextReportVersion(topicId: string): Promise<number> {
    const row = await this.driver.get<{ max: number | null }>(
      'SELECT MAX(version) AS max FROM research_reports WHERE topic_id = ?',
      [topicId],
    );
    return (row?.max ?? 0) + 1;
  }

  async insertReport(report: ResearchReport): Promise<void> {
    await this.driver.run(
      `INSERT INTO research_reports
        (id,topic_id,version,mode,stats,top_signals,insight_ids,markdown,generated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        report.id,
        report.topicId,
        report.version,
        report.mode,
        JSON.stringify(report.stats),
        JSON.stringify(report.topSignals),
        JSON.stringify(report.insights.map((i) => i.id)),
        report.markdown,
        report.generatedAt,
      ],
    );
  }

  async getReport(id: string): Promise<ResearchReport | undefined> {
    const row = await this.driver.get<ReportRow>('SELECT * FROM research_reports WHERE id = ?', [
      id,
    ]);
    if (!row) return undefined;
    const insightIds = parse<string[]>(row.insight_ids);
    const all = await this.listInsights(row.topic_id);
    const byId = new Map(all.map((i) => [i.id, i]));
    const insights = insightIds
      .map((x) => byId.get(x))
      .filter((x): x is Insight => x !== undefined);
    return {
      id: row.id,
      topicId: row.topic_id,
      version: Number(row.version),
      mode: row.mode,
      stats: parse(row.stats),
      topSignals: parse<Signal[]>(row.top_signals),
      insights,
      markdown: row.markdown,
      generatedAt: row.generated_at,
    };
  }
}
