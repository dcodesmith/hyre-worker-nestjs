-- Backfill: enforce "an approved car has every image and required document approved".
--
-- Some cars were force-approved (seed/legacy/admin) while images or documents were
-- still PENDING/REJECTED, so they leaked into public listings image-less. This demotes
-- any such car back to PENDING until an admin re-reviews it. Idempotent; safe to re-run.
--
-- Run: psql "$DATABASE_URL" -f prisma/backfills/2026-07-demote-cars-with-unapproved-docs.sql

UPDATE "Car" c
SET "approvalStatus" = 'PENDING'
WHERE c."approvalStatus" = 'APPROVED'
  AND (
    -- any image still pending/rejected
    EXISTS (SELECT 1 FROM "VehicleImage" vi WHERE vi."carId" = c.id AND vi.status <> 'APPROVED')
    -- any document still pending/rejected
    OR EXISTS (SELECT 1 FROM "DocumentApproval" da WHERE da."carId" = c.id AND da.status <> 'APPROVED')
    -- no approved image at all
    OR NOT EXISTS (SELECT 1 FROM "VehicleImage" vi WHERE vi."carId" = c.id AND vi.status = 'APPROVED')
    -- missing a required approved document type
    OR EXISTS (
      SELECT 1
      FROM unnest(ARRAY['MOT_CERTIFICATE', 'INSURANCE_CERTIFICATE']::"DocumentType"[]) AS required(type)
      WHERE NOT EXISTS (
        SELECT 1 FROM "DocumentApproval" da
        WHERE da."carId" = c.id AND da.status = 'APPROVED' AND da."documentType" = required.type
      )
    )
  );
