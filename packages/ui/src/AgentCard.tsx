import type { AgentSummary } from "@platform/contracts";
import { useT } from "./i18n.js";

export function AgentCard({ agent, href, active }: { agent: AgentSummary; href: string; active?: boolean }) {
  const { lang } = useT();
  const { name, description } = agent.localized?.[lang] ?? agent;
  return (
    <a href={href} className={`block rounded-xl px-3 py-2.5 !text-ink no-underline ${active ? "bg-surface" : "hover:bg-surface/60"}`}>
      <span className="block font-semibold">{name}</span>
      <span className="block text-xs text-muted">{description.length > 60 ? `${description.slice(0, 58)}…` : description}</span>
    </a>
  );
}
