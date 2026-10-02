-- Only verified phone numbers are account identities. Abort without exposing
-- phone values if legacy verified duplicates need operational review.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    WHERE "phoneNumber" IS NOT NULL
      AND "phoneVerifiedAt" IS NOT NULL
    GROUP BY "phoneNumber"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce verified phone uniqueness: duplicate verified values require review'
      USING ERRCODE = '23505';
  END IF;
END
$$;

CREATE UNIQUE INDEX "User_verified_phoneNumber_key"
ON "User"("phoneNumber")
WHERE "phoneNumber" IS NOT NULL
  AND "phoneVerifiedAt" IS NOT NULL;
