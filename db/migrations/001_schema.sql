CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name varchar(100) NOT NULL,
 email varchar(254) NOT NULL UNIQUE CHECK (email = lower(email)),
 password_hash text NOT NULL,
 role text NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','admin')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name varchar(100) NOT NULL UNIQUE,
 active boolean NOT NULL DEFAULT true
);
CREATE TABLE products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 category_id uuid NOT NULL REFERENCES categories(id),
 name varchar(150) NOT NULL,
 description text NOT NULL DEFAULT '',
 price_cents integer NOT NULL CHECK(price_cents BETWEEN 1 AND 100000000),
 stock integer NOT NULL DEFAULT 0 CHECK(stock BETWEEN 0 AND 1000000),
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONFIRMED','SHIPPED','DELIVERED','CANCELLED')),
 total_cents bigint NOT NULL CHECK(total_cents BETWEEN 1 AND 10000000000000),
 history jsonb NOT NULL DEFAULT '[{"status":"PENDING"}]'::jsonb CHECK(jsonb_typeof(history)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE order_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES orders(id),
 product_id uuid NOT NULL REFERENCES products(id),
 product_name varchar(150) NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100),
 unit_price_cents integer NOT NULL CHECK(unit_price_cents BETWEEN 1 AND 100000000),
 UNIQUE(order_id,product_id)
);
CREATE TABLE inventory_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 product_id uuid NOT NULL REFERENCES products(id),
 order_id uuid REFERENCES orders(id),
 actor_id uuid NOT NULL REFERENCES users(id),
 quantity integer NOT NULL CHECK(quantity <> 0),
 reason text NOT NULL CHECK(reason IN ('SALE','CANCELLATION','ADJUSTMENT')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((reason='SALE' AND order_id IS NOT NULL AND quantity<0) OR (reason='CANCELLATION' AND order_id IS NOT NULL AND quantity>0) OR (reason='ADJUSTMENT' AND order_id IS NULL)),
 UNIQUE(order_id,product_id,reason)
);
CREATE TABLE refresh_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 token_hash char(64) NOT NULL UNIQUE,
 family_id uuid NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products(category_id);
CREATE INDEX products_active_price_idx ON products(price_cents,id) WHERE active;
CREATE INDEX orders_user_date_idx ON orders(user_id,created_at DESC,id);
CREATE INDEX orders_status_date_idx ON orders(status,created_at,id);
CREATE INDEX order_items_product_idx ON order_items(product_id);
CREATE INDEX inventory_product_date_idx ON inventory_movements(product_id,created_at DESC);
CREATE INDEX inventory_actor_idx ON inventory_movements(actor_id);
CREATE INDEX refresh_user_idx ON refresh_tokens(user_id);
CREATE INDEX refresh_family_idx ON refresh_tokens(family_id);
CREATE INDEX refresh_expiry_idx ON refresh_tokens(expires_at);
