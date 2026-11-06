# Verification record

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
