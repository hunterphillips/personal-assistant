// Claude SDK loading shared by runtime adapters and one-shot daemon calls.
// createQueryLoader() returns ensureQuery(), which resolves an injected query
// or imports and caches the SDK query. A failed import is wrapped and retried
// on the next call. This module never starts a model call.

import { RuntimeError } from './adapter.mjs';

// ApiKeySource values that do not bill an API key. Unknown sources are not
// treated as subscription-backed.
export const SUBSCRIPTION_SOURCES = new Set(['none', 'oauth']);

export const importClaudeSdk = () => import('@anthropic-ai/claude-agent-sdk');

export function createQueryLoader({ query = null, importSdk = importClaudeSdk } = {}) {
  let loadedQuery = query;
  let loadingSdk = null;

  function ensureQuery() {
    if (loadedQuery) return Promise.resolve(loadedQuery);
    loadingSdk ??= importSdk().then((sdk) => {
      loadedQuery = sdk.query;
      return loadedQuery;
    }, (error) => {
      loadingSdk = null;
      throw new RuntimeError('sdk_unavailable', { cause: error });
    });
    return loadingSdk;
  }

  return { ensureQuery };
}
