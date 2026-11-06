-- Forward-only: preserve delivered history; mark fallback timestamps as estimates.
ALTER TABLE orders ADD COLUMN delivered_at timestamptz;
ALTER TABLE orders ADD COLUMN delivered_at_estimated boolean NOT NULL DEFAULT false;
WITH historical AS (
 SELECT o.id, (
  SELECT max(CASE
   WHEN event->>'at' ~ '^\d{4}-.*(Z|[+-]\d{2}:\d{2})$'
    AND pg_input_is_valid(event->>'at', 'timestamp with time zone')
   THEN (event->>'at')::timestamptz END)
  FROM jsonb_array_elements(o.history) event WHERE event->>'status'='DELIVERED'
 ) AS event_at FROM orders o WHERE o.status='DELIVERED'
)
UPDATE orders o SET delivered_at=coalesce(h.event_at,o.updated_at),
 delivered_at_estimated=(h.event_at IS NULL)
FROM historical h WHERE o.id=h.id;
ALTER TABLE orders ADD CONSTRAINT orders_delivery_state_check CHECK (
 (status='DELIVERED' AND delivered_at IS NOT NULL) OR
 (status<>'DELIVERED' AND delivered_at IS NULL AND NOT delivered_at_estimated)
);
CREATE INDEX orders_delivered_date_idx ON orders(delivered_at,id) WHERE status='DELIVERED';

-- Null keys preserve compatibility for callers that do not opt in.
ALTER TABLE orders ADD COLUMN idempotency_key varchar(128);
ALTER TABLE orders ADD COLUMN request_hash char(64);
ALTER TABLE orders ADD CONSTRAINT orders_idempotency_pair_check CHECK (
 (idempotency_key IS NULL AND request_hash IS NULL) OR
 (idempotency_key IS NOT NULL AND request_hash IS NOT NULL
  AND idempotency_key ~ '^[A-Za-z0-9._-]{1,128}$' AND request_hash ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX orders_user_idempotency_idx ON orders(user_id,idempotency_key)
 WHERE idempotency_key IS NOT NULL;
