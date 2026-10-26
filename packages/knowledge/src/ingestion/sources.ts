import { join } from "node:path";
import { FixtureSourceAdapter } from "./fixture-source.js";
import { FolderSourceAdapter } from "./folder-source.js";
import { AIRTABLE_GRANTED_GROUP, airtableBaseGroup, AirtableSourceAdapter } from "./airtable-source.js";
import { NOTION_SHARED_GROUP, NotionSourceAdapter } from "./notion-source.js";
import { SourcesConfigSchema, type SourceAdapter, type SourceConfig } from "./types.js";

/**
 * Default synthetic sources: the Atlas fixtures (two sources) and a folder
 * share with inherited permissions. Overridden by KNOWLEDGE_SOURCES (JSON).
 */
const notionNative = (i: number) => (i === 0 ? NOTION_SHARED_GROUP : `${NOTION_SHARED_GROUP}#${i}`);
const numbered = (group: string, i: number) => (i === 0 ? group : `${group}#${i}`);

export interface SourceOptions {
  includeEvalCorpus?: boolean;
  /** Adds the Notion source (ADR 0015): every page shared with the integration is readable by these groups. */
  notion?: { aclGroups: string[]; viaConnection?: boolean };
  /** Adds the Airtable source: every record of every granted base is readable by these groups (or the base's own). */
  airtable?: { aclGroups: string[]; baseAclGroups?: Record<string, string[]> };
}

export function defaultSources(fixturesRoot: string, opts: SourceOptions = {}): SourceConfig[] {
  const evalCorpus = opts.includeEvalCorpus
    ? [
        {
          id: "eval-corpus",
          title: "Evaluation corpus (synthetic)",
          kind: "folder",
          settings: { path: join(fixturesRoot, "sources", "eval-corpus") },
          aclMap: { "CORP\\Everyone": "all-staff", "CORP\\Project Teams": "atlas-team", "CORP\\Finance and Legal": "finance-legal" },
        },
      ]
    : [];
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
    ...evalCorpus,
    ...(opts.notion
      ? [
          {
            id: "notion",
            title: "Notion",
            kind: "notion",
            // Every shared page carries one native group per configured platform group.
            settings: {
              // "connection": the admin's "Connect Notion"; otherwise the NOTION_TOKEN integration secret.
              ...(opts.notion.viaConnection ? { tokenFrom: "connection" } : { tokenVar: "NOTION_TOKEN" }),
              nativeGroups: opts.notion.aclGroups.map((_, i) => notionNative(i)).join(","),
            },
            aclMap: Object.fromEntries(opts.notion.aclGroups.map((g, i) => [notionNative(i), g])),
          },
        ]
      : []),
    ...(opts.airtable ? [airtableSource(opts.airtable)] : []),
  ]);
}

/** The Airtable source (ADR 0015 addendum): always through the admin's "Connect Airtable". */
function airtableSource(a: NonNullable<SourceOptions["airtable"]>) {
  const bases = Object.entries(a.baseAclGroups ?? {});
  return {
    id: "airtable",
    title: "Airtable",
    kind: "airtable",
    settings: {
      tokenFrom: "connection",
      nativeGroups: a.aclGroups.map((_, i) => numbered(AIRTABLE_GRANTED_GROUP, i)).join(","),
      ...(bases.length ? { baseNativeGroups: JSON.stringify(Object.fromEntries(bases.map(([b, gs]) => [b, gs.map((_, i) => numbered(airtableBaseGroup(b), i))]))) } : {}),
    },
    aclMap: Object.fromEntries([
      ...a.aclGroups.map((g, i) => [numbered(AIRTABLE_GRANTED_GROUP, i), g]),
      ...bases.flatMap(([b, gs]) => gs.map((g, i) => [numbered(airtableBaseGroup(b), i), g])),
    ]),
  };
}

export function loadSources(json: string | undefined, fixturesRoot: string, opts: SourceOptions = {}): SourceConfig[] {
  return json ? SourcesConfigSchema.parse(JSON.parse(json)) : defaultSources(fixturesRoot, opts);
}

export function adapterFor(
  source: SourceConfig,
  opts: { secret?: (name: string) => string | undefined; notionConnection?: () => Promise<string | undefined>; airtableConnection?: () => Promise<string | undefined> } = {},
): SourceAdapter {
  if (source.kind === "airtable") {
    if (!opts.airtableConnection) throw new Error(`source ${source.id} needs the Airtable connection store`);
    return new AirtableSourceAdapter(opts.airtableConnection, {
      nativeGroups: source.settings.nativeGroups ? source.settings.nativeGroups.split(",") : undefined,
      baseNativeGroups: source.settings.baseNativeGroups ? (JSON.parse(source.settings.baseNativeGroups) as Record<string, string[]>) : undefined,
      // Tests only: a local fake of the Airtable API.
      baseUrl: source.settings.baseUrl,
    });
  }
  if (source.kind === "notion") {
    // The token is resolved by reference, never stored in source configuration.
    let token: string | (() => Promise<string | undefined>) | undefined;
    if (source.settings.tokenFrom === "connection") {
      token = opts.notionConnection;
      if (!token) throw new Error(`source ${source.id} needs the Notion connection store`);
    } else {
      const tokenVar = source.settings.tokenVar ?? "NOTION_TOKEN";
      token = (opts.secret ?? ((n) => process.env[n]))(tokenVar);
      if (!token) throw new Error(`source ${source.id} needs ${tokenVar}`);
    }
    return new NotionSourceAdapter(token, {
      nativeGroups: source.settings.nativeGroups ? source.settings.nativeGroups.split(",") : undefined,
      // Tests only: a local fake of the Notion API.
      baseUrl: source.settings.baseUrl,
    });
  }
  const path = source.settings.path;
  if (!path) throw new Error(`source ${source.id} needs settings.path`);
  switch (source.kind) {
    case "fixture":
      return new FixtureSourceAdapter(path, source.id);
    case "folder":
      return new FolderSourceAdapter(path, source.id);
  }
}
