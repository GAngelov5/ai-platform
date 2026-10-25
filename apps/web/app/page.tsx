"use client";

import { useEffect, useState } from "react";
import type { DevPrincipal } from "@platform/contracts";
import { useT } from "@platform/ui";
import { api } from "../lib/api";
import { useSession } from "../lib/useSession";
import { Header } from "./Header";

/** Signed out: development sign-in. Signed in: go to the workspace. */
export default function Home() {
  const { me, config, refresh } = useSession();
  const { t } = useT();
  const [principals, setPrincipals] = useState<DevPrincipal[] | null>(null);
  const [error, setError] = useState<string>();

  const company = config?.authMode === "oidc";
  const [loginResult, setLoginResult] = useState<string | null>(null);
  useEffect(() => {
    if (me) window.location.replace("/chat");
    // Company sign-in has no user list; development sign-in lists the synthetic users.
    if (me === null && config && !company) void api<DevPrincipal[]>("/api/auth/dev-principals").then(setPrincipals, () => setPrincipals([]));
  }, [me, config, company]);
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get("login");
    if (r) {
      setLoginResult(r);
      window.history.replaceState(null, "", "/");
    }
  }, []);

  return (
    <>
      <Header me={me} config={config} onLogout={refresh} />
      <main className="mx-auto max-w-4xl px-6 py-12">
        {me !== null && <p className="text-muted">{t("common.loading")}</p>}
        {me === null && (
          <section aria-labelledby="signin">
            <h1 id="signin" className="text-[26px] font-bold tracking-tight">
              {t("login.title")}
            </h1>
            {loginResult && (
              <p role="status" className="mt-3 rounded-xl bg-warn-bg px-3.5 py-2.5 text-sm text-warn-ink">
                {loginResult === "cancelled" ? t("login.cancelled") : loginResult === "not_allowed" ? t("login.not_allowed") : t("login.error")}
              </p>
            )}
            {company && (
              <div className="mt-6 max-w-[520px] rounded-[16px] border border-line bg-surface p-6">
                <p className="text-[14.5px] text-ink-2">{t("login.companyText")}</p>
                {/* A full-page navigation: the identity provider's page can't be fetched. */}
                <a href="/api/auth/oidc/login" className="mt-4 inline-flex min-h-11 items-center rounded-full bg-brand px-5 font-semibold !text-on-brand no-underline hover:bg-brand-hover hover:!text-on-brand">
                  {t("login.company")}
                </a>
              </div>
            )}
            {!company && principals === null && <p className="mt-2 text-muted">{t("common.loading")}</p>}
            {principals?.length === 0 && <p className="mt-2 text-muted">{t("login.disabled")}</p>}
            {principals && principals.length > 0 && (
              <>
                <p className="mt-2 text-warn-ink">{t("login.synthetic")}</p>
                <ul className="mt-6 grid gap-3 p-0 sm:grid-cols-3">
                  {principals.map((p) => (
                    <li key={p.principalId} className="list-none">
                      <button
                        className="h-full w-full cursor-pointer rounded-[16px] border border-line bg-surface p-4 text-left hover:border-brand"
                        onClick={async () => {
                          try {
                            await api("/api/auth/dev-login", { method: "POST", body: { principalId: p.principalId } });
                            await refresh();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        <span className="block font-bold">{p.displayName}</span>
                        <span className="mt-1 block text-[13px] text-muted">{p.description}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
        {error && (
          <p role="alert" className="mt-4 text-danger">
            {error}
          </p>
        )}
      </main>
    </>
  );
}
