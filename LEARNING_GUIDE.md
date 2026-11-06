# Interview guide: defend the design

## 1. Follow a request through the layers

Express matches a route. Authentication verifies a signed access JWT and loads the current user. Authorization checks a role or ownership. Zod rejects invalid/unknown inputs. The controller turns a service result into HTTP JSON. A service owns business rules and transaction boundaries; repositories expose plain SQL. Unexpected errors go to one handler and a structured log linked by request ID.

**Interview answer:** “The layers separate HTTP concerns from rules and SQL, without creating an abstraction for every function. A one-statement catalog update does not need an extra service just to pass arguments through.”

Trace `POST /api/orders` from `src/routes.js` into `src/services/orders.js`, then `transaction` in `src/db.js`. Explain why `app.js` is separate from `server.js`: Supertest can test the actual application without starting the production listener or shutdown handlers.

## 2. Why a transaction is essential

An order changes several facts: stock, order total, line items and inventory audit. If the fourth insert fails after stock is deducted, committing earlier writes would lose stock without a valid order. BEGIN/COMMIT groups all changes; ROLLBACK undoes all of them. Every query must use the **same checked-out pg client**. Calling `pool.query` in the middle can silently use a different connection outside the transaction.

Atomicity means all or none. Consistency comes from constraints plus service invariants. Isolation controls concurrent visibility. Durability means a committed transaction survives a server crash according to PostgreSQL's storage guarantees; it does not replace backups.

**Demonstration:** The integration test creates a PostgreSQL trigger that fails on a SALE audit insert. Order and item inserts and stock deductions have already executed; after the HTTP 500, SQL assertions prove stock and all tables are unchanged. The trigger is removed in `finally`. This tests rollback, rather than merely rejecting an invalid body before starting work.

Do not send email or call a payment gateway in a database transaction: locks remain held while waiting and the external action cannot be undone by SQL rollback. A later design could write an outbox record in the transaction and process it asynchronously.

## 3. Preventing overselling

Without locking: request A reads stock=1, request B reads stock=1, both accept. A transaction alone at READ COMMITTED does not prevent that race.

We SELECT the product rows `FOR UPDATE`, ordered by UUID. A locks the last unit. B waits. A updates stock and commits. B then reads the updated version with zero stock and returns 409. A CHECK constraint is a final defense against negative stock, but the service lock provides a predictable business error and coordinates multi-line work.

An alternative is `UPDATE products SET stock=stock-$1 WHERE id=$2 AND stock >= $1 RETURNING ...`. This is also atomic, but several products still require one transaction and a consistent ordering. Explain why a JavaScript mutex would fail across multiple Node instances.

**Deadlock example:** A locks product X then Y, B locks Y then X. Each waits for the other. Ordering both requests by product UUID reduces that risk. Cancellation locks the order and then products; stock-writing workflows never acquire an order lock after holding a product lock. Timeouts and operational retries remain necessary. No claim of universal deadlock immunity is made.

## 4. Cancellation and state machines

PENDING can become CONFIRMED or CANCELLED. CONFIRMED can become SHIPPED or CANCELLED. SHIPPED can become DELIVERED. DELIVERED and CANCELLED are terminal.

Checking status outside a transaction is unsafe: two cancellation requests could both see PENDING and restore stock twice. Locking the order row makes state check, stock restoration and history update one atomic decision. The second request sees CANCELLED and returns 409. A unique `(order_id,product_id,reason)` constraint additionally prevents duplicate SALE/CANCELLATION audit entries.

History has timestamp, status and actor. We keep a short JSON array in the order because transitions are few and the API reads history as a whole. A separate events table would be better for searching large audit streams. We do not allow arbitrary status edits or “uncancelling,” since either would undermine inventory accounting.

**Question:** What if an admin fills the warehouse to the stock limit before cancellation? Restoration would exceed the bound; the entire cancellation returns 409 and rolls back. An admin must first make room via a documented adjustment.

## 5. Integer money and historical facts

`19.99 * 100` in floating-point can surprise you. The API accepts integer cents; product prices are bounded PostgreSQL integers and order totals are bigint. The maximum allowed order remains within JavaScript's safe integer range, and pg returns bigint totals as decimal strings rather than potentially losing precision. Never use `parseFloat` on money to compute totals.

An order item's price and product name are snapshots. A JOIN to the current product price must not reprice an old order. The total is calculated from locked product rows, never from client totals. There is one implicit currency; adding currencies would require an explicit currency code and clear conversion rules.

## 6. Normalization and constraints

A category exists once; products reference it. An order references one user. A many-to-many relationship between orders and products becomes order_items with quantity and snapshot price. Inventory movements are an append-style audit trail; product stock is the current balance optimized for safe updates. Service transactions keep those two representations synchronized.

