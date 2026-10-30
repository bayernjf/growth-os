// Reserved model-hub integration (Tier0 W7-1).
//
// growth-os G1 makes zero model calls today. This module only reserves the
// wiring for the future text/embedding opt-in (LLM clustering). It is never
// imported from boot paths: the app starts exactly as before, no catalog pull
// happens, no network is touched. A future feature that wants built-in models
// must (a) set MODEL_HUB_URL/MODEL_HUB_TOKEN and (b) explicitly call
// createReservedModelKit() from the opt-in feature. Everything here fails
// closed: an unset reservation means no model, never an implicit paid call.

import { initModelKit, type ModelKit } from '@model-hub/model-kit';

const OFF_VALUES = new Set(['1', 'true', 'yes', 'on']);

export interface ModelHubReservation {
  /** True only when the kill switch is off and both url/token are present. */
  configured: boolean;
  projectSlug: 'growth-os';
  url?: string | undefined;
  cachePath: string;
}

export function readModelHubReservation(
  env: NodeJS.ProcessEnv = process.env,
): ModelHubReservation {
  const url = env.MODEL_HUB_URL;
  const token = env.MODEL_HUB_TOKEN;
  const disabled = OFF_VALUES.has((env.MODEL_HUB_DISABLED ?? '').toLowerCase());
  return {
    configured: !disabled && Boolean(url && token),
    projectSlug: 'growth-os',
    ...(url ? { url } : {}),
    cachePath: env.MODEL_HUB_CACHE_PATH ?? './data/model-hub-cache.json',
  };
}

export class ModelHubNotOptedIn extends Error {
  constructor() {
    super('model-hub not configured: set MODEL_HUB_URL and MODEL_HUB_TOKEN');
    this.name = 'ModelHubNotOptedIn';
  }
}

// Lazy opt-in entry point. Never called from boot. Resolves fail-closed when
// the reservation is off; the returned kit pulls its catalog on init() (the
// caller owns that lifecycle). fetchOverride exists for offline tests.
export async function createReservedModelKit(
  reservation: ModelHubReservation = readModelHubReservation(),
  env: NodeJS.ProcessEnv = process.env,
  fetchOverride?: typeof fetch,
): Promise<ModelKit> {
  if (!reservation.configured || !reservation.url || !env.MODEL_HUB_TOKEN) {
    throw new ModelHubNotOptedIn();
  }
  return initModelKit({
    hubUrl: reservation.url,
    token: env.MODEL_HUB_TOKEN,
    cachePath: reservation.cachePath,
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  });
}
