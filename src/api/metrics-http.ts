import { Hono } from 'hono';
import {
  type GrowthMetricsService,
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheusMetrics,
} from '../observability/prometheus.js';

/**
 * Prometheus scrapes `/metrics` from the local tier0-net. This route is
 * deliberately outside `/api/v1` and outside the bearer guard: it exposes
 * aggregate counts only, never lead identities or message content.
 */
export function createMetricsApp(deps: { service: GrowthMetricsService }): Hono {
  const app = new Hono();
  app.get('/metrics', async (c) => {
    const snapshot = await deps.service.getMetrics();
    return c.text(renderPrometheusMetrics(snapshot), 200, {
      'Content-Type': PROMETHEUS_CONTENT_TYPE,
      'Cache-Control': 'no-store',
    });
  });
  return app;
}
