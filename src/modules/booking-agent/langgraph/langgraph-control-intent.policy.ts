export function normalizeControlText(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replaceAll(/[^\w\s]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

export function isShortControlMessage(normalizedText: string): boolean {
  return normalizedText.split(" ").filter(Boolean).length <= 12;
}

export function isLikelyAffirmativeControl(normalizedText: string): boolean {
  if (!isShortControlMessage(normalizedText)) {
    return false;
  }

  const exactAffirmatives = new Set([
    "yes",
    "y",
    "yeah",
    "yep",
    "ok",
    "okay",
    "confirm",
    "confirmed",
    "book it",
    "go ahead",
    "proceed",
    "retry",
    "retry booking",
    "continue",
    "lets go",
    "that works",
    "sounds good",
  ]);

  if (exactAffirmatives.has(normalizedText)) {
    return true;
  }

  const phraseAffirmatives = [
    /\byes\b.*\b(please|go ahead|confirm|book|proceed|continue)\b/,
    /\b(ok|okay|alright)\b.*\b(confirm|book|go ahead|proceed|continue)\b/,
    /\b(please|kindly)\b.*\b(confirm|book|proceed|continue)\b/,
  ];

  return phraseAffirmatives.some((pattern) => pattern.test(normalizedText));
}

export function isLikelyNegativeControl(normalizedText: string): boolean {
  if (!isShortControlMessage(normalizedText)) {
    return false;
  }

  const exactNegatives = new Set([
    "no",
    "nope",
    "nah",
    "cancel",
    "not this one",
    "show others",
    "show me others",
    "different one",
  ]);

  if (exactNegatives.has(normalizedText)) {
    return true;
  }

  const phraseNegatives = [
    /\bno\b.*\b(show|another|different|other)\b/,
    /\b(show|give)\b.*\b(other|another|different)\b/,
    /\bnot\b.*\bthis one\b/,
  ];

  return phraseNegatives.some((pattern) => pattern.test(normalizedText));
}

export function isCancelIntentControl(normalizedText: string): boolean {
  const cancelSet = new Set(["cancel", "cancel booking", "never mind", "nevermind", "forget it"]);
  return cancelSet.has(normalizedText);
}

export function isAgentRequestControl(normalizedText: string): boolean {
  const agentSet = new Set(["agent", "talk to agent", "speak to agent", "human", "talk to human"]);
  return agentSet.has(normalizedText);
}
