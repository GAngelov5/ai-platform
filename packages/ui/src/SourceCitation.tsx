import type { Citation } from "@platform/contracts";

export interface SourceCitationProps {
  index: number;
  citation: Citation;
  /** Link to the protected document view; access is re-checked server-side. */
  href: string;
}

/** Title, version/date and authorized excerpt for one citation. */
export function SourceCitation({ index, citation, href }: SourceCitationProps) {
  const indexed = new Date(citation.indexedAt);
  return (
    <li className="rounded-md border border-slate-200 bg-white p-3 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-xs text-slate-500">[{index}]</span>
        <a className="font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300" href={href}>
          {citation.title}
        </a>
        <span className="text-xs text-slate-500">
          version {citation.version} · indexed {indexed.toISOString().slice(0, 10)}
          {citation.location ? ` · ${citation.location}` : ""}
        </span>
      </div>
      <blockquote className="mt-2 border-l-2 border-slate-300 pl-3 text-slate-700 dark:border-slate-600 dark:text-slate-300">
        {citation.excerpt.length > 320 ? `${citation.excerpt.slice(0, 320)}…` : citation.excerpt}
      </blockquote>
    </li>
  );
}
