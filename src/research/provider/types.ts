import type { RawMention, SearchQuery } from '../types.js';

/**
 * Read-only search connector port. Implementations fetch external/public
 * data and never write to anything. Online providers must be explicitly
 * enabled and fail closed when credentials are missing.
 */
export interface SearchProvider {
  readonly name: string;
  readonly online: boolean;
  search(q: SearchQuery): Promise<RawMention[]>;
}
