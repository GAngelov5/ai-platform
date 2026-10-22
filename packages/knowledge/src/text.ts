const STOPWORDS = new Set(
  ("a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our so than that the their them then there these they this to was we were what when where " +
    "which who why will with would you your about after again all also any because before being both each few " +
    "more most other over same should some such only own just very not no nor now out up down off once here").split(" "),
);

// Bulgarian function words (after the same normalization as tokens: й → и, lower case).
const STOPWORDS_BG = new Set(
  ("и в във на за с със от до по при към като че да се не ли са съм си сме сте бе беше бяха ще би но а или то той тя те ние вие аз ти " +
    "го ги му им ни ви ми ми този тази това тези онзи онази онова които който която което какво какъв каква какви кои кое коя кои " +
    "кога къде как защо колко има няма също още само вече много след преди между над под без през чрез около ако когато докато " +
    "мои моя моят наш наша наши техен техни свои своя всеки всяка всички нещо нищо тук там сега днес")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(" "),
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

// Applied in order, at most one ending per step, always keeping a stem of at
// least three letters (after й → и).
const BG_ARTICLES = ["ията", "ието", "ите", "ата", "ото", "ият", "ът", "ят"];
const BG_SHORT_ARTICLES = ["та", "то", "те"]; // only after a vowel: жена-та, място-то, дете-то (not проек-та)
const BG_PLURALS = ["ища", "ище", "ове", "еве", "и"];
const BG_FINAL_VOWELS = ["а", "я", "о", "е", "и"];
const VOWEL = /[аеиоуъюя]$/;

/**
 * Light Bulgarian stemmer in the spirit of Lucene's BulgarianStemmer: removes
 * a definite article, then a plural ending, then a final vowel. Enough to match
 * проектът / проекта / проекти / проектите, or сметката / сметки; not a full
 * morphological analyzer.
 */
export function stemBg(word: string): string {
  const strip = (w: string, endings: readonly string[], cond: (stem: string) => boolean = () => true) => {
    for (const e of endings) {
      const stem = w.slice(0, -e.length);
      if (w.endsWith(e) && stem.length >= 3 && cond(stem)) return { w: stem, done: true };
    }
    return { w, done: false };
  };
  let r = strip(word, BG_ARTICLES);
  if (!r.done) r = strip(word, BG_SHORT_ARTICLES, (stem) => VOWEL.test(stem));
  const p = strip(r.w, BG_PLURALS);
  return strip(p.w, BG_FINAL_VOWELS).w;
}

const CYRILLIC = /[\u0400-\u04ff]/;

/**
 * Search terms in any script: lower case, accents and other combining marks
 * removed (é → e, й → и; the same for documents and questions), letters and
 * digits kept. Stopwords and stemming per language: Cyrillic tokens use the
 * Bulgarian rules, everything else the English ones.
 */
export function terms(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
    .filter((t) => t.length > 1 && !(CYRILLIC.test(t) ? STOPWORDS_BG : STOPWORDS).has(t))
    .map((t) => (CYRILLIC.test(t) ? stemBg(t) : stem(t)));
}

/** "bg" when most letters are Cyrillic, otherwise "en". Used to answer in the question's language. */
export function detectLanguage(text: string): "bg" | "en" {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return "en";
  const cyr = letters.filter((c) => CYRILLIC.test(c)).length;
  return cyr / letters.length >= 0.5 ? "bg" : "en";
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
