// J5 / 条件触发项「选品调研垂直」的本地部分（2026-11-07）。
//
// 设计边界（见 bayjf/docs/tier0/Tier0-跨境功能增量建议.md J5）：
//   - 只做价格带 / 供需信号对比的报告模板，复用 research 域既有 Signal 原语，
//     不新增 SignalType、不改评分器，避免牵动 G1 既有契约。
//   - 不接海关数据、不接平台内部询盘/成交、不爬竞对店铺；竞对只允许公开页+人工录入。
//   - 1688 官方开放平台 provider 是后续条件项（缺凭据 fail-closed），本模块先用
//     离线 fixture 跑通产品形态，数据源接入时只换 provider、不动这里的聚合。
//
// 商品调研把一条 Signal 的 content 视作结构化候选条目：价格来自可选的
// ProductObservation.priceCny（单位：人民币元），缺价格的条目不参与价格带统计，
// 但仍计入供需信号。

/**
 * 一条可被商品调研消费的观测。结构故意是 Signal 的最小超集，方便由
 * collector 产出的 Signal 适配而来（见 toProductObservations）。
 */
export interface ProductObservation {
  title: string;
  url: string;
  /** Signal 原语类型，供需判定只认其中一部分（见 DEMAND/SUPPLY_TYPES）。 */
  signalType: string;
  /** 人民币价格；可选，缺省时不进入价格带。 */
  priceCny?: number | undefined;
  /** 评分（可选），用于同价位带内排序。 */
  score?: number | undefined;
  publishedAt?: string | undefined;
}

/** 一个价格带的聚合结果。 */
export interface PriceBand {
  /** 闭区间下限（元）。 */
  minCny: number;
  /** 闭区间上限（元）；Infinity 表示最高开区间。 */
  maxCny: number;
  label: string;
  count: number;
  /** 带内样本的均价；无样本为 null。 */
  averageCny: number | null;
}

/** 供给 vs 需求两侧的计数。 */
export interface SupplyDemandSummary {
  supplySignals: number;
  demandSignals: number;
  /** demand / supply；无供给信号时为 null（避免除零）。 */
  demandToSupplyRatio: number | null;
}

export interface ProductResearchReport {
  generatedAt: string;
  sampleCount: number;
  pricedCount: number;
  priceBands: PriceBand[];
  supplyDemand: SupplyDemandSummary;
  markdown: string;
}

/** 表达"需求侧"的既有信号类型（买家诉求/痛点/意向）。 */
export const DEMAND_TYPES = new Set(['need', 'pain', 'intent']);
/** 表达"供给侧"的既有信号类型（竞品/对比/趋势）。 */
export const SUPPLY_TYPES = new Set(['competitor', 'comparison', 'trend']);

/**
 * 默认价格带（人民币元，闭区间；最后一档上不封顶）。选品调研常见的四档，
 * 可在 buildProductResearchReport 入参覆盖。
 */
export const DEFAULT_PRICE_BANDS: ReadonlyArray<{ minCny: number; maxCny: number; label: string }> = [
  { minCny: 0, maxCny: 49, label: '0–49' },
  { minCny: 50, maxCny: 199, label: '50–199' },
  { minCny: 200, maxCny: 499, label: '200–499' },
  { minCny: 500, maxCny: Number.POSITIVE_INFINITY, label: '500+' },
];

function bandFor(price: number, bands: ReadonlyArray<{ minCny: number; maxCny: number; label: string }>) {
  return bands.find((b) => price >= b.minCny && price <= b.maxCny);
}

