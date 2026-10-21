import type { AgentSummary } from "@platform/contracts";

export function AgentCard({ agent, href, active }: { agent: AgentSummary; href: string; active?: boolean }) {
  return (
    <a href={href} className={`block rounded-xl px-3 py-2.5 !text-ink no-underline ${active ? "bg-surface" : "hover:bg-surface/60"}`}>
      <span className="block font-semibold">{agent.name}</span>
      <span className="block text-xs text-muted">{agent.description.length > 60 ? `${agent.description.slice(0, 58)}…` : agent.description}</span>
    </a>
  );
}
