"use client";

import type { MeResponse, PublicConfig } from "@platform/contracts";
import { api } from "../lib/api";

export function Header({ me, config, onLogout }: { me?: MeResponse | null; config?: PublicConfig; onLogout?: () => void }) {
  return (
    <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3">
        <a href="/" className="font-semibold">
          {config?.brandName ?? "Company Brain"}
        </a>
        <div className="flex items-center gap-3 text-sm">
          {config && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200" title="Deployment mode">
              {config.environment} · knowledge: {config.knowledgeProvider} · model: {config.modelProvider}
            </span>
          )}
          {me && (
            <>
              <span className="text-slate-600 dark:text-slate-400">{me.displayName}</span>
              <button
                className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                onClick={async () => {
                  await api("/api/auth/logout", { method: "POST" });
                  onLogout?.();
                }}
              >
                Sign out
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
