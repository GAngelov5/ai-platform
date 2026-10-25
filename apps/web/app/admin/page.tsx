"use client";

import { useCallback, useEffect, useState } from "react";
import { useT, type MessageKey } from "@platform/ui";
import { api, ApiRequestError } from "../../lib/api";
import { useSession } from "../../lib/useSession";
import { Header } from "../Header";

/* eslint-disable @typescript-eslint/no-explicit-any -- admin read models are display-only */
type Tab = "overview" | "sources" | "integrations" | "agents" | "actions" | "workflows" | "audit";
const TABS: Tab[] = ["overview", "sources", "integrations", "agents", "actions", "workflows", "audit"];
const Pill = ({ tone, children }: { tone: "ok" | "warn" | "alert" | "muted" | "danger"; children: React.ReactNode }) => {
  const cls = {
    ok: "bg-brand-soft text-brand",
    warn: "bg-warn-bg text-warn-ink",
    alert: "bg-alert-bg text-alert-ink",
    muted: "bg-panel text-muted",
    danger: "bg-surface text-danger border border-danger-line",
  }[tone];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap ${cls}`}>{children}</span>;
};
const Health = ({ h }: { h?: { ok: boolean; detail?: string } }) => {
  const { t } = useT();
  return h ? <Pill tone={h.ok ? "ok" : "danger"}>{h.ok ? t("admin.healthy") : t("admin.down")}</Pill> : <Pill tone="muted">…</Pill>;
};

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty?: string }) {
  const { t } = useT();
  return (
    <div className="overflow-x-auto rounded-[14px] border border-line bg-surface">
      <table className="w-full min-w-[640px] border-collapse text-left text-[13.5px]">
        <thead>
          <tr className="border-b border-line text-xs text-muted uppercase">
            {head.map((h) => (
              <th key={h} className="px-3.5 py-2.5 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={head.length} className="px-3.5 py-4 text-muted">
                {empty ?? t("common.nothing")}
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0 align-top">
                {r.map((c, j) => (
                  <td key={j} className="px-3.5 py-2.5">
                    {c}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "warn" | "alert" }) {
  return (
    <div className={`rounded-[14px] border p-4 ${tone === "alert" ? "border-alert-line bg-alert-bg" : tone === "warn" ? "border-warn-line bg-warn-bg" : "border-line bg-surface"}`}>
      <p className="text-xs font-semibold text-muted uppercase">{label}</p>
      <p className="mt-1 text-[22px] font-bold">{value}</p>
    </div>
  );
}

function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(undefined);
    } catch (e) {
      setError(e instanceof ApiRequestError && e.status === 404 ? "no-access" : (e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, reload: load };
}

/** Error text; "no-access" (a 404 from the admin API) is translated. */
function ErrorText({ error }: { error: string }) {
  const { t } = useT();
  return <p className="text-danger">{error === "no-access" ? t("admin.noAccess") : error}</p>;
}

function Overview() {
  const { t, tm } = useT();
  const { data: o, error } = useLoad<any>("/api/admin/overview");
  if (error) return <ErrorText error={error} />;
  if (!o) return <p className="text-muted">{t("common.loading")}</p>;
  return (
    <div className="flex flex-col gap-6">
      {o.licence && <LicenceNotice l={o.licence} />}
      <section aria-label={t("admin.services")}>
        <h2 className="mb-2 text-[17px] font-bold">{t("admin.services")}</h2>
        <Table
          head={[t("admin.col.service"), t("admin.col.state"), t("admin.col.detail")]}
          rows={[
            [t("admin.knowledge", { provider: o.knowledgeProvider }), <Health key="k" h={o.health.knowledge} />, o.health.knowledge.detail],
            [t("admin.model"), <Health key="m" h={o.health.model} />, o.health.model.detail],
            ...o.health.connectors.map((c: any) => [t("admin.connector", { id: c.id }), <Health key={c.id} h={c} />, c.detail]),
          ]}
        />
        <p className="mt-2 text-[13px] text-muted">{t("admin.envLine", { env: o.environment, mode: o.evidenceScoring })}</p>
      </section>
      <section className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
        <Stat label={t("admin.stat.waiting")} value={o.actions.waiting} />
        <Stat label={t("admin.stat.unknown")} value={o.actions.unknown} tone={o.actions.unknown ? "alert" : undefined} />
        <Stat label={t("admin.stat.failed")} value={o.actions.failed} tone={o.actions.failed ? "warn" : undefined} />
        <Stat label={t("admin.stat.quarantined")} value={o.sources.quarantined} tone={o.sources.quarantined ? "warn" : undefined} />
        <Stat label={t("admin.stat.sourceErrors")} value={o.sources.withErrors.length} tone={o.sources.withErrors.length ? "alert" : undefined} />
        <Stat label={t("admin.stat.failingWorkflows")} value={o.workflows.failingLast24h} tone={o.workflows.failingLast24h ? "warn" : undefined} />
        <Stat label={t("admin.stat.stuckRuns")} value={o.workflows.staleRuns} tone={o.workflows.staleRuns ? "alert" : undefined} />
        <Stat label={t("admin.stat.denied")} value={o.deniedEventsLast24h} />
      </section>
      <section className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
        <Stat label={t("admin.stat.documents")} value={t("admin.stat.indexedOf", { a: o.sources.indexed, b: o.sources.documents })} />
        <Stat label={t("admin.stat.sources")} value={o.sources.configured} />
        <Stat label={t("admin.stat.workflows")} value={t("admin.stat.activeOf", { a: o.workflows.enabled, b: o.workflows.total })} />
        <Stat label={t("admin.stat.runningNow")} value={o.agentRunsLast24h.running} />
        <Stat
          label={t("admin.stat.answers24h")}
          value={
            Object.entries(o.agentRunsLast24h.byStatus as Record<string, number>)
              .map(([k, v]) => `${v} ${tm(`status.${k}`, k.replace(/_/g, " ")).toLowerCase()}`)
              .join(" · ") || "0"
          }
        />
      </section>
    </div>
  );
}

function Sources() {
  const { t, when } = useT();
  const { data, error, reload } = useLoad<any[]>("/api/admin/sources");
  const [open, setOpen] = useState<string>();
  const { data: q } = useLoad<any[]>(open ? `/api/admin/sources/${encodeURIComponent(open)}/quarantine` : null);
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    const t = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(t);
  }, [reload]);
  if (error) return <ErrorText error={error} />;
  return (
    <div className="flex flex-col gap-5">
      <Table
        head={[t("admin.col.source"), t("admin.col.documents"), t("admin.col.indexed"), t("admin.col.unsearchable"), t("admin.col.quarantined"), t("admin.col.lastRun"), ""]}
        rows={(data ?? []).map((s) => [
          <div key="n">
            <p className="font-bold">{s.title}</p>
            <p className="text-xs text-muted">
              {s.id} · {s.kind}
            </p>
          </div>,
          s.documents,
          s.indexed,
          s.unsearchable ? <Pill tone="warn">{s.unsearchable}</Pill> : 0,
          s.quarantined ? (
            <button type="button" onClick={() => setOpen(s.id)} className="cursor-pointer border-0 bg-transparent p-0 font-semibold text-brand">
              {t("admin.view", { n: s.quarantined })}
            </button>
          ) : (
            0
          ),
          s.lastRun ? (
            <div key="r">
              {s.lastRun.error ? <Pill tone="danger">{t("admin.error")}</Pill> : <Pill tone="ok">{t("admin.ok")}</Pill>}
              <p className="mt-1 text-xs text-muted">
                {when(s.lastRun.finishedAt)} · +{s.lastRun.upserted} / −{s.lastRun.tombstoned}
                {s.lastRun.aclChanged ? ` · ${s.lastRun.aclChanged} ACL` : ""}
              </p>
            </div>
          ) : (
            <Pill tone="muted">{t("admin.never")}</Pill>
          ),
          s.syncRequested ? (
            <Pill tone="warn">{t("admin.syncRequested")}</Pill>
          ) : (
            <button
              type="button"
              disabled={busy === s.id}
              onClick={async () => {
                setBusy(s.id);
                try {
                  await api(`/api/admin/sources/${encodeURIComponent(s.id)}/sync`, { method: "POST" });
                  await reload();
                } finally {
                  setBusy(undefined);
                }
              }}
              className="min-h-9 cursor-pointer rounded-full border border-line-strong bg-transparent px-3 text-[13px] font-semibold hover:bg-panel disabled:opacity-60"
            >
              {t("admin.syncNow")}
            </button>
          ),
        ])}
      />
      <p className="text-[13px] text-muted">{t("admin.sourcesNote")}</p>
      {open && (
        <section aria-label={t("admin.quarantine", { id: open })}>
          <h2 className="mb-2 text-[17px] font-bold">{t("admin.quarantine", { id: open })}</h2>
          <Table head={[t("admin.col.item"), t("admin.col.reason"), t("admin.col.detail"), t("admin.col.since")]} rows={(q ?? []).map((r) => [r.externalId, <Pill key="r" tone="warn">{r.reason}</Pill>, r.detail ?? "", when(r.createdAt)])} />
          <p className="mt-2 text-[13px] text-muted">{t("admin.quarantineNote")}</p>
        </section>
      )}
    </div>
  );
}

function Integrations() {
  const { t } = useT();
  const { data, error } = useLoad<any[]>("/api/admin/integrations");
  if (error) return <ErrorText error={error} />;
  return (
    <div className="flex flex-col gap-5">
      {(data ?? []).map((c) => (
        <section key={c.id} aria-label={c.id} className="rounded-[14px] border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[17px] font-bold">
              {c.id} <span className="text-[13px] font-normal text-muted">· {c.kind.toUpperCase()}</span>
            </h2>
            <span className="flex items-center gap-2 text-[13px] text-muted">
              <Health h={c.health} /> {c.health.detail}
            </span>
          </div>
          <h3 className="mt-3 text-xs font-semibold text-muted uppercase">{t("admin.tools")}</h3>
          <ul className="m-0 mt-1 flex flex-wrap gap-2 p-0">
            {c.tools.map((t: any) => (
              <li key={t.name} className="list-none">
                <Pill tone={t.enabled ? "ok" : "danger"}>
                  {t.name}
                  {t.enabled ? "" : ` · ${t.reason}`}
                </Pill>
              </li>
            ))}
          </ul>
          <h3 className="mt-3 text-xs font-semibold text-muted uppercase">{t("admin.capabilities")}</h3>
          <Table
            head={[t("admin.col.capability"), t("admin.col.kind"), t("admin.col.who")]}
            rows={c.capabilities.map((d: any) => [
              <span key="i" className="font-mono text-[12.5px]">
                {d.id}@{d.version}
              </span>,
              d.kind === "write" ? <Pill tone="warn">{t("admin.writeApproval")}</Pill> : <Pill tone="muted">{t("admin.read")}</Pill>,
              d.requiredGroups.length ? d.requiredGroups.join(", ") : t("admin.everyone"),
            ])}
          />
        </section>
      ))}
      {data?.length === 0 && <p className="text-muted">{t("admin.noIntegrations")}</p>}
    </div>
  );
}

const LICENCE_TONE: Record<string, "ok" | "warn" | "alert" | "muted"> = { valid: "ok", grace: "warn", expired: "alert", none: "alert" };

/** Dates on a licence need the year, unlike the console's other timestamps. */
function useDay() {
  const { lang } = useT();
  return (iso?: string) => (iso ? new Date(iso).toLocaleDateString(lang === "bg" ? "bg-BG" : "en-GB", { day: "numeric", month: "long", year: "numeric" }) : "—");
}

/** The warning for a licence that is expiring, in grace, expired or missing; nothing when all is well. */
function LicenceNotice({ l }: { l: any }) {
  const { t } = useT();
  const day = useDay();
  const text =
    l.status === "none"
      ? t("admin.licence.none")
      : l.status === "expired"
        ? t("admin.licence.expired", { date: day(l.expiresAt) })
        : l.status === "grace"
          ? t("admin.licence.grace", { date: day(l.expiresAt), end: day(l.graceEndsAt) })
          : l.daysLeft < 30
            ? t("admin.licence.expiresSoon", { n: l.daysLeft, date: day(l.expiresAt) })
            : undefined;
  if (!text) return null;
  const alert = l.status === "expired" || l.status === "none";
  return (
    <p role={alert ? "alert" : "status"} className={`rounded-xl px-3.5 py-3 text-sm ${alert ? "bg-alert-bg text-alert-ink" : "bg-warn-bg text-warn-ink"}`}>
      {text}
    </p>
  );
}

function Agents() {
  const { t, tm } = useT();
  const day = useDay();
  const { data, error } = useLoad<any[]>("/api/admin/agents");
  const { data: l } = useLoad<any>("/api/admin/licence");
  if (error) return <ErrorText error={error} />;
  return (
    <div className="flex flex-col gap-4">
      {l && (
        <section aria-label={t("admin.licence")} className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[17px] font-bold">{t("admin.licence")}</h2>
            <Pill tone={LICENCE_TONE[l.status] ?? "muted"}>{tm(`admin.licence.status.${l.status}`, l.status)}</Pill>
            {l.status === "valid" && <span className="text-[13px] text-muted">{t("admin.licence.daysLeft", { n: l.daysLeft })}</span>}
          </div>
          {l.licenceId && <p className="text-[13.5px] text-muted">{t("admin.licence.line", { name: l.customerName, id: l.licenceId, date: day(l.expiresAt) })}</p>}
          <p className="text-[13.5px]">
            <span className="font-semibold">{t("admin.licence.workflows")}:</span>{" "}
            <span className="font-mono text-[12.5px]">{l.workflowKinds.length ? l.workflowKinds.join(", ") : t("admin.licence.noWorkflows")}</span>
          </p>
          <LicenceNotice l={l} />
        </section>
      )}
      <Table
        head={[t("admin.col.agent"), t("admin.col.licence"), t("admin.capabilities"), t("admin.col.knowledgeSources"), t("admin.col.limits")]}
        rows={(data ?? []).map((a) => [
          <div key="a">
            <p className="font-bold">{a.name}</p>
            <p className="text-xs text-muted">
              {a.id}@{a.version}
            </p>
          </div>,
          a.core ? <Pill key="l" tone="ok">{t("admin.core")}</Pill> : a.licensed ? <Pill key="l" tone="ok">{t("admin.licensed")}</Pill> : <Pill key="l" tone="muted">{t("admin.notLicensed")}</Pill>,
          <span key="c" className="font-mono text-[12.5px]">
            {a.capabilities.join(", ")}
          </span>,
          a.sourceIds.join(", "),
          t("admin.limits", { tools: a.limits.maxToolCalls, min: Math.round(a.limits.maxDurationMs / 60000), score: a.limits.minEvidenceScore }),
        ])}
      />
    </div>
  );
}

const ACTION_TONE: Record<string, "ok" | "warn" | "alert" | "muted" | "danger"> = {
  pending_approval: "warn",
  approved: "ok",
  executing: "ok",
  succeeded: "ok",
  failed: "danger",
  unknown: "alert",
};

function Actions() {
  const { t, tm, when } = useT();
  const [state, setState] = useState("");
  const { data, error, reload } = useLoad<any[]>(`/api/admin/actions${state ? `?state=${state}` : ""}`, [state]);
  const [msg, setMsg] = useState<string>();
  if (error) return <ErrorText error={error} />;
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label={t("admin.filterState")} className="flex flex-wrap gap-1.5">
        {["", "unknown", "failed", "pending_approval", "succeeded", "expired", "rejected"].map((s) => (
          <button
            key={s || "all"}
            type="button"
            aria-pressed={state === s}
            onClick={() => setState(s)}
            className={`min-h-9 cursor-pointer rounded-full border px-3 text-[13px] font-semibold ${state === s ? "border-brand bg-brand text-on-brand" : "border-line-strong bg-transparent"}`}
          >
            {s ? tm(`admin.state.${s}`, s.replace(/_/g, " ")) : t("admin.all")}
          </button>
        ))}
      </div>
      {msg && (
        <p role="status" className="text-[13px] text-muted">
          {msg}
        </p>
      )}
      <Table
        head={[t("admin.col.operation"), t("admin.col.requestedBy"), t("admin.col.state"), t("admin.col.origin"), t("admin.col.created"), t("admin.col.details"), ""]}
        rows={(data ?? []).map((a) => [
          <div key="o">
            <p className="font-semibold">{a.operation}</p>
            <p className="text-xs text-muted">{a.destination}</p>
          </div>,
          a.principalId,
          <Pill key="s" tone={ACTION_TONE[a.state] ?? "muted"}>
            {tm(`admin.state.${a.state}`, a.state.replace(/_/g, " "))}
          </Pill>,
          tm(`admin.origin.${a.origin}`, a.origin),
          when(a.createdAt),
          <div key="d" className="text-xs text-muted">
            <p>{t("admin.fields", { f: a.payloadFields.join(", ") })}</p>
            <p className="font-mono">{t("admin.hash", { h: a.payloadHash.slice(0, 12) })}</p>
            {a.attempts > 0 && <p>{t("admin.attempts", { n: a.attempts })}</p>}
            {a.lastError && <p className="text-danger">{a.lastError}</p>}
          </div>,
          a.state === "unknown" ? (
            <button
              type="button"
              onClick={async () => {
                const r = await api<{ outcome: string }>(`/api/admin/actions/${a.id}/reconcile`, { method: "POST" });
                setMsg(t("admin.reconciled", { id: a.id.slice(0, 8), outcome: r.outcome }));
                await reload();
              }}
              className="min-h-9 cursor-pointer rounded-full border border-line-strong bg-transparent px-3 text-[13px] font-semibold hover:bg-panel"
            >
              {t("admin.reconcile")}
            </button>
          ) : null,
        ])}
      />
      <p className="text-[13px] text-muted">{t("admin.actionsNote")}</p>
    </div>
  );
}

function Workflows() {
  const { t, tm, when } = useT();
  const { data, error } = useLoad<any[]>("/api/admin/workflows");
  if (error) return <ErrorText error={error} />;
  return (
    <Table
      head={[t("admin.col.workflow"), t("admin.col.owner"), t("admin.col.schedule"), t("admin.col.lastRun"), t("admin.col.failures")]}
      rows={(data ?? []).map((w) => [
        <div key="w">
          <p className="font-semibold">{w.kind}</p>
          <p className="text-xs text-muted">{Object.entries(w.config as Record<string, unknown>).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("/") : String(v)}`).join(" · ")}</p>
        </div>,
        w.principalId,
        w.enabled ? t("admin.everyMin", { n: w.intervalMinutes, when: when(w.nextRunAt) }) : <Pill tone="muted">{t("admin.paused")}</Pill>,
        w.lastRun ? (
          <div key="l">
            <Pill tone={w.lastRun.status === "succeeded" ? "ok" : w.lastRun.status === "failed" ? "danger" : "muted"}>{tm(`run.${w.lastRun.status}`, w.lastRun.status)}</Pill>
            <p className="mt-1 text-xs text-muted">{when(w.lastRun.finishedAt ?? w.lastRun.scheduledFor)}</p>
            {w.lastRun.error && <p className="text-xs text-danger">{w.lastRun.error}</p>}
          </div>
        ) : (
          "—"
        ),
        w.failedLast24h ? <Pill tone="warn">{w.failedLast24h}</Pill> : 0,
      ])}
    />
  );
}

