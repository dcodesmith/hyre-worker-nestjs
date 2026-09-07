const LETTER_PATTERN = /[a-z]/g;
const VOWEL_PATTERN = /[aeiou]/i;
const REPEATED_CHAR_PATTERN = /(.)\1{5,}/;
const REPEATED_TOKEN_PATTERN = /^(\S+)(?:\s+\1){4,}$/;

function lettersOnly(value: string): string {
  return (value.toLowerCase().match(LETTER_PATTERN) ?? []).join("");
}

/**
 * Cheap pre-LLM filter for keyboard smash / nonsense. Does not try to detect
 * abuse or slang — those need conversational context from the extractor.
 */
export function isLikelyGibberish(message: string): boolean {
  const normalized = message.trim();
  if (normalized.length < 6) {
    return false;
  }

  if (REPEATED_CHAR_PATTERN.test(normalized) || REPEATED_TOKEN_PATTERN.test(normalized)) {
    return true;
  }

  const letters = lettersOnly(normalized);
  if (letters.length < 8) {
    return false;
  }

  return !VOWEL_PATTERN.test(letters);
}
