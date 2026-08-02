import type { Prisma } from "@prisma/client";

export async function getDatabaseNow(
  database: Pick<Prisma.TransactionClient, "$queryRaw">,
): Promise<Date> {
  const [clock] = await database.$queryRaw<Array<{ policyNow: Date }>>`
    SELECT clock_timestamp() AS "policyNow"
  `;
  return clock.policyNow;
}
