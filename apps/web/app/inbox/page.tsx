"use client";

import { useEffect, useMemo, useState } from "react";
import type { ActionProposalView, ActionState } from "@platform/contracts";
import { ApprovalCard, useT, type MessageKey } from "@platform/ui";
import { api } from "../../lib/api";
import { notifyActionsChanged, useActions } from "../../lib/usePendingActions";
import { useSession } from "../../lib/useSession";
import { Header } from "../Header";
import { ScheduledChecks } from "./ScheduledChecks";

type Filter = "all" | "waiting" | "attention" | "done";

const FILTERS: { id: Filter; label: MessageKey; match: (s: ActionState) => boolean }[] = [
  { id: "all", label: "inbox.filter.all", match: () => true },
  { id: "waiting", label: "inbox.filter.waiting", match: (s) => s === "pending_approval" },
  { id: "attention", label: "inbox.filter.attention", match: (s) => s === "unknown" || s === "failed" },
  { id: "done", label: "inbox.filter.done", match: (s) => ["succeeded", "rejected", "expired", "cancelled"].includes(s) },
];

const BADGE: Record<string, { label: MessageKey; cls: string }> = {
  pending_approval: { label: "inbox.badge.pending_approval", cls: "bg-warn-bg text-warn-ink" },
  approved: { label: "inbox.badge.running", cls: "bg-ok-bg text-brand" },
  executing: { label: "inbox.badge.running", cls: "bg-ok-bg text-brand" },
  succeeded: { label: "inbox.badge.succeeded", cls: "bg-brand-soft text-brand" },
  failed: { label: "inbox.badge.failed", cls: "bg-surface text-danger border border-danger-line" },
  unknown: { label: "inbox.badge.unknown", cls: "bg-alert-bg text-alert-ink" },
  rejected: { label: "inbox.badge.rejected", cls: "bg-panel text-muted" },
  expired: { label: "inbox.badge.expired", cls: "bg-panel text-muted" },
  cancelled: { label: "inbox.badge.cancelled", cls: "bg-panel text-muted" },
};

const TERMINAL = new Set(["succeeded", "failed", "unknown", "rejected", "expired", "cancelled"]);

export default function InboxPage() {
  const { me, config, refresh } = useSession();
  const { t, when } = useT();
  const { actions, reload } = useActions(!!me);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [overrides, setOverrides] = useState<Record<string, ActionProposalView>>({});
  const [acting, setActing] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (me === null) window.location.href = "/";
  }, [me]);

  const all = useMemo(() => actions.map((a) => overrides[a.id] ?? a), [actions, overrides]);
  const visible = all.filter((a) => FILTERS.find((f) => f.id === filter)!.match(a.state));
  const selected = all.find((a) => a.id === selectedId) ?? visible[0];
  const waiting = all.filter((a) => a.state === "pending_approval").length;

  const poll = async (id: string) => {
    for (let i = 0; i < 60; i++) {
      const p = await api<ActionProposalView>(`/api/actions/${id}`);
      setOverrides((o) => ({ ...o, [id]: p }));
      if (TERMINAL.has(p.state)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    notifyActionsChanged();
    await reload();
  };

  const decide = async (p: ActionProposalView, approve: boolean) => {
    setActing(p.id);
    setError(undefined);
    try {
      const updated = approve
        ? await api<ActionProposalView>(`/api/actions/${p.id}/approve`, { method: "POST", body: { payloadHash: p.payloadHash } })
        : await api<ActionProposalView>(`/api/actions/${p.id}/reject`, { method: "POST" });
      setOverrides((o) => ({ ...o, [p.id]: updated }));
      notifyActionsChanged();
      if (approve) await poll(p.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(undefined);
    }
  };

  return (
    <>
      <Header me={me} config={config} onLogout={refresh} active="inbox" />
      <div className="mx-auto max-w-[1320px] px-6 py-7">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[26px] font-bold tracking-tight">{t("inbox.title")}</h1>
            <p className="mt-1 text-muted">
              {t("inbox.subtitle")}
              {waiting > 0 && t("inbox.waitingCount", { n: waiting })}
            </p>
          </div>
          <div role="group" aria-label={t("inbox.filter")} className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => {
                  setFilter(f.id);
                  setSelectedId(undefined);
                }}
                className={`min-h-10 cursor-pointer rounded-full border px-3.5 text-sm font-semibold ${filter === f.id ? "border-brand bg-brand text-on-brand" : "border-line-strong bg-transparent text-ink hover:bg-surface"}`}
              >
                {t(f.label)}
              </button>
            ))}
          </div>
        </div>

        {all.length === 0 ? (
          <div className="rounded-[16px] border border-dashed border-line-strong p-8 text-center text-muted">
            <p className="font-semibold text-ink-2">{t("inbox.emptyTitle")}</p>
            <p className="mt-1 text-[13.5px]">{t("inbox.emptyText")}</p>
          </div>
        ) : (
          <div className="flex flex-wrap items-start gap-4">
            <ul aria-label={t("inbox.proposals")} className="m-0 flex max-w-[460px] min-w-0 flex-[1_1_380px] flex-col gap-2 p-0">
              {visible.length === 0 && <li className="list-none rounded-xl border border-line bg-surface p-4 text-muted">{t("inbox.nothing")}</li>}
              {visible.map((a) => {
                const b = BADGE[a.state] ?? BADGE.pending_approval!;
                const isSel = selected?.id === a.id;
                return (
                  <li key={a.id} className="list-none">
                    <button
                      type="button"
                      aria-current={isSel ? "true" : undefined}
                      onClick={() => setSelectedId(a.id)}
                      className={`flex min-h-[72px] w-full cursor-pointer flex-col gap-1 rounded-[14px] bg-surface px-3.5 py-3 text-left text-ink ${isSel ? "border-2 border-brand" : "border border-line hover:border-line-strong"}`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-bold">{a.operation}</span>
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap ${b.cls}`}>{t(b.label)}</span>
                      </span>
                      <span className="text-[13px] text-muted">
                        {a.destination} · {when(a.createdAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {selected && (
              <section aria-label={t("inbox.selected")} className="min-w-0 flex-[999_1_560px] rounded-[16px] border border-line bg-surface p-6">
                <p className="text-[13px] text-muted">
                  {t("inbox.proposedBy", { when: when(selected.createdAt) })}
                  {selected.conversationId && (
                    <>
                      {" · "}
                      <a href={`/chat?c=${selected.conversationId}`} className="font-semibold">
                        {t("inbox.openConversation")}
                      </a>
                    </>
                  )}
                </p>
                <ApprovalCard proposal={selected} busy={acting === selected.id} onApprove={(p) => void decide(p, true)} onReject={(p) => void decide(p, false)} />
                {selected.state === "unknown" && (
                  <p className="mt-4 rounded-xl bg-alert-bg px-3.5 py-3 text-sm text-alert-ink">
                    {t("inbox.unknownNote")}
                  </p>
                )}
              </section>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {error}
          </p>
        )}
        {me && <ScheduledChecks onProposals={() => void reload()} />}
      </div>
    </>
  );
}