function Audit() {
  const { t, when } = useT();
  const [filter, setFilter] = useState({ action: "", principal: "", outcome: "" });
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const { data, error } = useLoad<any[]>(`/api/admin/audit${qs ? `?${qs}` : ""}`, [qs]);
  if (error) return <ErrorText error={error} />;
  return (
    <div className="flex flex-col gap-3">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => e.preventDefault()}>
        <input
          aria-label={t("admin.audit.action")}
          placeholder={t("admin.audit.actionPh")}
          value={filter.action}
          onChange={(e) => setFilter({ ...filter, action: e.target.value })}
          className="min-h-9 rounded-lg border border-line-strong bg-surface px-3 text-[13px]"
        />
        <input
          aria-label={t("admin.audit.principal")}
          placeholder={t("admin.audit.principalPh")}
          value={filter.principal}
          onChange={(e) => setFilter({ ...filter, principal: e.target.value })}
          className="min-h-9 rounded-lg border border-line-strong bg-surface px-3 text-[13px]"
        />
        <select aria-label={t("admin.audit.outcome")} value={filter.outcome} onChange={(e) => setFilter({ ...filter, outcome: e.target.value })} className="min-h-9 rounded-lg border border-line-strong bg-surface px-3 text-[13px]">
          <option value="">{t("admin.audit.anyOutcome")}</option>
          <option value="ok">ok</option>
          <option value="allowed">allowed</option>
          <option value="denied">denied</option>
          <option value="error">error</option>
        </select>
      </form>
      <Table
        head={[t("admin.col.time"), t("admin.audit.principal"), t("admin.col.action"), t("admin.col.resource"), t("admin.audit.outcome"), t("admin.col.detail")]}
        rows={(data ?? []).map((a) => [
          when(a.createdAt),
          a.principalId ?? "—",
          <span key="a" className="font-mono text-[12.5px]">
            {a.action}
          </span>,
          a.resourceType ? `${a.resourceType} ${String(a.resourceId ?? "").slice(0, 36)}` : "—",
          <Pill key="o" tone={a.outcome === "denied" ? "warn" : a.outcome === "error" ? "danger" : "muted"}>
            {a.outcome}
          </Pill>,
          <span key="d" className="font-mono text-[11.5px] text-muted">
            {JSON.stringify(a.detail).slice(0, 160)}
          </span>,
        ])}
        empty={t("admin.audit.empty")}
      />
      <p className="text-[13px] text-muted">{t("admin.auditNote")}</p>
    </div>
  );
}

