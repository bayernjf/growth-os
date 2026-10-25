import type { RawMention, SearchQuery, SignalType } from '../types.js';
import { Errors } from '../errors.js';
import type { SearchProvider } from './types.js';

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

/** Lightweight heuristic to label a generic web result (Tavily-shaped). */
function classify(text: string): SignalType {
  const t = text.toLowerCase();
  if (/\b(vs|versus|compared to|alternative|对比|比较)\b/.test(t)) return 'comparison';
  if (/\b(sucks|broken|frustrat|hate|terrible|pain|痛点|难用|吐槽)\b/.test(t)) return 'pain';
  if (/\b(need|wish|looking for|recommend|how (do|can) i|求推荐|希望)\b/.test(t)) return 'need';
  if (/\b(hiring|hire|we're hiring|招聘)\b/.test(t)) return 'hiring';
  if (/\b(raises?|funding|series [a-z]|invested|融资)\b/.test(t)) return 'funding';
  if (/\b(built with|stack|using (react|next|vue|supabase))\b/.test(t)) return 'tech_stack';
  if (/\b(pricing|buy|purchase|demo|quote|购买|报价)\b/.test(t)) return 'intent';
  if (/\b(launches?|release|announc|competitor|发布)\b/.test(t)) return 'competitor';
  return 'trend';
}

/**
 * Online, Tavily-style REST search provider. Explicitly opt-in via
 * GROWTH_SEARCH_MODE=online with base URL + API key. It performs only GET
 * (search) requests; it never writes anywhere.
 */
export class OnlineSearchProvider implements SearchProvider {
  readonly name = 'online';
  readonly online = true;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    if (!baseUrl || !apiKey) {
      throw Errors.credentialMissing(
        'Online search selected but GROWTH_SEARCH_BASE_URL/GROWTH_SEARCH_API_KEY are not set',
      );
    }
  }

  async search(q: SearchQuery): Promise<RawMention[]> {
    const max = q.maxResults ?? 10;
    const out: RawMention[] = [];
    for (const keyword of q.keywords.length ? q.keywords : [q.keywords.join(' ')]) {
      const res = await this.fetchOne(keyword, max);
      for (const r of res) {
        if (!r.url || !r.title) continue;
        const text = `${r.title} ${r.content ?? ''}`;
        const type = classify(text);
        if (!q.signalTypes.includes(type)) continue;
        out.push({
          sourceType: 'web',
          signalType: type,
          title: r.title,
          content: r.content ?? '',
          url: r.url,
          ...(r.published_date ? { publishedAt: r.published_date } : {}),
        });
      }
    }
    return out.slice(0, max);
  }

  private async fetchOne(keyword: string, max: number): Promise<TavilyResult[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ query: keyword, max_results: max }),
      });
    } catch (err) {
      throw Errors.searchUnavailable(
        `Search provider unreachable: ${err instanceof Error ? err.message : 'network error'}`,
      );
    }
    if (!res.ok) {
      throw Errors.searchUnavailable(`Search provider returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { results?: TavilyResult[] };
    return Array.isArray(body.results) ? body.results : [];
  }
}