/** 纯函数：统计价格带。无价格样本的条目不计入。 */
export function summarizePriceBands(
  observations: readonly ProductObservation[],
  bands: ReadonlyArray<{ minCny: number; maxCny: number; label: string }> = DEFAULT_PRICE_BANDS,
): PriceBand[] {
  const acc = new Map<string, { count: number; sum: number }>();
  for (const label of bands.map((b) => b.label)) acc.set(label, { count: 0, sum: 0 });

  let outside = 0;
  for (const o of observations) {
    if (typeof o.priceCny !== 'number' || Number.isNaN(o.priceCny) || o.priceCny < 0) continue;
    const band = bandFor(o.priceCny, bands);
    if (!band) {
      outside += 1;
      continue;
    }
    const entry = acc.get(band.label)!;
    entry.count += 1;
    entry.sum += o.priceCny;
  }
  if (outside > 0) {
    throw new Error(`${outside} observation(s) fell outside every configured price band`);
  }

  return bands.map((b) => {
    const entry = acc.get(b.label)!;
    return {
      minCny: b.minCny,
      maxCny: b.maxCny,
      label: b.label,
      count: entry.count,
      averageCny: entry.count === 0 ? null : Math.round((entry.sum / entry.count) * 100) / 100,
    };
  });
}

/** 纯函数：供给/需求两侧计数与比值。 */
export function summarizeSupplyDemand(observations: readonly ProductObservation[]): SupplyDemandSummary {
  let supplySignals = 0;
  let demandSignals = 0;
  for (const o of observations) {
    if (DEMAND_TYPES.has(o.signalType)) demandSignals += 1;
    if (SUPPLY_TYPES.has(o.signalType)) supplySignals += 1;
  }
  return {
    supplySignals,
    demandSignals,
    demandToSupplyRatio: supplySignals === 0 ? null : Math.round((demandSignals / supplySignals) * 100) / 100,
  };
}

function renderMarkdown(
  stats: { sampleCount: number; pricedCount: number; bands: PriceBand[]; sd: SupplyDemandSummary },
  now: string,
): string {
  const lines: string[] = [];
  lines.push('# 商品调研报告（离线模板）', '');
  lines.push(`> ⚠️ 本报告由离线 fixture 聚合生成，仅用于产品形态验证，不代表真实市场结论。`);
  lines.push(`> 生成时间：${now}`, '');
  lines.push('## 一、样本概览');
  lines.push(`- 观测总数：${stats.sampleCount}`);
  lines.push(`- 含价格样本：${stats.pricedCount}`);
  lines.push('');
  lines.push('## 二、价格带分布（人民币元）');
  if (stats.pricedCount === 0) {
    lines.push('_无含价格样本_');
  } else {
    for (const b of stats.bands) {
      const avg = b.averageCny === null ? '—' : `均价 ¥${b.averageCny}`;
      lines.push(`- **${b.label}**：${b.count} 条（${avg}）`);
    }
  }
  lines.push('');
  lines.push('## 三、供需信号对比');
  lines.push(`- 需求侧信号（need/pain/intent）：${stats.sd.demandSignals}`);
  lines.push(`- 供给侧信号（competitor/comparison/trend）：${stats.sd.supplySignals}`);
  lines.push(
    `- 需求/供给比：${stats.sd.demandToSupplyRatio === null ? '—（无供给信号）' : stats.sd.demandToSupplyRatio}`,
  );
  lines.push('');
  return lines.join('\n');
}

export interface BuildOptions {
  now?: string;
  bands?: ReadonlyArray<{ minCny: number; maxCny: number; label: string }>;
}

/** 聚合 + 出报告的单一入口（纯函数，便于离线测试）。 */
export function buildProductResearchReport(
  observations: readonly ProductObservation[],
  opts: BuildOptions = {},
): ProductResearchReport {
  const now = opts.now ?? new Date().toISOString();
  const bands = summarizePriceBands(observations, opts.bands ?? DEFAULT_PRICE_BANDS);
  const sd = summarizeSupplyDemand(observations);
  const pricedCount = observations.filter((o) => typeof o.priceCny === 'number').length;
  return {
    generatedAt: now,
    sampleCount: observations.length,
    pricedCount,
    priceBands: bands,
    supplyDemand: sd,
    markdown: renderMarkdown({ sampleCount: observations.length, pricedCount, bands, sd }, now),
  };
}
