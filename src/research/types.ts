// growth-os research domain types (G1).

export type SignalType =
  | 'need'
  | 'pain'
  | 'comparison'
  | 'competitor'
  | 'trend'
  | 'intent'
  | 'hiring'
  | 'funding'
  | 'tech_stack';

export const SIGNAL_TYPES: readonly SignalType[] = [
  'need',
  'pain',
  'comparison',
  'competitor',
  'trend',
  'intent',
  'hiring',
  'funding',
  'tech_stack',
];

export const INSIGHT_CATEGORIES = ['need', 'pain', 'comparison'] as const;
export type InsightCategory = (typeof INSIGHT_CATEGORIES)[number];

export type InsightStatus = 'pending_review' | 'confirmed' | 'rejected';
export type TopicStatus = 'draft' | 'running' | 'done';

export interface ResearchTopic {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  signalTypes: SignalType[];
  language: string;
  status: TopicStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchTopicInput {
  title: string;
  description?: string;
  keywords: string[];
  signalTypes?: SignalType[];
  language?: string;
}

/** A raw hit returned by a SearchProvider, before normalization/scoring. */
export interface RawMention {
  sourceType: string;
  signalType: SignalType;
  title: string;
  content: string;
  url: string;
  author?: string | undefined;
  publishedAt?: string | undefined;
}

export interface SearchQuery {
  keywords: readonly string[];
  signalTypes: readonly SignalType[];
  language?: string | undefined;
  maxResults?: number | undefined;
}

export interface ScoreBreakdown {
  type: number;
  source: number;
  fresh: number;
  keyword: number;
  total: number;
}

export interface Signal {
  id: string;
  topicId: string;
  provider: string;
  sourceType: string;
  signalType: SignalType;
  title: string;
  content: string;
  url: string;
  author?: string;
  publishedAt?: string;
  fingerprint: string;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  createdAt: string;
}

export interface Insight {
  id: string;
  topicId: string;
  category: InsightCategory;
  title: string;
  summary: string;
  signalIds: string[];
  status: InsightStatus;
  createdAt: string;
  reviewedAt?: string;
}

export interface ReportStats {
  mode: string;
  totalSignals: number;
  byType: Record<string, number>;
  averageScore: number;
  aboveThreshold: number;
  generatedAt: string;
}

export interface ResearchReport {
  id: string;
  topicId: string;
  version: number;
  mode: string;
  stats: ReportStats;
  topSignals: Signal[];
  insights: Insight[];
  markdown: string;
  generatedAt: string;
}

export interface RunResult {
  topic: ResearchTopic;
  signals: Signal[];
  insights: Insight[];
  report: ResearchReport;
}
