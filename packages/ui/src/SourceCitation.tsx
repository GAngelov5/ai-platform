import type { Citation } from "@platform/contracts";

export interface SourceCitationProps {
  index: number;
  citation: Citation;
  /** Link to the protected document view (documents only); access is re-checked server-side. */
  href?: string;
}

/** Title, version/date or live read time, and the authorized excerpt for one citation. */
export function SourceCitation({ index, citation, href }: SourceCitationProps) {
  const live = citation.kind === "live";
  const excerpt = citation.excerpt.length > 320 ? `${citation.excerpt.slice(0, 320)}…` : citation.excerpt;
  return (
    <li className="rounded-md border border-slate-200 bg-white p-3 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-xs text-slate-500">[{index}]</span>
        {live ? (
          <>
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
              live
            </span>
            <span className="font-medium">
              {citation.resourceId} · {citation.title}
            </span>
            <span className="text-xs text-slate-500">
              {citation.connectorId} · read {new Date(citation.readAt).toISOString().replace("T", " ").slice(0, 16)} UTC
            </span>
          </>
        ) : (
          <>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-300">
              document
            </span>
            <a className="font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300" href={href}>
              {citation.title}
            </a>
            <span className="text-xs text-slate-500">
              version {citation.version} · indexed {new Date(citation.indexedAt).toISOString().slice(0, 10)}
              {citation.location ? ` · ${citation.location}` : ""}
            </span>
          </>
        )}
      </div>
      <blockquote className="mt-2 border-l-2 border-slate-300 pl-3 text-slate-700 dark:border-slate-600 dark:text-slate-300">{excerpt}</blockquote>
    </li>
  );
}
