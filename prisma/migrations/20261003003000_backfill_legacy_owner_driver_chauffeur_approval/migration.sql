-- Owner-drivers verified before manual face review was introduced could have a
-- successful fleet-owner verification while retaining the User default of
-- chauffeurApprovalStatus = PENDING. Grandfather only those legacy records
-- whose latest verification has a provider-approved, unexpired licence.
UPDATE "User" AS owner
SET
  "chauffeurApprovalStatus" = 'APPROVED',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE owner."isOwnerDriver" = true
  AND owner."fleetOwnerStatus" = 'APPROVED'
  AND owner."hasOnboarded" = true
  -- Never undo an explicit document-review rejection.
  AND owner."chauffeurApprovalStatus" = 'PENDING'
  AND EXISTS (
    SELECT 1
    FROM "FleetOwnerAccountVerification" AS verification
    WHERE verification."userId" = owner.id
      AND verification."isOwnerDriver" = true
      AND verification.status = 'SUCCEEDED'
      AND verification."driversLicenseDecision" = 'APPROVED'
      AND verification."driversLicenseProviderRef" IS NOT NULL
      AND verification."driversLicenseExpiresAt" > CURRENT_TIMESTAMP
      AND NOT EXISTS (
        SELECT 1
        FROM "FleetOwnerAccountVerification" AS newer_verification
        WHERE newer_verification."userId" = verification."userId"
          AND (
            newer_verification."createdAt" > verification."createdAt"
            OR (
              newer_verification."createdAt" = verification."createdAt"
              AND newer_verification.id > verification.id
            )
          )
      )
  );
