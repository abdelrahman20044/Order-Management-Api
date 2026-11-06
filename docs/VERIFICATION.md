# Sales dates and order idempotency verification

Validated on 6 November 2026 on `feature/sales-dates-order-idempotency`, based on merged main `bb4c911`.

- PostgreSQL 17 integration suites: **30 passed, 0 failed, 0 skipped** on Node 22 and Node 24.
- Coverage: 97.14% statements, 92.9% branches, 98.91% functions, 97.97% lines (excluding server entry point).
- ESLint, Prettier check and OpenAPI validation passed.
- Migration 002 applied to existing test/development databases; repeated migration skipped safely. The migration test also builds schema 001 in an isolated PostgreSQL schema, inserts legacy delivered/pending orders, applies 002, and checks exact history, missing/malformed history fallback, delivery-state constraints and null legacy keys.
- Cross-month tests verify delivery-based revenue, monthly sales, top products and customer revenue, while order counts/lists remain creation-based.
- Idempotency tests cover concurrent identical/conflicting payloads, user isolation, reordered/case-normalized items, replay after cancellation/catalog changes, invalid keys, absent/distinct keys, and retry after both pre-write failure and injected post-write failure.
- EXPLAIN.txt was regenerated using actual delivery-based queries on the seeded development database. This is not a production performance benchmark.
- Read-only `git ls-remote --symref origin HEAD` reported **feature/order-management-api** as the repository default branch. Settings were not modified. README contains iPhone instructions for selecting main.
- GitHub API access still returns Forbidden (403). Remote Actions status and automated PR creation cannot be verified through that API; final chat reports the feature push and PR outcome. The green CI screenshot from the previous implementation is not evidence for this new branch.

Rollout: migrate before starting the new application and pause delivery transitions until all writers use the new code. Legacy fallback dates are flagged estimates. Idempotency is optional, per user, retained for the order lifetime, and returns current order state with HTTP 201 on replay. No new dependencies or application tables were added. No repository settings, merge, deployment or environment publication was performed for this change.

---

# Original implementation verification record

Executed in the managed cloud environment on 6 November 2026. No public deployment or environment publication was performed for this implementation.

| Check                                          | Observed result                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| Node 24.22.1 + PostgreSQL 17 integration suite | 22 passed, 0 failed, 0 skipped                                                       |
| Node 22 Docker runtime + PostgreSQL 17 suite   | 22 passed, 0 failed, 0 skipped                                                       |
| Coverage (src, excluding process entry point)  | 97% statements, 92.36% branches, 98.86% functions, 97.87% lines                      |
| ESLint                                         | Passed                                                                               |
| Prettier check                                 | Passed                                                                               |
| OpenAPI 3.0 parser validation                  | Passed; 30 documented operations                                                     |
| npm audit --omit=dev                           | 0 reported runtime vulnerabilities at check time                                     |
| Migration from empty database                  | Passed                                                                               |
| Repeated migration                             | Passed; no migrations reapplied                                                      |
| Development seed                               | 3 users, 3 categories, 5 products, 4 orders                                          |
| Repeated seed                                  | Skipped safely because users exist                                                   |
| Docker image                                   | Built successfully; application runs as non-root node user                           |
| Docker Compose                                 | Database healthy, migration exit 0, API healthy                                      |
| Actual Compose HTTP requests                   | Health, seeded catalog, login, create order, cancel order, refresh all passed        |
| Production server smoke                        | Secure refresh cookie checked; SIGTERM shutdown exited 0                             |
| EXPLAIN (ANALYZE, BUFFERS)                     | Executed revenue, top products, customer order listing; actual output in EXPLAIN.txt |
| GitHub Actions run                             | Not inspected: api.github.com CONNECT denied by environment proxy (403)              |
| Public deployment                              | Not attempted                                                                        |

## Reproduction details

Host tests used `orders_test` on a PostgreSQL 17 Docker container, with migrations applied first. The test suite performs destructive fixture resets and refuses database names that do not end with `_test`. No SQL mocking or in-memory database substitution was used.

The Node 22 run used the official `node:22-bookworm-slim` image, the same working tree and installed npm dependencies mounted at `/app`, and a separate `orders_test` database in the Compose PostgreSQL service. The suite ran with `npm run test:coverage`. The test fixture hashes a password once, signs access JWTs for feature tests, and exercises real login/refresh/logout in auth tests.

The Compose run used a cloud-only override outside the repository: PostgreSQL's host port was 5433 to avoid the existing test service, and a BuildKit proxy CA secret was supplied for verified npm HTTPS downloads. Database, migration, image entry point, non-root permissions and API commands were the repository's normal Compose definitions. No TLS verification was disabled. The sample seed and all Docker HTTP checks used generated ignored local credentials. A separate host production-mode server checked Secure cookies and graceful shutdown.

## Failures found and fixed

The first integration run found PostgreSQL parameter inference treating one user ID as both text and UUID in the order-history INSERT. Explicit UUID casts fixed it; the full suite then passed. A later Compose run found that restrictive source-file permissions made the root-owned package manifests unreadable to the node user. Docker COPY ownership was corrected, then the full Compose startup and functional checks passed. Formatting exposed an ESLint computed-property line-break conflict in a test helper; the helper was rewritten and both checks passed.

## Limits

Local checks do not establish that GitHub Actions has run or passed. The workflow is included and executes migrations, lint, formatting, OpenAPI validation and integration tests against a real PostgreSQL service. GitHub API access is independently blocked even though Git operations may be available through the injected HTTPS Git proxy. No GitHub token was requested or extracted.

The source repository initially had no commits or branches. An empty local root commit establishes an ancestor for a future PR base. The implementation is developed on `feature/order-management-api`; no main-branch push or merge is authorized or claimed here. Automatic approval review rejected creating a remote main baseline without explicit approval. The final chat reports the actual feature-branch push outcome and any outstanding review steps.

Small seed query plans are inspectable evidence of executable SQL, not production benchmarks. No throughput/load test, real payment, external deployment, production database hardening, failover/backup recovery or fresh cloud-snapshot restoration was verified. Jest ESM support emits Node's experimental VM Modules warning; the tests completed successfully on both tested Node versions.
