-- CRM: clients, inquiries, sessions, payments, activity log, settings,
-- contract templates, rate limits. Money is stored as integer cents.

CREATE TABLE clients (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT,                            -- lowercased; match key for inquiries/bookings
  phone           TEXT,
  instagram       TEXT,                            -- handle without @
  notes           TEXT,
  can_post        TEXT NOT NULL DEFAULT 'ask' CHECK (can_post IN ('yes', 'no', 'ask')),
  is_minor        INTEGER NOT NULL DEFAULT 0,
  guardian_name   TEXT,
  guardian_email  TEXT,
  source          TEXT,                            -- instagram, referral, google, cal.com, ...
  last_contact_at TEXT,
  stripe_customer_id TEXT,                         -- reserved for a later Stripe integration
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_clients_email ON clients (email) WHERE email IS NOT NULL;
CREATE INDEX idx_clients_created ON clients (created_at);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  inquiry_id        TEXT,
  type              TEXT NOT NULL DEFAULT 'portrait' CHECK (type IN ('graduation', 'engagement', 'event', 'portrait')),
  title             TEXT,
  starts_at         TEXT,                          -- ISO 8601 UTC
  ends_at           TEXT,
  hours             REAL,
  location          TEXT,
  status            TEXT NOT NULL DEFAULT 'inquiry'
                    CHECK (status IN ('inquiry', 'booked', 'shot', 'editing', 'delivered', 'done', 'lost', 'archived')),
  status_changed_at TEXT NOT NULL,
  quoted_cents      INTEGER,
  currency          TEXT NOT NULL DEFAULT 'usd',
  notes             TEXT,
  cal_booking_uid   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_sessions_cal_uid ON sessions (cal_booking_uid) WHERE cal_booking_uid IS NOT NULL;
CREATE INDEX idx_sessions_client ON sessions (client_id);
CREATE INDEX idx_sessions_status ON sessions (status, starts_at);

CREATE TABLE inquiries (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id      TEXT,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT,
  instagram       TEXT,
  session_type    TEXT,
  preferred_dates TEXT,                            -- JSON array of strings
  location        TEXT,
  people_count    TEXT,
  usage           TEXT,
  referral        TEXT,
  message         TEXT,
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'replied', 'closed')),
  replied_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_inquiries_status ON inquiries (status, created_at);
CREATE INDEX idx_inquiries_client ON inquiries (client_id);

CREATE TABLE payments (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency      TEXT NOT NULL DEFAULT 'usd',
  method        TEXT NOT NULL CHECK (method IN ('venmo', 'zelle', 'cash', 'card', 'other')),
  kind          TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('retainer', 'balance', 'other')),
  paid_on       TEXT NOT NULL,                     -- YYYY-MM-DD
  note          TEXT,
  provider      TEXT NOT NULL DEFAULT 'manual',    -- 'manual' now; 'stripe' later
  provider_ref  TEXT,                              -- e.g. Stripe payment_intent id
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_payments_session ON payments (session_id);
CREATE UNIQUE INDEX idx_payments_provider_ref ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE activity (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id  TEXT,
  kind        TEXT NOT NULL,                       -- inquiry, note, contact, status, payment, booking, gallery
  body        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_activity_client ON activity (client_id, created_at);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE contract_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  is_draft    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE rate_limits (
  bucket      TEXT NOT NULL,                       -- e.g. 'inquiry'
  key         TEXT NOT NULL,                       -- hashed IP
  window_start INTEGER NOT NULL,                   -- unix seconds
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, key, window_start)
);

-- Link galleries to the CRM (both optional).
ALTER TABLE galleries ADD COLUMN client_id TEXT;
ALTER TABLE galleries ADD COLUMN session_id TEXT;
CREATE INDEX idx_galleries_client ON galleries (client_id);
CREATE INDEX idx_galleries_session ON galleries (session_id);
