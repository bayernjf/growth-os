import type { AppConfig } from '../../config.js';
import { Errors } from '../errors.js';
import { OfflineSearchProvider } from './offline.js';
import { OnlineSearchProvider } from './online.js';
import type { SearchProvider } from './types.js';

/**
 * Provider whose every call fails closed with CREDENTIAL_MISSING. Returned
 * when online mode is selected but credentials are absent, so the service
 * can still boot and healthz passes, while any run returns HTTP 422 rather
 * than silently using offline fixtures.
 */
class RejectingSearchProvider implements SearchProvider {
  readonly name = 'online';
  readonly online = true;
  async search(): Promise<never> {
    throw Errors.credentialMissing(
      'GROWTH_SEARCH_MODE=online requires GROWTH_SEARCH_BASE_URL and GROWTH_SEARCH_API_KEY',
    );
  }
}

export function createSearchProvider(config: AppConfig): SearchProvider {
  if (config.searchMode === 'online') {
    if (!config.searchBaseUrl || !config.searchApiKey) {
      return new RejectingSearchProvider();
    }
    return new OnlineSearchProvider(config.searchBaseUrl, config.searchApiKey);
  }
  return new OfflineSearchProvider();
}
