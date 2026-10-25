"use client";

import { useEffect, useRef, useState } from "react";
import type { MeResponse, PublicConfig } from "@platform/contracts";
import { LANGS, useT } from "@platform/ui";
import { api } from "../lib/api";
import { useActions } from "../lib/usePendingActions";

type Section = "assistants" | "inbox" | "connections" | "admin" | "none";

const initials = (name: string) =>
  name
    .replace(/\(.*\)/, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

export function Header({ me, config, onLogout, active = "none" }: { me?: MeResponse | null; config?: PublicConfig; onLogout?: () => void; active?: Section }) {
  const { t, lang, setLang } = useT();
  const { actions } = useActions(!!me);
  const pending = actions.filter((a) => a.state === "pending_approval").length;
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const navLink = (href: string, label: string, section: Section, extra?: React.ReactNode) => (
    <a
      href={href}
      aria-current={active === section ? "page" : undefined}
      className={`rounded-[10px] px-3 py-1.5 no-underline ${active === section ? "bg-chrome-2 font-semibold !text-white" : "!text-chrome-muted hover:!text-white"}`}
    >
      {label}
      {extra}
    </a>
  );

  return (
    <header className="flex min-h-14 flex-wrap items-center gap-4 bg-chrome px-6 text-on-brand">
      <a href="/" className="flex items-center gap-2.5 no-underline !text-on-brand">
        <span className="flex size-6 items-center justify-center rounded-lg bg-brand-soft text-[11px] font-bold text-brand">CB</span>
        <span className="font-bold tracking-tight">{config?.brandName ?? "Company Brain"}</span>
      </a>
      {me && (
        <nav aria-label="Main" className="ml-3 flex gap-0.5 text-sm">
          {navLink("/chat", t("nav.assistants"), "assistants")}
          {navLink(
            "/inbox",
            t("nav.inbox"),
            "inbox",
            pending > 0 ? (
              <span className="ml-1.5 text-xs font-bold text-chrome-count" aria-label={t("nav.waiting", { n: pending })}>
                {pending}
              </span>
            ) : null,
          )}
          {/* Shown for admins only; the server enforces the role on every admin route. */}
          {me.roles?.includes("admin") && navLink("/admin", t("nav.admin"), "admin")}
        </nav>
      )}
      {config && (
        <span className="text-xs text-chrome-muted">
          {config.environment === "production" ? "" : t("header.synthetic")}
          {config.modelProvider.startsWith("fake") ? t("header.fakeModel") : config.modelMode === "hybrid" ? t("header.externalModel") : t("header.localModel")} · {config.knowledgeProvider}
        </span>
      )}
      <div role="group" aria-label={t("lang.label")} className="ml-auto flex gap-0.5 rounded-[10px] bg-chrome-2 p-0.5 text-xs">
        {LANGS.map((l) => (
          <button
            key={l}
            type="button"
            lang={l}
            aria-pressed={lang === l}
            onClick={() => setLang(l)}
            className={`min-h-8 min-w-9 cursor-pointer rounded-lg border-0 px-2 font-semibold ${lang === l ? "bg-brand-soft text-brand" : "bg-transparent text-chrome-muted hover:text-white"}`}
          >
            {l === "bg" ? "БГ" : "EN"}
          </button>
        ))}
      </div>
      {me && (
        <div ref={menuRef} className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className={`flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[10px] border-0 pr-1.5 pl-2.5 text-[13px] ${active === "connections" || open ? "bg-chrome-2 text-white" : "bg-transparent text-[#d5ddd7]"}`}
          >
            <span>{me.displayName.replace(/\s*\(.*\)$/, "")}</span>
            <span className="flex size-7 items-center justify-center rounded-full bg-brand-soft text-[11px] font-bold text-brand">{initials(me.displayName)}</span>
          </button>
          {open && (
            <div role="menu" className="absolute top-13 right-0 z-10 w-60 rounded-xl border border-line bg-surface p-1.5 text-ink shadow-[0_12px_28px_rgba(24,35,29,0.16)]">
              <div className="px-2.5 py-2 text-[13px] text-muted">
                {me.principalId} · {me.customerId}
              </div>
              <a role="menuitem" href="/connections" className="flex min-h-11 items-center rounded-lg px-2.5 !text-ink no-underline hover:bg-panel">
                {t("menu.connections")}
              </a>
              <button
                role="menuitem"
                type="button"
                onClick={async () => {
                  await api("/api/auth/logout", { method: "POST" });
                  setOpen(false);
                  onLogout?.();
                  window.location.href = "/";
                }}
                className="flex min-h-11 w-full cursor-pointer items-center rounded-lg border-0 bg-transparent px-2.5 text-left text-ink hover:bg-panel"
              >
                {t("menu.signOut")}
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
