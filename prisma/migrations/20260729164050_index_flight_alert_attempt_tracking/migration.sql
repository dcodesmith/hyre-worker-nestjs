CREATE INDEX CONCURRENTLY "Flight_alertEnabled_alertLastAttemptAt_idx"
ON "Flight"("alertEnabled", "alertLastAttemptAt");
