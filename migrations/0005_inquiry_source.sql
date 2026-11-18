-- Where an inquiry came from: a tagged link (?from=instagram), the referring site, or Direct.
ALTER TABLE inquiries ADD COLUMN came_from TEXT;
ALTER TABLE inquiries ADD COLUMN referrer_host TEXT;
