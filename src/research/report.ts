import type { Insight, ResearchReport, ResearchTopic, Signal } from './types.js';
import { newId } from '../util/hash.js';
import { SIGNAL_TYPES } from './types.js';

export interface ReportInput {
  topic: ResearchTopic;
  signals: Signal[];
  insights: Insight[];
  mode: string;
  version: number;
  topN: number;
  minScore: number;
  now?: string;
}

function buildMarkdown(r: Pick<ReportInput, 'topic' | 'mode' | 'version'>, p: {
  stats: ResearchReport['stats'];
  top: Signal[];
  insights: Insight[];
}): string {
  const lines: string[] = [];
  const watermark =
    r.mode === 'offline'
      ? `> ⚠️ **离线演示数据（offline fixtures）**：本报告由录制样例生成，不代表真实市场结论，请勿外发或作为决策依据。\n>`
      : `> ℹ️ 数据来源：在线搜索（mode=${r.mode}）。洞察为候选，需人工确认。`;

  lines.push(`# 市场需求调研：${r.topic.title}`, '');
  lines.push(`- Topic: \`${r.topic.id}\`　版本：v${r.version}　模式：${r.mode}`);
  lines.push('', watermark, '');

  lines.push('## 一、总体统计');
  lines.push(`- 信号总数：${p.stats.totalSignals}`);
  lines.push(`- 平均分：${p.stats.averageScore}`);
  lines.push(`- 达洞察阈值（≥${p.stats.aboveThreshold === 0 ? 0 : '见'}）信号：${p.stats.aboveThreshold}`);
  lines.push(`- 候选洞察：${p.insights.length}（默认待人工确认）`);
  lines.push('- 按类型分布：');
  for (const t of SIGNAL_TYPES) {
    const c = p.stats.byType[t] ?? 0;
    if (c > 0) lines.push(`  - ${t}: ${c}`);
  }
  lines.push('');

  lines.push('## 二、Top 信号（按评分）');
  if (p.top.length === 0) {
    lines.push('_无信号_');
  } else {
    for (const s of p.top) {
      lines.push(
        `- **[${s.score}] (${s.signalType}/${s.sourceType})** ${s.title} — ${s.url}` +
          (s.publishedAt ? `（${s.publishedAt.slice(0, 10)}）` : ''),
      );
    }
  }
  lines.push('');

  lines.push('## 三、候选洞察（待确认）');
  if (p.insights.length === 0) {
    lines.push('_无达阈值候选洞察_');
  } else {
    for (const i of p.insights) {
      lines.push(`- **[${i.status}] ${i.title}**（${i.category}，证据 ${i.signalIds.length} 条）`);
      lines.push(`  - ${i.summary}`);
    }
  }
  lines.push('');
  lines.push(`_生成时间：${p.stats.generatedAt}。每条信号均附证据 URL；洞察确认前不自动外发。_`);
  return lines.join('\n');
}

/** Aggregate signals + insights into a versioned, watermarked report. */
export function generateReport(input: ReportInput): ResearchReport {
  const now = input.now ?? new Date().toISOString();
  const byType: Record<string, number> = {};
  for (const t of SIGNAL_TYPES) byType[t] = 0;
  for (const s of input.signals) {
    byType[s.signalType] = (byType[s.signalType] ?? 0) + 1;
  }
  const total = input.signals.length;
  const average =
    total === 0 ? 0 : Math.round(input.signals.reduce((sum, s) => sum + s.score, 0) / total);
  const aboveThreshold = input.signals.filter((s) => s.score >= input.minScore).length;

  const stats = {
    mode: input.mode,
    totalSignals: total,
    byType,
    averageScore: average,
    aboveThreshold,
    generatedAt: now,
  };

  const top = [...input.signals].sort((a, b) => b.score - a.score).slice(0, input.topN);
  const insights = [...input.insights].sort((a, b) =>
    a.title.localeCompare(b.title, 'zh-Hans-CN'),
  );

  const markdown = buildMarkdown(
    { topic: input.topic, mode: input.mode, version: input.version },
    { stats, top, insights },
  );

  return {
    id: newId('rpt'),
    topicId: input.topic.id,
    version: input.version,
    mode: input.mode,
    stats,
    topSignals: top,
    insights,
    markdown,
    generatedAt: now,
  };
}
