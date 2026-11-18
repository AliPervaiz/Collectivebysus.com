-- Simplify session stages to five: Inquiry, Booked, Editing, Done, Archived.
-- Shot -> Editing, Delivered -> Done, Lost -> Archived. (The CHECK constraint still
-- allows the old values, so older rows or integrations can't break anything.)
UPDATE sessions SET status = 'editing'  WHERE status = 'shot';
UPDATE sessions SET status = 'done'     WHERE status = 'delivered';
UPDATE sessions SET status = 'archived' WHERE status = 'lost';
