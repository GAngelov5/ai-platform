"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowView } from "@platform/contracts";
import { useT, type MessageKey } from "@platform/ui";
import { api, ApiRequestError } from "../../lib/api";
import { notifyActionsChanged } from "../../lib/usePendingActions";

const INTERVALS: { minutes: number; label: MessageKey }[] = [
  { minutes: 15, label: "checks.every15" },
  { minutes: 60, label: "checks.every60" },
  { minutes: 24 * 60, label: "checks.every1440" },
];

const RUN_BADGE: Record<string, string> = {
  succeeded: "bg-brand-soft text-brand",
  failed: "bg-surface text-danger border border-danger-line",
  running: "bg-ok-bg text-brand",
  pending: "bg-panel text-muted",
};

/**
 * Scheduled tracker checks (ADR 0011). A check runs in the worker with your
 * current permissions; any comment it wants to post arrives above as an
 * approval, never as a direct write.
 */
export function ScheduledChecks({ onProposals }: { onProposals: () => void }) {
  const { t, tm, when } = useT();
  const every = (m: number) => {
    const i = INTERVALS.find((x) => x.minutes === m);
    return i ? t(i.label).toLowerCase() : t("checks.everyN", { n: m });
  };
  const [items, setItems] = useState<WorkflowView[]>();
  const [project, setProject] = useState("ATLAS");
  const [interval, setInterval_] = useState(60);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const onProposalsRef = useRef(onProposals);
  onProposalsRef.current = onProposals;

  const load = useCallback(async () => {
    try {
      setItems(await api<WorkflowView[]>("/api/workflows"));
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      void load();
      // New proposals from a background run appear in the approvals list without a reload.
      onProposalsRef.current();
      notifyActionsChanged();
    }, 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(undefined);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiRequestError && e.status === 404 ? t("checks.noAccess") : (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section aria-labelledby="checks-h" className="mt-10">
      <h2 id="checks-h" className="text-[20px] font-bold tracking-tight">
        {t("checks.title")}
      </h2>
      <p className="mt-1 text-muted">{t("checks.subtitle")}</p>

      <form
        className="mt-4 flex flex-wrap items-end gap-3 rounded-[14px] border border-line bg-surface p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void act("create", () => api("/api/workflows", { method: "POST", body: { kind: "tracker-status-check", config: { project }, intervalMinutes: interval } }));
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {t("checks.project")}
          <input
            value={project}
            onChange={(e) => setProject(e.target.value.toUpperCase())}
            pattern="[A-Za-z]{2,32}"
            required
            className="min-h-10 w-40 rounded-lg border border-line-strong bg-panel px-3 font-normal"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {t("checks.howOften")}
          <select value={interval} onChange={(e) => setInterval_(Number(e.target.value))} className="min-h-10 rounded-lg border border-line-strong bg-panel px-3 font-normal">
            {INTERVALS.map((i) => (
              <option key={i.minutes} value={i.minutes}>
                {t(i.label)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy === "create"} className="min-h-10 cursor-pointer rounded-full bg-brand px-4 text-sm font-semibold text-on-brand disabled:opacity-60">
          {t("checks.add")}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}

      <ul aria-label={t("checks.title")} className="m-0 mt-4 flex flex-col gap-2 p-0">
        {items?.length === 0 && <li className="list-none rounded-xl border border-dashed border-line-strong p-4 text-muted">{t("checks.empty")}</li>}
        {items?.map((w) => {
          const proposals = (w.lastRun?.result?.proposals as unknown[] | undefined)?.length ?? 0;
          return (
            <li key={w.id} className="flex list-none flex-wrap items-center justify-between gap-3 rounded-[14px] border border-line bg-surface px-4 py-3">
              <div className="min-w-0">
                <p className="font-bold">{w.kind === "tracker-status-check" ? t("checks.kindTitle", { project: String(w.config.project ?? "").toUpperCase() }) : w.title}</p>
                <p className="text-[13px] text-muted">
                  {w.enabled ? t("checks.runs", { every: every(w.intervalMinutes), when: when(w.nextRunAt) }) : t("checks.paused")}
                  {w.lastRun && (
                    <>
                      {t("checks.lastRun")}
                      <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${RUN_BADGE[w.lastRun.status] ?? RUN_BADGE.pending}`}>{tm(`run.${w.lastRun.status}`, w.lastRun.status)}</span>
                      {w.lastRun.status === "succeeded" && (proposals === 1 ? t("checks.newProposal1") : t("checks.newProposalN", { n: proposals }))}
                      {w.lastRun.error && ` · ${w.lastRun.error}`}
                    </>
                  )}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void act(w.id, () => api(`/api/workflows/${w.id}/run-now`, { method: "POST" }))}
                  className="min-h-10 cursor-pointer rounded-full border border-line-strong px-3.5 text-sm font-semibold hover:bg-panel disabled:opacity-60"
                >
                  {t("checks.runNow")}
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void act(w.id, () => api(`/api/workflows/${w.id}/${w.enabled ? "pause" : "resume"}`, { method: "POST" }))}
                  className="min-h-10 cursor-pointer rounded-full border border-line-strong px-3.5 text-sm font-semibold hover:bg-panel disabled:opacity-60"
                >
                  {w.enabled ? t("checks.pause") : t("checks.resume")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
