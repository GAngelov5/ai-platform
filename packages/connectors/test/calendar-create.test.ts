import { describe, expect, it } from "vitest";
import { CreateEventInput, describeWhen, normalizeEvent } from "../src/index.js";

describe("calendar.event.create input", () => {
  it("defaults a timed event to one hour in the deployment's time zone", () => {
    const e = normalizeEvent({ title: "Atlas review", start: "2026-11-03T14:00" }, "Europe/Sofia");
    expect(e).toMatchObject({ allDay: false, start: "2026-11-03T14:00", end: "2026-11-03T15:00", timeZone: "Europe/Sofia" });
    expect(describeWhen(e)).toBe("Tue 3 Nov 2026, 14:00–15:00 (Europe/Sofia)");
  });

  it("makes all-day events end-exclusive for Google, and shows the inclusive range", () => {
    const one = normalizeEvent({ title: "Offsite", start: "2026-12-31" }, "UTC");
    expect(one).toMatchObject({ allDay: true, end: "2027-01-01" });
    expect(describeWhen(one)).toBe("Thu 31 Dec 2026 (all day)");
    const three = normalizeEvent({ title: "Offsite", start: "2026-11-02", end: "2026-11-04" }, "UTC");
    expect(three.end).toBe("2026-11-05");
    expect(describeWhen(three)).toBe("Mon 2 Nov 2026 – Wed 4 Nov 2026 (all day)");
  });

  it("refuses impossible dates, an end before the start, mixed forms, bad zones and bad emails", () => {
    const bad = [
      { title: "x", start: "2026-02-30T10:00" },
      { title: "x", start: "2026-11-03T25:00" },
      { title: "x", start: "3 Nov" },
      { title: "x", start: "2026-11-03T10:00", end: "2026-11-03T09:00" },
      { title: "x", start: "2026-11-03", end: "2026-11-03T09:00" },
      { title: "x", start: "2026-11-03T10:00", timeZone: "Mars/Olympus" },
      { title: "x", start: "2026-11-03T10:00", attendees: ["not-an-email"] },
      { title: "x", start: "2026-11-01", end: "2026-12-15" },
      { title: "", start: "2026-11-03" },
      { title: "x", start: "2026-11-03", owner: "someone-else" },
    ];
    for (const b of bad) expect(() => normalizeEvent(b, "UTC"), JSON.stringify(b)).toThrow();
    expect(CreateEventInput.safeParse({ title: "x", start: "2026-11-03T10:00", timeZone: "America/New_York" }).success).toBe(true);
  });
});