Snapshot names/prices and stored order totals are deliberate denormalizations: they represent historical facts and reduce read complexity. A foreign key prevents references to missing products, but cannot by itself ensure the stored order total equals all line totals. The service enforces that cross-row invariant. Direct SQL can bypass it; use a narrowly privileged service account in deployment.

Explain the difference between NOT NULL (a value must exist), CHECK (a row value is valid), UNIQUE (no duplicate key), PRIMARY KEY (identity) and FOREIGN KEY (referential integrity). PostgreSQL does not automatically index referencing foreign key columns; see the explicit migration indexes.

## 7. Indexes and EXPLAIN

An index helps find rows without scanning an entire table, at a cost in disk space and writes. `(user_id,created_at DESC,id)` supports finding one customer's orders in time order. `(status,created_at,id)` supports status/date reports. Foreign-key indexes help joins and referential checks. A partial active-product price index focuses on the public catalog.

Composite indexes follow leftmost-prefix usefulness: an index beginning with user_id is less useful for a query that filters only by date. The ORDER BY's final UUID makes pagination ties deterministic. Offset pagination still shifts under concurrent inserts; keyset pagination is a future improvement.

`EXPLAIN` estimates the plan. `EXPLAIN ANALYZE` actually executes the query and reports measured work. BUFFERS shows cache/page activity. Never casually run ANALYZE on a destructive statement: it executes the write. Our explain script contains SELECTs only. Sequential scans on five products are sensible; microsecond timings on a warm tiny fixture say nothing about production scale. Use representative cardinalities, statistics and concurrent load before adding/removing indexes.

## 8. SQL joins and reporting traps

INNER JOIN keeps matching rows, appropriate for order items that must have valid orders/products. LEFT JOIN retains customers with zero orders; use `COUNT(o.id)`, not COUNT(*), or each such customer will appear to have one order.

SUM aggregates values; GROUP BY creates product/status/month groups; HAVING filters aggregated groups, while WHERE filters input rows. The sales CTE makes a grouped result readable before `DENSE_RANK()` ranks product units, including ties. Monthly `LAG` compares adjacent active months without collapsing the rows.

Do not join orders to items and then SUM(order.total_cents): a three-item order would be counted three times. Revenue is aggregated directly from orders; product revenue is aggregated from line quantities × snapshot prices. Only DELIVERED counts as revenue here. This is an operational sales definition, not proof of settled payments. Date filters use order creation and half-open `[from,to)` ranges to avoid counting a boundary twice.

## 9. Authentication versus authorization

Authentication establishes who made the request. Authorization asks whether that user may do this operation. A valid JWT does not mean admin. Customer order reads must check ownership even when the caller knows another order UUID; returning 404 avoids revealing that the order exists.

bcrypt is intentionally slow and salted for passwords; SHA-256 alone would make offline password guessing cheap. Refresh tokens are high-entropy random values, so fast SHA-256 is appropriate for their storage lookup. A leaked refresh-token table does not contain immediately usable bearer tokens. Cookie HttpOnly blocks direct JavaScript reads, Secure requires HTTPS, SameSite=Strict reduces cross-site request sending, and exact origin checks add defense. These do not replace protection against same-origin XSS.

JWTs are signed, not encrypted. Do not put secrets in claims. We validate issuer, audience, algorithm and expiry, then read the current role from the database. Access lasts 15 minutes. Refresh rotation locks/consumes the old token and stores a new hash; replay revokes the family and that revocation must **commit** before throwing an HTTP error. Otherwise rollback would undo the security response.

Tradeoff: logout cannot instantly invalidate an already-issued access JWT. Another tradeoff: simultaneous legitimate refreshes look like replay, so clients serialize refresh. A distributed application also needs a shared rate-limit store, stable secret management, HTTPS, account recovery, monitoring and key rotation.

## 10. What the tests prove—and do not prove

Real PostgreSQL integration tests validate actual SQL syntax, locks, constraints, rollback and reports. Supertest crosses the real middleware and HTTP routing boundary. Fixtures reset one dedicated database between serial tests; the concurrency tests issue parallel HTTP requests within a test. Mocking pg would not prove PostgreSQL lock behavior.

Tests are evidence for the scenarios exercised, not a proof of correctness for all schedules or production throughput. No load benchmark, payment settlement, deployment, email flow or external CI run is implied by a green local suite. Read `docs/VERIFICATION.md` for actual results and explicit limits.

## Practice explaining these five decisions

1. Why use a transaction **and** a row lock, rather than either alone?
2. Why lock the order before cancellation and keep a unique movement constraint?
3. Why store historical prices and represent bigint amounts as strings in JSON?
4. Why hash refresh tokens differently from passwords, and why commit replay revocation?
5. Why can a LEFT JOIN report and a naive SUM accidentally inflate counts/revenue?
