import type { ActionProposalView } from "@platform/contracts";
import { useT } from "./i18n.js";

export interface ApprovalCardProps {
  proposal: ActionProposalView;
  busy?: boolean;
  onApprove?: (p: ActionProposalView) => void;
  onReject?: (p: ActionProposalView) => void;
}

const STATE: Record<string, { card: string; text: string }> = {
  pending_approval: { card: "border-warn-line bg-warn-bg", text: "text-warn-ink" },
  approved: { card: "border-ok-line bg-ok-bg", text: "text-brand" },
  executing: { card: "border-ok-line bg-ok-bg", text: "text-brand" },
  succeeded: { card: "border-ok-line bg-ok-bg", text: "text-brand" },
  failed: { card: "border-danger-line bg-surface", text: "text-danger" },
  unknown: { card: "border-alert-line bg-alert-bg", text: "text-alert-ink" },
  rejected: { card: "border-line bg-canvas", text: "text-muted" },
  expired: { card: "border-line bg-canvas", text: "text-muted" },
  cancelled: { card: "border-line bg-canvas", text: "text-muted" },
};

/**
 * Shows the complete intended operation before approval: operation,
 * destination, full payload, expiry and risk. Approval sends the exact payload
 * hash shown here; the server rejects any mismatch.
 */
export function ApprovalCard({ proposal: p, busy, onApprove, onReject }: ApprovalCardProps) {
  const { t, tm, lang } = useT();
  const s = STATE[p.state] ?? STATE.pending_approval!;
  const pending = p.state === "pending_approval";
  const expired = new Date(p.expiresAt).getTime() < Date.now();
  const row = "contents";
  return (
    <section aria-label={t("approval.aria", { op: p.operation })} className={`mt-3 rounded-xl border px-[18px] py-4 text-[13.5px] ${s.card}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-bold">{p.operation}</h3>
        <span className={`text-xs font-semibold ${s.text}`}>{tm(`approval.state.${p.state}`, p.state)}</span>
      </div>
      <dl className="mt-3 grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-muted">{t("approval.destination")}</dt>
        <dd className="font-mono text-[12.5px]">{p.destination}</dd>
        {Object.entries(p.payload)
          .filter(([k]) => k !== "idempotencyKey" && k !== "taskKey")
          .map(([k, v]) => (
            <div className={row} key={k}>
              <dt className="capitalize text-muted">{tm(`approval.field.${k}`, k)}</dt>
              <dd className="whitespace-pre-wrap break-words">{String(v)}</dd>
            </div>
          ))}
        <dt className="text-muted">{t("approval.expires")}</dt>
        <dd>{new Date(p.expiresAt).toLocaleString(lang === "bg" ? "bg-BG" : undefined)}</dd>
        <dt className="text-muted">{t("approval.risk")}</dt>
        <dd>{p.risk}</dd>
        <dt className="text-muted">{t("approval.hash")}</dt>
        <dd className="font-mono text-[12.5px]">{p.payloadHash.slice(0, 12)}…</dd>
        {p.receipt && (
          <>
            <dt className="text-muted">{t("approval.receipt")}</dt>
            <dd className="font-mono text-[12.5px]">{String((p.receipt as { commentId?: string }).commentId ?? JSON.stringify(p.receipt))}</dd>
          </>
        )}
        {p.lastError && (
          <>
            <dt className="text-muted">{t("approval.note")}</dt>
            <dd className="text-danger">{p.lastError}</dd>
          </>
        )}
      </dl>
      {pending && !expired && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onApprove?.(p)}
            className="min-h-11 cursor-pointer rounded-[10px] bg-brand px-[18px] font-bold text-on-brand hover:bg-brand-hover disabled:opacity-60"
          >
            {t("approval.approve")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onReject?.(p)}
            className="min-h-11 cursor-pointer rounded-[10px] border border-line-strong bg-transparent px-[18px] text-ink hover:bg-surface disabled:opacity-60"
          >
            {t("approval.reject")}
          </button>
        </div>
      )}
      {pending && expired && <p className="mt-3 text-xs text-muted">{t("approval.expiredNote")}</p>}
    </section>
  );
}
