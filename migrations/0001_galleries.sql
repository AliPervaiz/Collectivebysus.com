-- Client proofing galleries

CREATE TABLE galleries (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,          -- unguessable token in the share link
  title            TEXT NOT NULL,
  client_name      TEXT,
  client_email     TEXT,
  pin_hash         TEXT,                          -- NULL = no PIN required
  allow_downloads  INTEGER NOT NULL DEFAULT 0,
  max_selections   INTEGER,                       -- NULL = unlimited
  expires_at       TEXT,                          -- YYYY-MM-DD, NULL = never
  submitted_at     TEXT,
  client_note      TEXT,
  pin_failures     INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE photos (
  id          TEXT PRIMARY KEY,
  gallery_id  TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  favorite    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_photos_gallery ON photos (gallery_id, filename);
