"use client";

import { useEffect, useState } from "react";
import type { AgentSummary, DevPrincipal } from "@platform/contracts";
import { AgentCard } from "@platform/ui";
import { api } from "../lib/api";
import { useSession } from "../lib/useSession";
import { Header } from "./Header";

export default function Home() {
  const { me, config, refresh } = useSession();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [principals, setPrincipals] = useState<DevPrincipal[] | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (me) void api<AgentSummary[]>("/api/agents").then(setAgents, (e) => setError(String(e.message)));
    if (me === null) void api<DevPrincipal[]>("/api/auth/dev-principals").then(setPrincipals, () => setPrincipals([]));
  }, [me]);

  return (
    <>
      <Header me={me} config={config} onLogout={refresh} />
      <main className="mx-auto max-w-5xl px-4 py-8">
        {me === undefined && <p className="text-slate-500">Loading…</p>}
        {me === null && (
          <section aria-labelledby="signin">
            <h1 id="signin" className="text-xl font-semibold">Sign in</h1>
            {principals === null && <p className="mt-2 text-slate-500">Loading…</p>}
            {principals?.length === 0 && (
              <p className="mt-2 text-slate-600">Development sign-in is disabled. Customer OIDC sign-in is not implemented in this milestone.</p>
            )}
            {principals && principals.length > 0 && (
              <>
                <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
                  Synthetic development identities only. Production rejects this sign-in method.
                </p>
                <ul className="mt-4 grid gap-3 sm:grid-cols-3">
                  {principals.map((p) => (
                    <li key={p.principalId}>
                      <button
                        className="h-full w-full rounded-lg border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-slate-700 dark:bg-slate-900"
                        onClick={async () => {
                          try {
                            await api("/api/auth/dev-login", { method: "POST", body: { principalId: p.principalId } });
                            await refresh();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        <span className="block font-medium">{p.displayName}</span>
                        <span className="mt-1 block text-sm text-slate-600 dark:text-slate-400">{p.description}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
        {me && (
          <section aria-labelledby="agents">
            <h1 id="agents" className="text-xl font-semibold">Agents</h1>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {agents.map((a) => (
                <li key={a.id}>
                  <AgentCard agent={a} href={`/chat?agent=${encodeURIComponent(a.id)}`} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {error && <p role="alert" className="mt-4 text-red-700">{error}</p>}
      </main>
    </>
  );
}
