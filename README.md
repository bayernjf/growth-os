# growth-os

Operations personal agent for growth: **market research, demand discovery,
prospecting, CRM and outreach**. It is an L3 business system in the Tier0
portfolio, sibling to `commerce-os`, orchestrated by the `zeus` kernel.

## Scope by milestone

| Milestone | Scope | Status |
|---|---|---|
| **G1** | Read-only research: signal engine (collect → dedupe → score → cluster) + human-reviewed insights + versioned reports | ✅ this build |
| G2 | Lead mining and local CRM (lead/contact state machine, follow-ups) | planned |
| G3 | Email outreach, gated by zeus (default D2 human approval; no send without sign-off) | planned |
| G4 | Operations hardening (real credentials, hosted persistence, remote) | external-blocked |

Explicitly **not** in scope: shopping / ticketing / payments (owned by
commerce-os), autonomous sending, self-built models.

## G1 in one loop

```
ResearchTopic ──▶ SearchProvider (offline fixtures | online Tavily-style POST /search)
                      │ read-only
                      ▼
        collect + fingerprint dedupe
                      ▼
        deterministic score (0–100, explainable breakdown)
                      ▼
        cluster need/pain/comparison → insights (pending_review)
                      ▼
        human review (confirm/reject)
                      ▼
        versioned, watermarked ResearchReport
```

- **Read-only**: no login, no third-party writes, no email, no transactions.
- **Offline by default**: deterministic replay of `recordings/search/fixtures.json`,
  so the whole loop runs with zero credentials and no network.
- **Fail-closed online**: `GROWTH_SEARCH_MODE=online` without
  `GROWTH_SEARCH_BASE_URL`/`GROWTH_SEARCH_API_KEY` makes a run return HTTP 422,
  never silently offline.
- **Human in the loop**: insights are only candidates; a report never
  auto-sends anything.

## Run

```bash
npm install
npm run build
npm run migrate:up          # creates ./data/growth-os.db (sqlite)
npm start                   # http://127.0.0.1:8788, GROWTH_SEARCH_MODE=offline

# quick loop
curl -X POST localhost:8788/api/v1/research/topics -H 'content-type: application/json' \
  -d '{"title":"AI CRM demand","keywords":["ai crm","outreach"],"signalTypes":["need","pain","comparison","trend"]}'
curl -X POST localhost:8788/api/v1/research/run -H 'content-type: application/json' \
  -d '{"topicId":"<topic_id>"}'
```

## Verify

```bash
npm run check:migrations && npm run typecheck && npm run lint && npm test && npm run build
```

- sqlite/pg migrations are paired and validated by `scripts/check-migrations.sh`.
- Tests run on in-memory sqlite; postgres is an optional production dependency
  (`pg`) not exercised in local CI.
- `node:sqlite` requires Node 22 with `--experimental-sqlite` (already wired in
  the start/migrate scripts).

## Configuration

See `.env.example`. Every secret is env-only; nothing sensitive is stored in
the database or committed.

### Auth (fail-closed)

`GROWTH_API_TOKEN` is required: the server refuses to boot without it, and
every `/api/v1/*` route then demands `Authorization: Bearer <token>` compared
in constant time (Tier0 review 2026-10-30 H1). The MCP endpoint `/mcp` requires
`GROWTH_MCP_TOKEN`: when it is unset every request is rejected (fail-closed).
The boot log prints the active auth posture.

## Layout

```
src/
  research/            types, scoring, collector, insights, report, repository, service
    provider/          SearchProvider port + offline/online/registry
  api/                 Hono HTTP routes
  storage/             driver port + sqlite/postgres (dialect boundary)
recordings/search/     deterministic offline fixtures
db/migrations/         sqlite + postgres paired migrations
tests/                 unit + contract + HTTP tests
```

See `handoff.md` for live status and `../bayjf/docs/tier0/` for the product
plan, PRD, design and task breakdown (growth-os-*).
