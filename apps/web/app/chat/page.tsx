"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type {
  ActionProposalView,
  Citation,
  ConversationDetail,
  ConversationSummary,
  Message,
  RunEvent,
  ToolCallSummary,
} from "@platform/contracts";
import { ApprovalCard, RunStatus, SourceCitation } from "@platform/ui";
import { api, apiStream } from "../../lib/api";
import { useSession } from "../../lib/useSession";
import { Header } from "../Header";

const docHref = (c: Citation) => (c.kind === "live" ? undefined : `/documents/${encodeURIComponent(c.documentId)}#${encodeURIComponent(c.chunkId)}`);
const TERMINAL = new Set(["succeeded", "failed", "unknown", "rejected", "expired", "cancelled"]);

/** Renders [[evidenceId]] markers as numbered links to the citation list. */
function AnswerText({ message }: { message: Message }) {
  const order = new Map(message.citations.map((c, i) => [c.evidenceId, i + 1]));
  const parts = message.content.split(/(\[\[(?:ev|lv)_[A-Za-z0-9_-]+\]\])/g);
  return (
    <p className="whitespace-pre-wrap leading-relaxed">
      {parts.map((p, i) => {
        const id = /^\[\[((?:ev|lv)_[A-Za-z0-9_-]+)\]\]$/.exec(p)?.[1];
        if (!id) return <Fragment key={i}>{p}</Fragment>;
        const n = order.get(id);
        return n ? (
          <a key={i} href={`#cite-${message.id}-${n}`} className="ml-0.5 align-super text-xs text-blue-700 dark:text-blue-300">
            [{n}]
          </a>
        ) : null;
      })}
    </p>
  );
}

const STATUS_LABEL: Record<string, string> = {
  insufficient_evidence: "Insufficient evidence",
  limit_reached: "Stopped at a limit",
  withheld: "Withheld",
  action_proposed: "Action proposed — approval needed",
  error: "Error",
};

