"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@platform/ui";
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

const INITIALS: Record<string, string> = { "atlas-tracker": "AT", calendar: "CA", "google-calendar": "G" };

interface PersonalConnection {
  provider: "google";
  configured: boolean;
  connected: boolean;
  accountEmail: string | null;
  connectedAt: string | null;
}

/** Your own Google account (ADR 0015): connect, see which account, disconnect. */
function GoogleCard() {
  const { t, tm } = useT();
  const [c, setC] = useState<PersonalConnection>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean }>();
  const load = useCallback(async () => {
    const list = await api<PersonalConnection[]>("/api/connections");
    setC(list.find((x) => x.provider === "google"));
  }, []);
  useEffect(() => {
    void load().catch(() => {});
    // Result of the round trip through Google (?google=connected|cancelled|missing_scope|error).
    const r = new URLSearchParams(window.location.search).get("google");
    if (r) {
      setNote({ text: tm(`conn.google.result.${r}`, t("conn.google.result.error")), ok: r === "connected" });
      window.history.replaceState(null, "", "/connections");
    }
  }, [load, t, tm]);

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>("/api/connections/google/start", { method: "POST" });
      window.location.href = url;
    } catch {
      setNote({ text: t("conn.google.result.error"), ok: false });
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      const r = await api<{ revokedAtGoogle: boolean }>("/api/connections/google", { method: "DELETE" });
      setNote({ text: r.revokedAtGoogle ? t("conn.google.disconnectedRevoked") : t("conn.google.disconnectedLocal"), ok: r.revokedAtGoogle });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!c) return null;
  return (
    <section aria-label={t("connector.google-calendar")} className="rounded-[16px] border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-brand-soft font-bold text-brand">G</span>
          <div>
            <h2 className="text-[17px] font-bold">{t("connector.google-calendar")}</h2>
            <p className="text-[13px] text-muted">{t("conn.google.sub")}</p>
          </div>
        </div>
        {c.connected ? (
          <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-bold text-brand">{t("conn.google.connected")}</span>
        ) : (
          !c.configured && <span className="rounded-full bg-panel px-2.5 py-0.5 text-xs font-bold text-ink-2">{t("chat.notAvailableTitle")}</span>
        )}
      </div>
      <p className="mt-3.5 text-sm">{c.configured ? t("conn.google.text") : t("conn.google.notConfigured")}</p>
      {c.connected && c.accountEmail && <p className="mt-2 text-[13px] text-muted">{t("conn.google.connectedAs", { email: c.accountEmail })}</p>}
      {note && (
        <p role="status" className={`mt-3 rounded-xl px-3.5 py-2.5 text-sm ${note.ok ? "bg-brand-soft text-brand" : "bg-warn-bg text-warn-ink"}`}>
          {note.text}
        </p>
      )}
      {c.configured && (
        <div className="mt-4">
          {c.connected ? (
            <button type="button" disabled={busy} onClick={() => void disconnect()} className="min-h-10 cursor-pointer rounded-full border border-line-strong px-4 text-sm font-semibold hover:bg-panel disabled:opacity-60">
              {t("conn.google.disconnect")}
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void connect()} className="min-h-10 cursor-pointer rounded-full bg-brand px-4 text-sm font-semibold text-on-brand disabled:opacity-60">
              {t("conn.google.connect")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function CapabilityRow({ c }: { c: Capability }) {
  const { t, tm } = useT();
  return (
    <li className="flex list-none flex-wrap justify-between gap-2 rounded-[10px] bg-canvas px-3 py-2.5">
      <span>{tm(`cap.${c.id}`, c.id)}</span>
      {c.kind === "read" ? <span className="font-semibold text-live">{t("conn.read")}</span> : <span className="font-semibold text-warn-ink">{t("conn.write")}</span>}
    </li>
  );
}

/**
 * Your connections: what your assistants can use, based on your groups and
 * your organization's configuration, plus your own Google account (ADR 0015).
 * Microsoft 365 arrives with the Graph connector in stage 2.
 */
export default function ConnectionsPage() {
  const { me, config, refresh } = useSession();
  const { t, tm } = useT();
  const [caps, setCaps] = useState<Capability[] | null>(null);

  useEffect(() => {
    if (me === null) window.location.href = "/";
    if (me) void api<Capability[]>("/api/capabilities").then(setCaps, () => setCaps([]));
  }, [me]);

  const docs = caps?.filter((c) => c.id === "knowledge.search") ?? [];
  const connectors = new Map<string, Capability[]>();
  // Personal connections have their own card: they are on only once you connect them.
  for (const c of caps ?? []) if (c.connectorId && c.connectorId !== "google-calendar") connectors.set(c.connectorId, [...(connectors.get(c.connectorId) ?? []), c]);

  return (
    <>
      <Header me={me} config={config} onLogout={refresh} active="connections" />
      <div className="mx-auto max-w-[1200px] px-6 py-7">
        <a href="/chat" className="text-sm font-semibold">
          {t("conn.back")}
        </a>
        <h1 className="mt-2 text-[26px] font-bold tracking-tight">{t("conn.title")}</h1>
        <p className="mt-1 mb-6 max-w-[760px] text-muted">{t("conn.intro")}</p>

        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
            {caps === null && <p className="text-muted">{t("common.loading")}</p>}

            {docs.length > 0 && (
              <section aria-label={t("chat.companyDocuments")} className="rounded-[16px] border border-line bg-surface p-5">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-brand-soft font-bold text-brand">D</span>
                  <div>
                    <h2 className="text-[17px] font-bold">{t("chat.companyDocuments")}</h2>
                    <p className="text-[13px] text-muted">{t("conn.docsSub")}</p>
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
              const meta = { name: tm(`connector.${id}`, id), managed: t("conn.managedMcp"), initials: INITIALS[id] ?? id.slice(0, 2).toUpperCase() };
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
                    <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-bold text-brand">{t("conn.available")}</span>
                  </div>
                  <ul className="mt-4 flex flex-col gap-2 p-0 text-sm">
                    {list.map((c) => (
                      <CapabilityRow key={c.id} c={c} />
                    ))}
                  </ul>
                  <p className="mt-3 text-[13px] text-muted">{t("conn.groupsNote")}</p>
                </section>
              );
            })}

            {me && <GoogleCard />}

            <section aria-label="Microsoft 365" className="rounded-[16px] border border-line bg-surface p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-panel font-bold text-ink-2">365</span>
                  <div>
                    <h2 className="text-[17px] font-bold">Microsoft 365</h2>
                    <p className="text-[13px] text-muted">{t("conn.m365Sub")}</p>
                  </div>
                </div>
                <span className="rounded-full bg-panel px-2.5 py-0.5 text-xs font-bold text-ink-2">{t("chat.notAvailableTitle")}</span>
              </div>
              <p className="mt-3.5 text-sm">{t("conn.m365Text")}</p>
            </section>

            {caps !== null && caps.length > 0 && connectors.size === 0 && (
              <p className="rounded-[16px] border border-dashed border-line-strong p-5 text-sm text-muted">
                {t("conn.noLive")}
              </p>
            )}
          </div>

          <aside aria-label={t("conn.sideAria")} className="max-w-[360px] min-w-[260px] flex-[1_1_300px] rounded-[16px] bg-panel p-5">
            <h2 className="mb-3 text-[15px] font-bold">{t("conn.sideTitle")}</h2>
            <ul className="flex flex-col gap-2 p-0 text-sm">
              <li className="flex list-none justify-between gap-2">
                <span>{t("conn.searchDocs")}</span>
                <span className={`font-semibold ${docs.length ? "text-live" : "text-muted"}`}>{docs.length ? t("conn.on") : t("conn.off")}</span>
              </li>
              {[...connectors].map(([id, list]) => (
                <li key={id} className="flex list-none justify-between gap-2">
                  <span>{tm(`connector.${id}`, id)}</span>
                  <span className="font-semibold text-live">{list.some((c) => c.kind === "write") ? t("conn.onWrites") : t("conn.onRead")}</span>
                </li>
              ))}
              <li className="flex list-none justify-between gap-2">
                <span>{t("conn.mail")}</span>
                <span className="text-muted">{t("conn.notAvailable")}</span>
              </li>
            </ul>
            <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 text-[13px] text-muted">
              <p>{t("conn.note1")}</p>
              <p>{t("conn.note2")}</p>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
