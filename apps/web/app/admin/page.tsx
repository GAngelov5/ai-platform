"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "../../lib/api";
import { useSession } from "../../lib/useSession";
import { Header } from "../Header";

/* eslint-disable @typescript-eslint/no-explicit-any -- admin read models are display-only */
type Tab = "overview" | "sources" | "integrations" | "agents" | "actions" | "workflows" | "audit";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "sources", label: "Sources" },
  { id: "integrations", label: "Integrations" },
  { id: "agents", label: "Agents" },
  { id: "actions", label: "Actions" },
  { id: "workflows", label: "Workflows" },
  { id: "audit", label: "Audit" },
];

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
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
const Health = ({ h }: { h?: { ok: boolean; detail?: string } }) => (h ? <Pill tone={h.ok ? "ok" : "danger"}>{h.ok ? "healthy" : "down"}</Pill> : <Pill tone="muted">…</Pill>);

function Table({ head, rows, empty = "Nothing here." }: { head: string[]; rows: React.ReactNode[][]; empty?: string }) {
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
                {empty}
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
    <div className={`min-w-[150px] flex-1 rounded-[14px] border p-4 ${tone === "alert" ? "border-alert-line bg-alert-bg" : tone === "warn" ? "border-warn-line bg-warn-bg" : "border-line bg-surface"}`}>
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
      setError(e instanceof ApiRequestError && e.status === 404 ? "You don't have access to the admin console." : (e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, reload: load };
}

function Overview() {
  const { data: o, error } = useLoad<any>("/api/admin/overview");
  if (error) return <p className="text-danger">{error}</p>;
  if (!o) return <p className="text-muted">Loading…</p>;
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Services">
        <h2 className="mb-2 text-[17px] font-bold">Services</h2>
        <Table
          head={["Service", "State", "Detail"]}
          rows={[
            ["Knowledge (" + o.knowledgeProvider + ")", <Health key="k" h={o.health.knowledge} />, o.health.knowledge.detail],
            ["Model", <Health key="m" h={o.health.model} />, o.health.model.detail],
            ...o.health.connectors.map((c: any) => [`Connector · ${c.id}`, <Health key={c.id} h={c} />, c.detail]),
          ]}
        />
        <p className="mt-2 text-[13px] text-muted">
          Environment {o.environment} · evidence scoring {o.evidenceScoring}
        </p>
      </section>
      <section aria-label="Attention" className="flex flex-wrap gap-3">
        <Stat label="Approvals waiting" value={o.actions.waiting} />
        <Stat label="Unknown outcome" value={o.actions.unknown} tone={o.actions.unknown ? "alert" : undefined} />
        <Stat label="Failed actions" value={o.actions.failed} tone={o.actions.failed ? "warn" : undefined} />
        <Stat label="Quarantined files" value={o.sources.quarantined} tone={o.sources.quarantined ? "warn" : undefined} />
        <Stat label="Sources with errors" value={o.sources.withErrors.length} tone={o.sources.withErrors.length ? "alert" : undefined} />
        <Stat label="Failing workflows (24 h)" value={o.workflows.failingLast24h} tone={o.workflows.failingLast24h ? "warn" : undefined} />
        <Stat label="Stuck workflow runs" value={o.workflows.staleRuns} tone={o.workflows.staleRuns ? "alert" : undefined} />
        <Stat label="Denied events (24 h)" value={o.deniedEventsLast24h} />
      </section>
      <section aria-label="Usage" className="flex flex-wrap gap-3">
        <Stat label="Documents" value={`${o.sources.indexed} / ${o.sources.documents} indexed`} />
        <Stat label="Sources" value={o.sources.configured} />
        <Stat label="Workflows" value={`${o.workflows.enabled} of ${o.workflows.total} active`} />
        <Stat label="Answers now running" value={o.agentRunsLast24h.running} />
        <Stat
          label="Answers (24 h)"
          value={
            Object.entries(o.agentRunsLast24h.byStatus as Record<string, number>)
              .map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`)
              .join(" · ") || "0"
          }
        />
      </section>
    </div>
  );
}

function Sources() {
  const { data, error, reload } = useLoad<any[]>("/api/admin/sources");
  const [open, setOpen] = useState<string>();
  const { data: q } = useLoad<any[]>(open ? `/api/admin/sources/${encodeURIComponent(open)}/quarantine` : null);
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    const t = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(t);
  }, [reload]);
  if (error) return <p className="text-danger">{error}</p>;
  return (
    <div className="flex flex-col gap-5">
      <Table
        head={["Source", "Documents", "Indexed", "Unsearchable", "Quarantined", "Last run", ""]}
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
              {s.quarantined} · view
            </button>
          ) : (
            0
          ),
          s.lastRun ? (
            <div key="r">
              {s.lastRun.error ? <Pill tone="danger">error</Pill> : <Pill tone="ok">ok</Pill>}
              <p className="mt-1 text-xs text-muted">
                {when(s.lastRun.finishedAt)} · +{s.lastRun.upserted} / −{s.lastRun.tombstoned}
                {s.lastRun.aclChanged ? ` · ${s.lastRun.aclChanged} ACL` : ""}
              </p>
            </div>
          ) : (
            <Pill tone="muted">never</Pill>
          ),
          s.syncRequested ? (
            <Pill tone="warn">sync requested</Pill>
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
              Sync now
            </button>
          ),
        ])}
      />
      <p className="text-[13px] text-muted">
        "Unsearchable": no source group maps to a platform group, so nobody can find the document (fail closed). "Sync now" runs within about a minute in the worker.
      </p>
      {open && (
        <section aria-label="Quarantine">
          <h2 className="mb-2 text-[17px] font-bold">Quarantine · {open}</h2>
          <Table head={["Item", "Reason", "Detail", "Since"]} rows={(q ?? []).map((r) => [r.externalId, <Pill key="r" tone="warn">{r.reason}</Pill>, r.detail ?? "", when(r.createdAt)])} />
          <p className="mt-2 text-[13px] text-muted">Quarantined items are never indexed or searchable. They are retried automatically when the file changes.</p>
        </section>
      )}
    </div>
  );
}

function Integrations() {
  const { data, error } = useLoad<any[]>("/api/admin/integrations");
  if (error) return <p className="text-danger">{error}</p>;
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
          <h3 className="mt-3 text-xs font-semibold text-muted uppercase">Tools (pinned definitions)</h3>
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
          <h3 className="mt-3 text-xs font-semibold text-muted uppercase">Capabilities</h3>
          <Table
            head={["Capability", "Kind", "Who may use it"]}
            rows={c.capabilities.map((d: any) => [
              <span key="i" className="font-mono text-[12.5px]">
                {d.id}@{d.version}
              </span>,
              d.kind === "write" ? <Pill tone="warn">write · approval</Pill> : <Pill tone="muted">read</Pill>,
              d.requiredGroups.length ? d.requiredGroups.join(", ") : "everyone",
            ])}
          />
        </section>
      ))}
      {data?.length === 0 && <p className="text-muted">No integrations configured.</p>}
    </div>
  );
}

function Agents() {
  const { data, error } = useLoad<any[]>("/api/admin/agents");
  if (error) return <p className="text-danger">{error}</p>;
  return (
    <Table
      head={["Agent", "Capabilities", "Knowledge sources", "Limits"]}
      rows={(data ?? []).map((a) => [
        <div key="a">
          <p className="font-bold">{a.name}</p>
          <p className="text-xs text-muted">
            {a.id}@{a.version}
          </p>
        </div>,
        <span key="c" className="font-mono text-[12.5px]">
          {a.capabilities.join(", ")}
        </span>,
        a.sourceIds.join(", "),
        `${a.limits.maxToolCalls} tools · ${Math.round(a.limits.maxDurationMs / 60000)} min · min score ${a.limits.minEvidenceScore}`,
      ])}
    />
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
  const [state, setState] = useState("");
  const { data, error, reload } = useLoad<any[]>(`/api/admin/actions${state ? `?state=${state}` : ""}`, [state]);
  const [msg, setMsg] = useState<string>();
  if (error) return <p className="text-danger">{error}</p>;
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Filter by state" className="flex flex-wrap gap-1.5">
        {["", "unknown", "failed", "pending_approval", "succeeded", "expired", "rejected"].map((s) => (
          <button
            key={s || "all"}
            type="button"
            aria-pressed={state === s}
            onClick={() => setState(s)}
            className={`min-h-9 cursor-pointer rounded-full border px-3 text-[13px] font-semibold ${state === s ? "border-brand bg-brand text-on-brand" : "border-line-strong bg-transparent"}`}
          >
            {s ? s.replace(/_/g, " ") : "All"}
          </button>
        ))}
      </div>
      {msg && (
        <p role="status" className="text-[13px] text-muted">
          {msg}
        </p>
      )}
      <Table
        head={["Operation", "Requested by", "State", "Origin", "Created", "Details", ""]}
        rows={(data ?? []).map((a) => [
          <div key="o">
            <p className="font-semibold">{a.operation}</p>
            <p className="text-xs text-muted">{a.destination}</p>
          </div>,
          a.principalId,
          <Pill key="s" tone={ACTION_TONE[a.state] ?? "muted"}>
            {a.state.replace(/_/g, " ")}
          </Pill>,
          a.origin,
          when(a.createdAt),
          <div key="d" className="text-xs text-muted">
            <p>fields: {a.payloadFields.join(", ")}</p>
            <p className="font-mono">hash {a.payloadHash.slice(0, 12)}…</p>
            {a.attempts > 0 && <p>{a.attempts} attempt(s)</p>}
            {a.lastError && <p className="text-danger">{a.lastError}</p>}
          </div>,
          a.state === "unknown" ? (
            <button
              type="button"
              onClick={async () => {
                const r = await api<{ outcome: string }>(`/api/admin/actions/${a.id}/reconcile`, { method: "POST" });
                setMsg(`Reconcile ${a.id.slice(0, 8)}: ${r.outcome}`);
                await reload();
              }}
              className="min-h-9 cursor-pointer rounded-full border border-line-strong bg-transparent px-3 text-[13px] font-semibold hover:bg-panel"
            >
              Reconcile
            </button>
          ) : null,
        ])}
      />
      <p className="text-[13px] text-muted">Comment texts and other payload values are not shown here; only their field names and the hash the owner approved.</p>
    </div>
  );
}

function Workflows() {
  const { data, error } = useLoad<any[]>("/api/admin/workflows");
  if (error) return <p className="text-danger">{error}</p>;
  return (
    <Table
      head={["Workflow", "Owner", "Schedule", "Last run", "Failures (24 h)"]}
      rows={(data ?? []).map((w) => [
        <div key="w">
          <p className="font-semibold">{w.kind}</p>
          <p className="text-xs text-muted">{Object.entries(w.config as Record<string, unknown>).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("/") : String(v)}`).join(" · ")}</p>
        </div>,
        w.principalId,
        w.enabled ? `every ${w.intervalMinutes} min · next ${when(w.nextRunAt)}` : <Pill tone="muted">paused</Pill>,
        w.lastRun ? (
          <div key="l">
            <Pill tone={w.lastRun.status === "succeeded" ? "ok" : w.lastRun.status === "failed" ? "danger" : "muted"}>{w.lastRun.status}</Pill>
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
  const [filter, setFilter] = useState({ action: "", principal: "", outcome: "" });
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const { data, error } = useLoad<any[]>(`/api/admin/audit${qs ? `?${qs}` : ""}`, [qs]);
  if (error) return <p className="text-danger">{error}</p>;
  return (
    <div className="flex flex-col gap-3">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => e.preventDefault()}>
        <input
          aria-label="Action starts with"
          placeholder="Action (e.g. action., workflow., admin.)"
          value={filter.action}
          onChange={(e) => setFilter({ ...filter, action: e.target.value })}
          className="min-h-9 rounded-lg border border-line-strong bg-surface px-3 text-[13px]"
        />
        <input
          aria-label="Principal"
          placeholder="Principal (e.g. alice)"
          value={filter.principal}
          onChange={(e) => setFilter({ ...filter, principal: e.target.value })}
          className="min-h-9 rounded-lg border border-line-strong bg-surface px-3 text-[13px]"
        />
        <select aria-label="Outcome" value={filter.outcome} onChange={(e) => setFilter({ ...filter, outcome: e.target.value })} className="min-h-9 rounded-lg border border-line-strong bg-surface px-3 text-[13px]">
          <option value="">Any outcome</option>
          <option value="ok">ok</option>
          <option value="allowed">allowed</option>
          <option value="denied">denied</option>
          <option value="error">error</option>
        </select>
      </form>
      <Table
        head={["Time", "Principal", "Action", "Resource", "Outcome", "Detail"]}
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
        empty="No matching events."
      />
      <p className="text-[13px] text-muted">The audit log records metadata only: never questions, answers, excerpts or credentials.</p>
    </div>
  );
}

