-- After Hours Burger: initial durable schema.
-- Applied by apps/server/src/migrate.ts inside a transaction under an advisory lock.

CREATE TABLE profiles (
  id            uuid PRIMARY KEY,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);

CREATE TABLE restaurants (
  id             uuid PRIMARY KEY,
  owner_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  balance_cents  bigint NOT NULL,
  stock          jsonb NOT NULL,
  upgrades       jsonb NOT NULL DEFAULT '[]'::jsonb,
  version        bigint NOT NULL DEFAULT 1,
  save_schema    integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX restaurants_owner_idx ON restaurants (owner_id);

-- Durable permissions beyond ownership (e.g. trusted staff who may open the restaurant).
CREATE TABLE restaurant_permissions (
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  profile_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role           text NOT NULL CHECK (role IN ('staff')),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, profile_id)
);

-- One live room may write a restaurant at a time. `epoch` is a fencing token that increases
-- whenever the lease changes hands; every durable room write checks it.
CREATE TABLE restaurant_leases (
  restaurant_id  uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  holder         text,
  epoch          bigint NOT NULL DEFAULT 0,
  expires_at     timestamptz NOT NULL DEFAULT 'epoch'
);

CREATE TABLE restaurant_checkpoints (
  restaurant_id  uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  lease_epoch    bigint NOT NULL,
  data           jsonb NOT NULL,
  saved_at       timestamptz NOT NULL DEFAULT now()
);

-- Completed sales. The primary key makes payment for an order idempotent.
CREATE TABLE sales (
  restaurant_id        uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_key            text NOT NULL,
  shift_id             uuid NOT NULL,
  order_number         integer NOT NULL,
  price_cents          integer NOT NULL CHECK (price_cents >= 0),
  tip_cents            integer NOT NULL CHECK (tip_cents >= 0),
  score                smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  feedback             jsonb NOT NULL,
  served_item_ids      jsonb NOT NULL,
  balance_after_cents  bigint NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, order_key)
);
CREATE INDEX sales_shift_idx ON sales (restaurant_id, shift_id);

-- Stock purchases, idempotent per purchase key.
CREATE TABLE purchases (
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  purchase_key   text NOT NULL,
  stock_key      text NOT NULL,
  quantity       integer NOT NULL CHECK (quantity > 0),
  price_cents    integer NOT NULL CHECK (price_cents >= 0),
  result         jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, purchase_key)
);

-- Append-only ledger of balance changes.
CREATE TABLE economic_events (
  id             bigserial PRIMARY KEY,
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('sale', 'purchase', 'adjustment')),
  amount_cents   bigint NOT NULL,
  ref            text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX economic_events_restaurant_idx ON economic_events (restaurant_id, created_at);

CREATE TABLE shift_summaries (
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  shift_id       uuid NOT NULL,
  revenue_cents  bigint NOT NULL,
  cost_cents     bigint NOT NULL,
  waste_cents    bigint NOT NULL,
  served         integer NOT NULL,
  refused        integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, shift_id)
);
