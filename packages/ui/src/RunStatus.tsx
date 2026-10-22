import type { ToolCallSummary } from "@platform/contracts";
import { useT } from "./i18n.js";

/** One quiet line describing which capabilities the router used. */
export function RunStatus({ calls, running, model }: { calls: (ToolCallSummary | { capabilityId: string; status: "running" })[]; running?: boolean; model?: string }) {
  const { t, tm } = useT();
  if (!calls.length && !running && !model) return null;
  const seen = new Set<string>();
  const parts = calls
    .filter((c) => (seen.has(c.capabilityId) ? false : (seen.add(c.capabilityId), true)))
    .map((c) => {
      const label = tm(`tool.${c.capabilityId}`, c.capabilityId);
      if (c.status === "running") return `${label}…`;
      if (c.status !== "ok") return `${label} (${c.status})`;
      return label;
    });
  if (model) parts.push(model);
  const text = parts.join(" · ");
  return (
    <p className="mb-3 text-[12.5px] text-muted" aria-label={t("tool.used")}>
      {text.charAt(0).toUpperCase() + text.slice(1)}
    </p>
  );
}
