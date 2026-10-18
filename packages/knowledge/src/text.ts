const STOPWORDS = new Set(
  ("a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our so than that the their them then there these they this to was we were what when where " +
    "which who why will with would you your about after again all also any because before being both each few " +
    "more most other over same should some such only own just very not no nor now out up down off once here").split(" "),
);

/** Very small English stemmer: enough for deterministic fixture retrieval, not a production analyzer. */
export function stem(word: string): string {
  let w = word;
  for (const suf of ["ations", "ation", "ings", "ing", "ied", "ies", "ed", "es", "s"]) {
    if (w.length > suf.length + 2 && w.endsWith(suf)) {
      w = w.slice(0, -suf.length);
      break;
    }
  }
  return w;
}

export function terms(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
