import type { Citation } from "@platform/contracts";
import { localeOf, useT } from "./i18n.js";

export interface SourceCitationProps {
  index: number;
  citation: Citation;
  /** Link to the protected document view (documents only); access is re-checked server-side. */
  href?: string;
  /** Compact form for the context panel. */
  compact?: boolean;
}

const time = (iso: string) => new Date(iso).toISOString().slice(11, 16);


/** One cited source: live reads show their read time, documents their version and index date. */
export function SourceCitation({ index, citation, href, compact }: SourceCitationProps) {
  const { t, lang } = useT();
  const date = (iso: string) => new Date(iso).toLocaleDateString(localeOf(lang), { day: "numeric", month: "short", year: "numeric" });
  const live = citation.kind === "live";
  const excerpt = citation.excerpt.length > 260 ? `${citation.excerpt.slice(0, 260)}…` : citation.excerpt;
  return (
    <li className="list-none rounded-xl border border-line bg-surface px-3.5 py-3 text-[13.5px]">
      <div className={`mb-1 text-xs font-bold ${live ? "text-live" : "text-muted"}`}>
        [{index}] {live ? t("citation.live", { time: time(citation.readAt) }) : t("citation.document", { date: date(citation.indexedAt) })}
      </div>
      {live ? (
        <>
          <div className="font-semibold">
            {citation.resourceId} · {citation.title}
          </div>
          <div className="text-[13px] text-muted">{citation.connectorId}</div>
        </>
      ) : (
        <>
          <a className="font-semibold" href={href}>
            {citation.title}
          </a>
          <div className="text-[13px] text-muted">
            {t("citation.version", { v: citation.version })}
            {citation.location ? ` · ${citation.location}` : ""}
          </div>
        </>
      )}
      {!compact && <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-ink-2">{excerpt}</blockquote>}
    </li>
  );
}
