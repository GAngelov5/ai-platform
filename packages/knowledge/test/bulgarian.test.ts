import { describe, expect, it } from "vitest";
import { IdSchema } from "@platform/contracts";
import { detectLanguage, documentIdFor, SourceConfigSchema, stemBg, terms } from "../src/index.js";

describe("Bulgarian text", () => {
  it("tokenizes Cyrillic (it used to produce no terms at all)", () => {
    expect(terms("Защо се забави проектът Атлас?")).toEqual(["забав", "проект", "атлас"]);
    expect(terms("Сертифицирането на API на Northwind")).toEqual(["сертифициран", "api", "northwind"]);
  });

  it("stems articles and plurals to one form", () => {
    for (const family of [
      ["проект", "проектът", "проекта", "проекти", "проектите"],
      ["сметка", "сметката", "сметки", "сметките"],
      ["служител", "служителят", "служители", "служителите"],
      ["договор", "договорът", "договори", "договорите"],
    ]) {
      expect(new Set(family.map(stemBg)).size, family.join(",")).toBe(1);
    }
    expect(stemBg("проекта")).toBe("проект"); // short masculine article, not feminine "-та"
    expect(stemBg("дни")).toBe("дни"); // never below three letters
  });

  it("drops Bulgarian stopwords and folds й consistently in documents and questions", () => {
    expect(terms("и в на за от се не да")).toEqual([]);
    expect(terms("Колко дни платен годишен отпуск")).toEqual(terms("колко дни платен годишен отпуск"));
    expect(terms("край")).toEqual(terms("КРАЙ"));
  });

  it("leaves English terms exactly as before", () => {
    expect(terms("Why was Project Atlas delayed? Café")).toEqual(["project", "atla", "delay", "cafe"]);
  });

  it("detects the question's language", () => {
    expect(detectLanguage("Защо се забави проектът Атлас?")).toBe("bg");
    expect(detectLanguage("Какъв е статусът на ATLAS-180?")).toBe("bg");
    expect(detectLanguage("Why was Project Atlas delayed?")).toBe("en");
    expect(detectLanguage("1234")).toBe("en");
  });
});

describe("document IDs for Cyrillic file names", () => {
  const src = SourceConfigSchema.parse({ id: "team-share", title: "Team share", kind: "folder" });

  it("are readable, valid and never collide", () => {
    const a = documentIdFor(src, "handbook/отпуски.md");
    const b = documentIdFor(src, "handbook/договор.md");
    const c = documentIdFor(src, "handbook/договори.md");
    expect(a).toMatch(/^team-share:handbook_otpuski\.md--[0-9a-f]{8}$/);
    expect(new Set([a, b, c]).size).toBe(3);
    for (const id of [a, b, c, documentIdFor(src, `${"дълго-име/".repeat(30)}файл.md`)]) expect(IdSchema.safeParse(id).success, id).toBe(true);
  });

  it("keep ASCII names unchanged", () => {
    expect(documentIdFor(src, "atlas/vendor-contacts.md")).toBe("team-share:atlas_vendor-contacts.md");
  });
});
