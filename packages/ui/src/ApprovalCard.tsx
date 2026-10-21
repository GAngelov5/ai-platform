import type { ActionProposalView } from "@platform/contracts";

export interface ApprovalCardProps {
  proposal: ActionProposalView;
  busy?: boolean;
  onApprove?: (p: ActionProposalView) => void;
  onReject?: (p: ActionProposalView) => void;
}

const STATE_STYLE: Record<string, string> = {
  pending_approval: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  approved: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200",
  executing: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200",
  succeeded: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  failed: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
  unknown: "bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200",
};

/**
 * Shows the complete intended operation before approval: operation,
 * destination, full payload, expiry and risk. Approval sends the exact payload
 * hash shown here; the server rejects any mismatch.
 */
export function ApprovalCard({ proposal: p, busy, onApprove, onReject }: ApprovalCardProps) {
  const pending = p.state === "pending_approval";
  const expired = new Date(p.expiresAt).getTime() < Date.now();
  return (
    <section
      aria-label={`Proposed action: ${p.operation}`}
      className="mt-3 rounded-lg border-2 border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Approval required: {p.operation}</h3>
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATE_STYLE[p.state] ?? "bg-slate-100 text-slate-800"}`}>{p.state.replace("_", " ")}</span>
      </div>
      <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
        <dt className="text-slate-500">Destination</dt>
        <dd className="font-mono text-xs">{p.destination}</dd>
        {Object.entries(p.payload)
          .filter(([k]) => k !== "idempotencyKey")
          .map(([k, v]) => (
            <div className="contents" key={k}>
              <dt className="text-slate-500">{k}</dt>
              <dd className="whitespace-pre-wrap break-words">{String(v)}</dd>
            </div>
          ))}
        <dt className="text-slate-500">Expires</dt>
        <dd>{new Date(p.expiresAt).toLocaleString()}</dd>
        <dt className="text-slate-500">Risk</dt>
        <dd>{p.risk}</dd>
        <dt className="text-slate-500">Payload hash</dt>
        <dd className="font-mono text-xs">{p.payloadHash.slice(0, 16)}…</dd>
        {p.receipt && (
          <>
            <dt className="text-slate-500">Receipt</dt>
            <dd className="font-mono text-xs">{JSON.stringify(p.receipt)}</dd>
          </>
        )}
        {p.lastError && (
          <>
            <dt className="text-slate-500">Note</dt>
            <dd className="text-red-700 dark:text-red-300">{p.lastError}</dd>
          </>
        )}
      </dl>
      {pending && !expired && (
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onApprove?.(p)}
            className="rounded bg-emerald-700 px-3 py-1.5 font-medium text-white hover:bg-emerald-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50"
          >
            Approve and run
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onReject?.(p)}
            className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-800"
          >
            Reject
          </button>
        </div>
      )}
      {pending && expired && <p className="mt-3 text-xs text-slate-600">This proposal expired. Ask the assistant again.</p>}
    </section>
  );
}
