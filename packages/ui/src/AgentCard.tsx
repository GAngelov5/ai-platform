import type { AgentSummary } from "@platform/contracts";

export function AgentCard({ agent, href }: { agent: AgentSummary; href: string }) {
  return (
    <a
      href={href}
      className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold">{agent.name}</h3>
        <span className="font-mono text-xs text-slate-500">v{agent.version}</span>
      </div>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{agent.description}</p>
    </a>
  );
}
