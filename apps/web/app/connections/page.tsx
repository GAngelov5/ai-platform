"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/useSession";
import { Header } from "../Header";

interface Capability {
  id: string;
  version: string;
  kind: "read" | "write";
  description: string;
  connectorId: string | null;
}

const NAMES: Record<string, { name: string; managed: string; initials: string }> = {
  "atlas-tracker": { name: "Atlas tracker", managed: "Managed by your organization · MCP server", initials: "AT" },
};

const CAP_LABEL: Record<string, string> = {
  "knowledge.search": "Search company documents you're allowed to read",
  "tracker.tasks.list": "Read live task lists",
  "tracker.task.status": "Read live task status",
  "tracker.task.comment": "Add comments to tasks",
};

function CapabilityRow({ c }: { c: Capability }) {
  return (
    <li className="flex list-none flex-wrap justify-between gap-2 rounded-[10px] bg-canvas px-3 py-2.5">
      <span>{CAP_LABEL[c.id] ?? c.id}</span>
      {c.kind === "read" ? (
        <span className="font-semibold text-live">Read · automatic</span>
      ) : (
        <span className="font-semibold text-warn-ink">Write · needs your approval each time</span>
      )}
    </li>
  );
}

/**
 * Your connections: what your assistants can use, based on your groups and
 * your organization's configuration. Personal account connections (Microsoft
 * 365) arrive with the Graph connector in stage 2.
 */
export default function ConnectionsPage() {
  const { me, config, refresh } = useSession();
  const [caps, setCaps] = useState<Capability[] | null>(null);

  useEffect(() => {
    if (me === null) window.location.href = "/";
    if (me) void api<Capability[]>("/api/capabilities").then(setCaps, () => setCaps([]));
  }, [me]);

  const docs = caps?.filter((c) => c.id === "knowledge.search") ?? [];
  const connectors = new Map<string, Capability[]>();
  for (const c of caps ?? []) if (c.connectorId) connectors.set(c.connectorId, [...(connectors.get(c.connectorId) ?? []), c]);

  return (
    <>
      <Header me={me} config={config} onLogout={refresh} active="connections" />
      <div className="mx-auto max-w-[1200px] px-6 py-7">
        <a href="/chat" className="text-sm font-semibold">
          Back to Project assistant
        </a>
        <h1 className="mt-2 text-[26px] font-bold tracking-tight">Your connections</h1>
        <p className="mt-1 mb-6 max-w-[760px] text-muted">
          Your organization decides which connections exist and who may use them. This page shows what your assistants can use right now. Every change still needs your
          approval.
        </p>

        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
            {caps === null && <p className="text-muted">Loading…</p>}

            {docs.length > 0 && (
              <section aria-label="Company documents" className="rounded-[16px] border border-line bg-surface p-5">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-brand-soft font-bold text-brand">D</span>
                  <div>
                    <h2 className="text-[17px] font-bold">Company documents</h2>
                    <p className="text-[13px] text-muted">Indexed knowledge · access follows each document&apos;s permissions</p>
                  </div>
                </div>
                <ul className="mt-4 flex flex-col gap-2 p-0 text-sm">
                  {docs.map((c) => (
                    <CapabilityRow key={c.id} c={c} />
                  ))}
                </ul>
              </section>
            )}

            {[...connectors].map(([id, list]) => {
              const meta = NAMES[id] ?? { name: id, managed: "Managed by your organization", initials: id.slice(0, 2).toUpperCase() };
              return (
                <section key={id} aria-label={meta.name} className="rounded-[16px] border border-line bg-surface p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="flex size-10 items-center justify-center rounded-xl bg-brand-soft font-bold text-brand">{meta.initials}</span>
                      <div>
                        <h2 className="text-[17px] font-bold">{meta.name}</h2>
                        <p className="text-[13px] text-muted">{meta.managed}</p>
                      </div>
                    </div>
                    <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-bold text-brand">Available to you</span>
                  </div>
                  <ul className="mt-4 flex flex-col gap-2 p-0 text-sm">
                    {list.map((c) => (
                      <CapabilityRow key={c.id} c={c} />
                    ))}
                  </ul>
                  <p className="mt-3 text-[13px] text-muted">Access comes from your group membership. Tools are locked to definitions your admin reviewed.</p>
                </section>
              );
            })}

            <section aria-label="Microsoft 365" className="rounded-[16px] border border-line bg-surface p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-panel font-bold text-ink-2">365</span>
                  <div>
                    <h2 className="text-[17px] font-bold">Microsoft 365</h2>
                    <p className="text-[13px] text-muted">Your own account · mail and calendar</p>
                  </div>
                </div>
                <span className="rounded-full bg-panel px-2.5 py-0.5 text-xs font-bold text-ink-2">Not available yet</span>
              </div>
              <p className="mt-3.5 text-sm">
                When your organization enables it, you&apos;ll connect your own account here so assistants can read your calendar and prepare email drafts for your
                approval. Sending email won&apos;t be allowed.
              </p>
            </section>

            {caps !== null && caps.length > 0 && connectors.size === 0 && (
              <p className="rounded-[16px] border border-dashed border-line-strong p-5 text-sm text-muted">
                No live systems are available to you yet. Your admin controls which groups can use them.
              </p>
            )}
          </div>

          <aside aria-label="What your assistants can do" className="max-w-[360px] min-w-[260px] flex-[1_1_300px] rounded-[16px] bg-panel p-5">
            <h2 className="mb-3 text-[15px] font-bold">What your assistants can do right now</h2>
            <ul className="flex flex-col gap-2 p-0 text-sm">
              <li className="flex list-none justify-between gap-2">
                <span>Search documents</span>
                <span className={`font-semibold ${docs.length ? "text-live" : "text-muted"}`}>{docs.length ? "on" : "off"}</span>
              </li>
              {[...connectors].map(([id, list]) => (
                <li key={id} className="flex list-none justify-between gap-2">
                  <span>{NAMES[id]?.name ?? id}</span>
                  <span className="font-semibold text-live">{list.some((c) => c.kind === "write") ? "on · writes approved" : "on · read only"}</span>
                </li>
              ))}
              <li className="flex list-none justify-between gap-2">
                <span>Calendar and mail</span>
                <span className="text-muted">not available</span>
              </li>
            </ul>
            <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 text-[13px] text-muted">
              <p>Organization connections are set up and reviewed by admins.</p>
              <p>Credentials stay on the server and are never shown to the assistant.</p>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
