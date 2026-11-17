-- Day-level availability for the inquiry form's day picker.
-- A day is open when it's a shoot weekday (Settings) or explicitly opened here,
-- is not blocked here, and has fewer booked sessions than the daily limit.

CREATE TABLE day_overrides (
  day         TEXT PRIMARY KEY,                       -- YYYY-MM-DD in studio time
  kind        TEXT NOT NULL CHECK (kind IN ('blocked', 'open')),
  note        TEXT,
  created_at  TEXT NOT NULL
);

-- Free-text timing notes from the inquiry form ("mornings only", "flexible").
ALTER TABLE inquiries ADD COLUMN date_notes TEXT;