export default function AdminPage() {
  const { me, config, refresh } = useSession();
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    if (me === null) window.location.href = "/";
    const t = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (t && TABS.some((x) => x.id === t)) setTab(t);
  }, [me]);

  const isAdmin = me?.roles?.includes("admin");
  return (
    <>
      <Header me={me} config={config} onLogout={refresh} active="admin" />
      <div className="mx-auto max-w-[1320px] px-6 py-7">
        <h1 className="text-[26px] font-bold tracking-tight">Admin</h1>
        <p className="mt-1 text-muted">Operations for this deployment. Metadata only: administration gives no access to document content.</p>
        {me && !isAdmin ? (
          <p className="mt-6 rounded-[14px] border border-line bg-surface p-5">You don&apos;t have access to the admin console.</p>
        ) : (
          <>
            <div role="tablist" aria-label="Admin sections" className="mt-5 mb-5 flex flex-wrap gap-1.5 border-b border-line pb-3">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => {
                    setTab(t.id);
                    window.history.replaceState(null, "", `/admin?tab=${t.id}`);
                  }}
                  className={`min-h-10 cursor-pointer rounded-full border px-3.5 text-sm font-semibold ${tab === t.id ? "border-brand bg-brand text-on-brand" : "border-line-strong bg-transparent text-ink hover:bg-surface"}`}
                >
                  {t.label}
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
