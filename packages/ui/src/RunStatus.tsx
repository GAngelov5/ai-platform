import type { ToolCallSummary } from "@platform/contracts";

const LABEL: Record<string, string> = {
  "knowledge.search": "Searched documents",
  "tracker.tasks.list": "Listed live tracker tasks",
  "tracker.task.status": "Read live task status",
  "tracker.task.comment": "Prepared a comment proposal",
};

/** Which capabilities the router used in a run, with outcome and duration. */
export function RunStatus({ calls, running }: { calls: (ToolCallSummary | { capabilityId: string; status: "running" })[]; running?: boolean }) {
  if (!calls.length && !running) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-1.5 text-xs" aria-label="Tools used">
      {calls.map((c, i) => (
        <li
          key={i}
          className={`rounded-full border px-2 py-0.5 ${c.status === "ok" ? "border-emerald-300 text-emerald-800 dark:text-emerald-300" : c.status === "running" ? "border-blue-300 text-blue-800 dark:text-blue-300" : "border-red-300 text-red-800 dark:text-red-300"}`}
        >
          {LABEL[c.capabilityId] ?? c.capabilityId}
          {"durationMs" in c ? ` · ${(c.durationMs / 1000).toFixed(1)}s` : " …"}
          {c.status !== "ok" && c.status !== "running" ? ` · ${c.status}` : ""}
        </li>
      ))}
    </ul>
  );
}
