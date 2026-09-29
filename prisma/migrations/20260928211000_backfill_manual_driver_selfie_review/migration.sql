INSERT INTO "VerificationIntervention" (
  "id",
  "resourceKey",
  "kind",
  "chauffeurVerificationId",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid(),
  'chauffeur-face:' || verification."id",
  'CHAUFFEUR_FACE',
  verification."id",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "ChauffeurVerification" verification
WHERE verification."status" <> 'APPROVED'
  AND verification."faceDecision" = 'PENDING'
  AND verification."selfieObjectKey" IS NOT NULL
ON CONFLICT ("resourceKey") DO NOTHING;

UPDATE "ChauffeurVerification"
SET "selfieRetakeRequired" = true
WHERE "status" <> 'APPROVED'
  AND "faceDecision" = 'PENDING'
  AND "selfieObjectKey" IS NULL
  AND "driversLicenseHash" IS NOT NULL;

UPDATE "FleetOwnerAccountVerification"
SET "faceDecision" = 'APPROVED'
WHERE "status" = 'SUCCEEDED'
  AND "isOwnerDriver" = true;

UPDATE "FleetOwnerAccountVerification"
SET "selfieRetakeRequired" = true
WHERE "status" IN ('DRAFT', 'REVIEW_REQUIRED')
  AND "isOwnerDriver" = true
  AND "faceDecision" = 'PENDING'
  AND "selfieObjectKey" IS NULL;