export default function AdminPage() {
  const { me, config, refresh } = useSession();
  const { t } = useT();
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    if (me === null) window.location.href = "/";
    const fromUrl = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (fromUrl && TABS.includes(fromUrl)) setTab(fromUrl);
  }, [me]);

  const isAdmin = me?.roles?.includes("admin");
  return (
    <>
      <Header me={me} config={config} onLogout={refresh} active="admin" />
      <div className="mx-auto max-w-[1320px] px-6 py-7">
        <h1 className="text-[26px] font-bold tracking-tight">{t("admin.title")}</h1>
        <p className="mt-1 text-muted">{t("admin.subtitle")}</p>
        {me && !isAdmin ? (
          <p className="mt-6 rounded-[14px] border border-line bg-surface p-5">{t("admin.noAccess")}</p>
        ) : (
          <>
            <div role="tablist" aria-label={t("admin.sections")} className="mt-5 mb-5 flex flex-wrap gap-1.5 border-b border-line pb-3">
              {TABS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => {
                    setTab(id);
                    window.history.replaceState(null, "", `/admin?tab=${id}`);
                  }}
                  className={`min-h-10 cursor-pointer rounded-full border px-3.5 text-sm font-semibold ${tab === id ? "border-brand bg-brand text-on-brand" : "border-line-strong bg-transparent text-ink hover:bg-surface"}`}
                >
                  {t(`admin.tab.${id}` as MessageKey)}
                </button>
              ))}
            </div>
            {me && (
              <div role="tabpanel">
                {tab === "overview" && <Overview />}
                {tab === "sources" && <Sources />}
                {tab === "integrations" && <Integrations />}
                {tab === "agents" && <Agents />}
                {tab === "actions" && <Actions />}
                {tab === "workflows" && <Workflows />}
                {tab === "audit" && <Audit />}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
