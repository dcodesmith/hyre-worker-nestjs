-- A duplicated verified number cannot safely identify one account. Preserve
-- every phone value and user row, but require all affected accounts to verify
-- ownership again before the uniqueness constraint is enforced.
UPDATE "User" AS users
SET
  "phoneVerifiedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
FROM (
  SELECT "phoneNumber"
  FROM "User"
  WHERE "phoneNumber" IS NOT NULL
    AND "phoneVerifiedAt" IS NOT NULL
  GROUP BY "phoneNumber"
  HAVING COUNT(*) > 1
) AS duplicates
WHERE users."phoneNumber" = duplicates."phoneNumber"
  AND users."phoneVerifiedAt" IS NOT NULL;

CREATE UNIQUE INDEX "User_verified_phoneNumber_key"
ON "User"("phoneNumber")
WHERE "phoneNumber" IS NOT NULL
  AND "phoneVerifiedAt" IS NOT NULL;
