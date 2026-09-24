ALTER TABLE "ChauffeurVerification" ADD COLUMN "firstName" TEXT;
ALTER TABLE "ChauffeurVerification" ADD COLUMN "lastName" TEXT;

UPDATE "ChauffeurVerification"
SET
  "firstName" = split_part("name", ' ', 1),
  "lastName" = CASE
    WHEN strpos(btrim("name"), ' ') = 0 THEN ''
    ELSE regexp_replace("name", '^.* ', '')
  END;

ALTER TABLE "ChauffeurVerification" ALTER COLUMN "firstName" SET NOT NULL;
ALTER TABLE "ChauffeurVerification" ALTER COLUMN "lastName" SET NOT NULL;
