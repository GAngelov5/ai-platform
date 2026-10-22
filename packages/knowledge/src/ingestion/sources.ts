import { join } from "node:path";
import { FixtureSourceAdapter } from "./fixture-source.js";
import { FolderSourceAdapter } from "./folder-source.js";
import { SourcesConfigSchema, type SourceAdapter, type SourceConfig } from "./types.js";

/**
 * Default synthetic sources: the Atlas fixtures (two sources) and a folder
 * share with inherited permissions. Overridden by KNOWLEDGE_SOURCES (JSON).
 */
export function defaultSources(fixturesRoot: string): SourceConfig[] {
  return SourcesConfigSchema.parse([
    { id: "atlas-project-docs", title: "Atlas project documents", kind: "fixture", settings: { path: join(fixturesRoot, "documents") }, aclPassThrough: true, prefixDocumentIds: false },
    { id: "company-handbook", title: "Company handbook", kind: "fixture", settings: { path: join(fixturesRoot, "documents") }, aclPassThrough: true, prefixDocumentIds: false },
    {
      id: "team-share",
      title: "Team file share",
      kind: "folder",
      settings: { path: join(fixturesRoot, "sources", "team-share") },
      aclMap: { "SHARE\\All Staff": "all-staff", "SHARE\\Atlas": "atlas-team", "SHARE\\Legal": "finance-legal" },
    },
  ]);
}

export function loadSources(json: string | undefined, fixturesRoot: string): SourceConfig[] {
  return json ? SourcesConfigSchema.parse(JSON.parse(json)) : defaultSources(fixturesRoot);
}

export function adapterFor(source: SourceConfig): SourceAdapter {
  const path = source.settings.path;
  if (!path) throw new Error(`source ${source.id} needs settings.path`);
  switch (source.kind) {
    case "fixture":
      return new FixtureSourceAdapter(path, source.id);
    case "folder":
      return new FolderSourceAdapter(path, source.id);
  }
}
