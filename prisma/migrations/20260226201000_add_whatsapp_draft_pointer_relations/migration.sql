-- AddForeignKey
ALTER TABLE "WhatsAppConversation"
ADD CONSTRAINT "WhatsAppConversation_activeBookingDraftId_fkey"
FOREIGN KEY ("activeBookingDraftId")
REFERENCES "BookingDraft"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingDraft"
ADD CONSTRAINT "BookingDraft_linkedBookingId_fkey"
FOREIGN KEY ("linkedBookingId")
REFERENCES "Booking"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
