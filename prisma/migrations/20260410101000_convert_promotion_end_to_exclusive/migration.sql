-- Existing promotions were stored with user-entered inclusive end dates at midnight.
-- Convert all historical rows to end-exclusive windows by adding one calendar day.
UPDATE "Promotion"
SET "endDate" = "endDate" + INTERVAL '1 day'
WHERE "endDate" > "startDate";
