import { describe, expect, it } from "vitest";
import { partitionSyncRequests } from "../src/sync-requests.js";

describe("sync requests", () => {
  it("leaves requests for sources this worker doesn't know, and handles the rest", () => {
    const configured = [{ id: "team-share" }, { id: "company-handbook" }];
    expect(partitionSyncRequests(["notion", "team-share"], configured)).toEqual({ known: ["team-share"], unknown: ["notion"] });
    expect(partitionSyncRequests(["notion"], configured)).toEqual({ known: [], unknown: ["notion"] });
    expect(partitionSyncRequests([], configured)).toEqual({ known: [], unknown: [] });
  });
});
