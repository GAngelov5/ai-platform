import type { Citation } from "@platform/contracts";
import { SourceCitation } from "./SourceCitation.js";
import { useT } from "./i18n.js";

export interface ConnectionSummary {
  name: string;
  /** e.g. "search", "read · writes need approval" */
  access: string;
  href?: string;
  actionLabel?: string;
}

export interface ContextPanelProps {
  citations: Citation[];
  connections: ConnectionSummary[];
  documentHref: (c: Citation) => string | undefined;
  manageHref: string;
  /** Optional call to action, e.g. connect a personal account. */
  prompt?: { text: string; href: string; label: string };
}

/** "Context for this answer": the sources the answer used and the connections available to the user. */
export function ContextPanel({ citations, connections, documentHref, manageHref, prompt }: ContextPanelProps) {
  const { t } = useT();
  return (
    <aside aria-label={t("context.title")} className="flex flex-col gap-3.5">
      <h2 className="text-[13px] font-bold text-ink-2">{t("context.title")}</h2>
      {citations.length ? (
        <ol className="m-0 flex flex-col gap-2.5 p-0">
          {citations.map((c, i) => (
            <SourceCitation key={c.evidenceId} index={i + 1} citation={c} href={documentHref(c)} compact />
          ))}
        </ol>
      ) : (
        <p className="text-[13px] text-muted">{t("context.empty")}</p>
      )}
      <div className="border-t border-line pt-3.5">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[13px] font-bold text-ink-2">{t("context.connections")}</span>
          <a href={manageHref} className="text-[13px]">
            {t("context.manage")}
          </a>
        </div>
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
          {connections.map((c) => (
            <li key={c.name} className="flex justify-between gap-2">
              <span>{c.name}</span>
              {c.href ? <a href={c.href}>{c.actionLabel ?? c.access}</a> : <span className="text-right text-muted">{c.access}</span>}
            </li>
          ))}
        </ul>
      </div>
      {prompt && (
        <div className="rounded-xl bg-brand-soft px-3.5 py-3 text-[13px] text-brand">
          {prompt.text}
          <a href={prompt.href} className="mt-1.5 block font-bold">
            {prompt.label}
          </a>
        </div>
      )}
    </aside>
  );
}