export default function ChatPage() {
  const { me, config, refresh } = useSession();
  const [agentId, setAgentId] = useState("project-assistant");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [current, setCurrent] = useState<ConversationDetail>();
  const [proposals, setProposals] = useState<Record<string, ActionProposalView>>({});
  const [live, setLive] = useState<(ToolCallSummary | { capabilityId: string; status: "running" })[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string>();
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController | null>(null);

  const loadList = useCallback(async () => setConversations(await api<ConversationSummary[]>("/api/conversations")), []);

  const loadProposals = useCallback(async (messages: Message[]) => {
    const ids = messages.flatMap((m) => m.proposalIds ?? []);
    if (!ids.length) return;
    const list = await api<ActionProposalView[]>(`/api/actions?ids=${ids.join(",")}`);
    setProposals((prev) => ({ ...prev, ...Object.fromEntries(list.map((p) => [p.id, p])) }));
  }, []);

  useEffect(() => {
    const a = new URLSearchParams(window.location.search).get("agent");
    if (a) setAgentId(a);
  }, []);
  useEffect(() => {
    if (me) void loadList().catch((e) => setError(e.message));
    if (me === null) window.location.href = "/";
  }, [me, loadList]);

  const open = async (id: string) => {
    setError(undefined);
    const conv = await api<ConversationDetail>(`/api/conversations/${id}`);
    setCurrent(conv);
    await loadProposals(conv.messages);
  };

  const poll = async (id: string) => {
    for (let i = 0; i < 60; i++) {
      const p = await api<ActionProposalView>(`/api/actions/${id}`);
      setProposals((prev) => ({ ...prev, [id]: p }));
      if (TERMINAL.has(p.state)) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
  };

  const decide = async (p: ActionProposalView, approve: boolean) => {
    setActing(p.id);
    setError(undefined);
    try {
      const updated = approve
        ? await api<ActionProposalView>(`/api/actions/${p.id}/approve`, { method: "POST", body: { payloadHash: p.payloadHash } })
        : await api<ActionProposalView>(`/api/actions/${p.id}/reject`, { method: "POST" });
      setProposals((prev) => ({ ...prev, [p.id]: updated }));
      if (approve) await poll(p.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(undefined);
    }
  };

  const send = async () => {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(undefined);
    setLive([]);
    abort.current = new AbortController();
    try {
      let conv = current;
      if (!conv) {
        const s = await api<ConversationSummary>("/api/conversations", { method: "POST", body: { agentId } });
        conv = { ...s, messages: [] };
        setCurrent(conv);
      }
      const base = conv;
      let shown = base.messages;
      await apiStream<RunEvent>(
        `/api/conversations/${base.id}/messages/stream`,
        { content },
        (e) => {
          if (e.type === "run.started") {
            shown = [...shown, e.userMessage];
            setCurrent({ ...base, messages: shown });
            setDraft("");
          } else if (e.type === "tool.started") {
            setLive((l) => [...l, { capabilityId: e.capabilityId, status: "running" }]);
          } else if (e.type === "tool.finished") {
            setLive((l) => {
              const i = l.findIndex((x) => x.status === "running" && x.capabilityId === e.call.capabilityId);
              return i >= 0 ? [...l.slice(0, i), e.call, ...l.slice(i + 1)] : [...l, e.call];
            });
          } else if (e.type === "message") {
            shown = [...shown, e.assistantMessage];
            setCurrent({ ...base, messages: shown });
            void loadProposals([e.assistantMessage]);
          } else if (e.type === "error") {
            setError(e.message);
          }
        },
        abort.current.signal,
      );
      await loadList();
    } catch (e) {
      setError((e as Error).name === "AbortError" ? "Cancelled. The run was stopped." : (e as Error).message);
    } finally {
      setBusy(false);
      setLive([]);
    }
  };

  return (
    <>
      <Header me={me} config={config} onLogout={refresh} />
      <div className="mx-auto grid max-w-5xl gap-6 px-4 py-6 md:grid-cols-[14rem_1fr]">
        <nav aria-label="Conversation history" className="text-sm">
          <button
            className="mb-3 w-full rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            onClick={() => setCurrent(undefined)}
          >
            New conversation
          </button>
          <ul className="space-y-1">
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  className={`w-full truncate rounded px-2 py-1 text-left hover:bg-slate-200 dark:hover:bg-slate-800 ${current?.id === c.id ? "bg-slate-200 dark:bg-slate-800" : ""}`}
                  onClick={() => void open(c.id)}
                  title={c.title}
                >
                  {c.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <main>
          <h1 className="sr-only">Project Assistant chat</h1>
          <ol className="space-y-6" aria-live="polite">
            {current?.messages.map((m) => (
              <li key={m.id} className={m.role === "user" ? "text-right" : ""}>
                {m.role === "user" ? (
                  <span className="inline-block rounded-lg bg-blue-600 px-3 py-2 text-left text-white">{m.content}</span>
                ) : (
                  <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
                    <RunStatus calls={m.toolCalls ?? []} />
                    {m.status && m.status !== "answered" && (
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">{STATUS_LABEL[m.status] ?? m.status}</p>
                    )}
                    <AnswerText message={m} />
                    {(m.proposalIds ?? []).map((id) =>
                      proposals[id] ? (
                        <ApprovalCard
                          key={id}
                          proposal={proposals[id]}
                          busy={acting === id}
                          onApprove={(p) => void decide(p, true)}
                          onReject={(p) => void decide(p, false)}
                        />
                      ) : null,
                    )}
                    {m.citations.length > 0 && (
                      <section className="mt-4" aria-label="Sources">
                        <h2 className="mb-2 text-sm font-semibold">Sources</h2>
                        <ol className="space-y-2">
                          {m.citations.map((c, i) => (
                            <div id={`cite-${m.id}-${i + 1}`} key={c.evidenceId}>
                              <SourceCitation index={i + 1} citation={c} href={docHref(c)} />
                            </div>
                          ))}
                        </ol>
                      </section>
                    )}
                    {m.model && <p className="mt-3 text-xs text-slate-500">model: {m.model.provider} / {m.model.name}</p>}
                  </article>
                )}
              </li>
            ))}
          </ol>
          {busy && (
            <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-3 dark:border-slate-700" role="status">
              <RunStatus calls={live} running />
              <p className="text-sm text-slate-500">Routing your question across documents and live systems…</p>
            </div>
          )}
          {!current?.messages.length && !busy && (
            <p className="text-slate-500">
              Try: “Why was Project Atlas delayed?”, “What is the current status of the Atlas customer data migration?”, or “Add a comment to ATLAS-180 saying
              &quot;Readiness review moved to 3 November&quot;”.
            </p>
          )}

          <form
            className="mt-6 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label htmlFor="q" className="sr-only">
              Question
            </label>
            <input
              id="q"
              className="flex-1 rounded border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
              value={draft}
              maxLength={4000}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask a question or request a change…"
              disabled={busy}
            />
            {busy ? (
              <button type="button" className="rounded border border-slate-300 px-4 py-2" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            ) : (
              <button type="submit" className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50" disabled={!draft.trim()}>
                Ask
              </button>
            )}
          </form>
          {error && (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </main>
      </div>
    </>
  );
}
