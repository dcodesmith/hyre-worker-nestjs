export const MINIMUM_CHAUFFEUR_AGE = 21;

export function meetsMinimumChauffeurAge(dateOfBirth: Date, today = new Date()): boolean {
  const cutoff = new Date(
    Date.UTC(
      today.getUTCFullYear() - MINIMUM_CHAUFFEUR_AGE,
      today.getUTCMonth(),
      today.getUTCDate(),
    ),
  );
  return dateOfBirth <= cutoff;
}
