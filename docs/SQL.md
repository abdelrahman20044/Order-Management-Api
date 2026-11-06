# SQL design and reporting

The source of truth is `db/migrations/001_schema.sql` and the visible queries in `src/repositories/` and transactional `src/services/`.

## Schema choices

- Users hold identity and role; unique lowercased email prevents duplicate normalized accounts.
- Categories/products are separate entities; one category can contain many products.
- Orders hold customer, lifecycle and bounded historical status events; order_items resolve the many-to-many relationship to products.
- Line prices and names are historical snapshots. Changing a product does not rewrite financial history.
- Product stock is a cached balance for fast locking. Inventory movements explain each API change. Database operators must not edit stock without a matching audited adjustment.
- Refresh tokens are normalized into one row per issue, with only a unique digest and family identifier; user rows never hold raw bearer credentials.
- No hard-delete API is exposed for products/categories/users/orders. Historical foreign keys remain intact.

The service enforces total = SUM(line quantity × line snapshot price) inside a transaction. SQL CHECK constraints enforce local numeric bounds, lifecycle membership and movement signs; they cannot enforce the entire state machine or cross-row totals. Only trusted operators may directly write tables. `schema_migrations` is infrastructure metadata, not an eighth domain entity.

## Index decisions

| Index                                                      | Purpose / tradeoff                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| users(email), categories(name) unique                      | Identity/name lookup and conflict prevention                 |
| products(category_id)                                      | Category filtering and FK access                             |
| products(price_cents,id) WHERE active                      | Active-price browsing; JOIN still checks category visibility |
| orders(user_id,created_at DESC,id)                         | Customer-scoped history and page order                       |
| orders(status,created_at,id)                               | Delivered/status range reports                               |
| order_items(order_id,product_id) unique                    | One product per order; item retrieval by order               |
| order_items(product_id)                                    | Product sales aggregation and FK checks                      |
| inventory(order_id,product_id,reason) unique               | At most one sale/restoration per product and order           |
| inventory(product_id,created_at DESC), actor_id            | Product audit and actor FK operations                        |
| refresh(token_hash) unique, family_id, user_id, expires_at | Lookup, replay revocation, FK and expiry maintenance         |

Foreign keys do not automatically index referencing columns in PostgreSQL. Indexes consume storage and add work to stock/orders/token writes. The database may appropriately choose sequential scans on this small seed. A leading-wildcard ILIKE search does not benefit much from an ordinary B-tree; use a measured pg_trgm/full-text addition for a larger catalog. Extra name/date sort indexes are deferred until workload evidence warrants them.

## Important parameterized queries

```sql
-- Revenue avoids joining line items, so order totals are not multiplied.
SELECT coalesce(sum(total_cents),0)::text AS revenue_cents,
       count(*)::int AS delivered_orders
FROM orders
WHERE status = 'DELIVERED'
  AND ($1::timestamptz IS NULL OR created_at >= $1)
  AND ($2::timestamptz IS NULL OR created_at < $2);

-- CTE separates product aggregation from ranking. Tied unit counts share rank.
WITH sales AS (
  SELECT p.id,p.name,sum(i.quantity)::int AS units,
         sum(i.quantity::bigint*i.unit_price_cents)::text AS revenue_cents
  FROM order_items i
  INNER JOIN orders o ON o.id=i.order_id
  INNER JOIN products p ON p.id=i.product_id
  WHERE o.status='DELIVERED'
    AND ($1::timestamptz IS NULL OR o.created_at >= $1)
    AND ($2::timestamptz IS NULL OR o.created_at < $2)
  GROUP BY p.id,p.name HAVING sum(i.quantity)>0
)
SELECT *,dense_rank() OVER(ORDER BY units DESC) AS sales_rank
FROM sales ORDER BY units DESC,id LIMIT $3;

-- LEFT JOIN preserves customers with no purchases in the selected interval.
SELECT u.id,u.name,count(o.id)::int AS order_count,
       coalesce(sum(o.total_cents) FILTER(WHERE o.status='DELIVERED'),0)::text
         AS lifetime_revenue_cents
FROM users u LEFT JOIN orders o ON o.user_id=u.id
  AND ($1::timestamptz IS NULL OR o.created_at >= $1)
  AND ($2::timestamptz IS NULL OR o.created_at < $2)
WHERE u.role='customer'
GROUP BY u.id,u.name;
```

`customer-history` counts every status but spends only delivered totals; `lifetime_revenue_cents` is restricted to the range if dates are supplied. Product reports use current product names as labels, snapshot prices for money, and include delivered sales of subsequently deactivated products. Order item responses keep historical names.

Monthly sales groups `date_trunc('month', created_at AT TIME ZONE 'UTC')`, then applies `LAG(revenue_cents)` to calculate a meaningful change between active months. Empty months are absent. Order counts group all states; low stock joins active products/categories and applies a numeric threshold.

Values are always parameters. Identifiers such as sort columns cannot be SQL parameters, so catalog sorting uses a fixed server map after Zod enum validation. Report names map to a fixed SQL object. No arbitrary SQL fragments come from requests.

## Locking and execution

`SELECT ... ORDER BY p.id FOR UPDATE OF p` locks products on one transaction client. Stock update, order inserts and movements commit together. `SELECT ... FROM orders WHERE id=$1 FOR UPDATE` serializes state transitions and cancellation. All multi-product stock operations lock ascending UUIDs. See the integration tests for actual simultaneous requests and an injected SQL exception after writes.

Run `npm run explain` against a seeded development database. It executes SELECT-only `EXPLAIN (ANALYZE, BUFFERS)` for delivered revenue, top products and customer history. Actual captured output is in `EXPLAIN.txt`. Planning overhead, warm caches, five products and four orders make timings unsuitable for capacity claims. A production evaluation needs representative volumes, ANALYZE statistics, parameter distributions and concurrent load; neither forced index scans nor invented benchmarks would help.
