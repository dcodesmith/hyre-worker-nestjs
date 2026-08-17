-- Restore relation constraints that may be absent in databases whose migration
-- history was reconciled before these foreign keys were applied.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'WhatsAppConversation_activeBookingDraftId_fkey'
      AND conrelid = '"WhatsAppConversation"'::regclass
  ) THEN
    ALTER TABLE "WhatsAppConversation"
    ADD CONSTRAINT "WhatsAppConversation_activeBookingDraftId_fkey"
    FOREIGN KEY ("activeBookingDraftId")
    REFERENCES "BookingDraft"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'BookingDraft_linkedBookingId_fkey'
      AND conrelid = '"BookingDraft"'::regclass
  ) THEN
    ALTER TABLE "BookingDraft"
    ADD CONSTRAINT "BookingDraft_linkedBookingId_fkey"
    FOREIGN KEY ("linkedBookingId")
    REFERENCES "Booking"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
  END IF;
END
$$;
