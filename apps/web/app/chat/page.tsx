"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionProposalView,
  AgentSummary,
  Citation,
  ConversationDetail,
  ConversationSummary,
  Message,
  RunEvent,
  ToolCallSummary,
} from "@platform/contracts";
import { AgentCard, ApprovalCard, ContextPanel, RunStatus, type ConnectionSummary } from "@platform/ui";
import { api, apiStream } from "../../lib/api";
import { notifyActionsChanged } from "../../lib/usePendingActions";
import { useSession } from "../../lib/useSession";
import { Header } from "../Header";

interface Capability {
  id: string;
  kind: "read" | "write";
  connectorId: string | null;
}

const docHref = (c: Citation) => (c.kind === "live" ? undefined : `/documents/${encodeURIComponent(c.documentId)}#${encodeURIComponent(c.chunkId)}`);
const TERMINAL = new Set(["succeeded", "failed", "unknown", "rejected", "expired", "cancelled"]);
const CONNECTOR_NAMES: Record<string, string> = { "atlas-tracker": "Atlas tracker" };

/** Turns the user's allowed capabilities into the "Connections in use" list. */
function summarizeConnections(caps: Capability[]): ConnectionSummary[] {
  const out: ConnectionSummary[] = [];
  if (caps.some((c) => c.id === "knowledge.search")) out.push({ name: "Company documents", access: "search" });
  const byConnector = new Map<string, Capability[]>();
  for (const c of caps) if (c.connectorId) byConnector.set(c.connectorId, [...(byConnector.get(c.connectorId) ?? []), c]);
  for (const [id, list] of byConnector) {
    const reads = list.some((c) => c.kind === "read");
    const writes = list.some((c) => c.kind === "write");
    out.push({ name: CONNECTOR_NAMES[id] ?? id, access: [reads && "read", writes && "writes need approval"].filter(Boolean).join(" · ") });
  }
  out.push({ name: "Microsoft 365", access: "not available yet", href: "/connections", actionLabel: "Not available yet" });
  return out;
}

/** Renders [[evidenceId]] markers as numbered links to the context panel. */
function AnswerText({ message }: { message: Message }) {
  const order = new Map(message.citations.map((c, i) => [c.evidenceId, i + 1]));
  const parts = message.content.split(/(\[\[(?:ev|lv)_[A-Za-z0-9_-]+\]\])/g);
  return (
    <div className="whitespace-pre-wrap">
      {parts.map((p, i) => {
        const id = /^\[\[((?:ev|lv)_[A-Za-z0-9_-]+)\]\]$/.exec(p)?.[1];
        if (!id) return <Fragment key={i}>{p}</Fragment>;
        const n = order.get(id);
        return n ? (
          <span key={i} className="mx-0.5 text-[13px] font-semibold text-brand">
            [{n}]
          </span>
        ) : null;
      })}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  insufficient_evidence: "Not enough evidence",
  limit_reached: "Stopped at a limit",
  withheld: "Withheld",
  action_proposed: "Needs your approval",
  error: "Something went wrong",
};

export default function ChatPage() {
  const { me, config, refresh } = useSession();
  const [agentId, setAgentId] = useState("project-assistant");
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [caps, setCaps] = useState<Capability[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [current, setCurrent] = useState<ConversationDetail>();
  const [selected, setSelected] = useState<string>();
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

  const open = useCallback(
    async (id: string) => {
      setError(undefined);
      const conv = await api<ConversationDetail>(`/api/conversations/${id}`);
      setCurrent(conv);
      setSelected(undefined);
      window.history.replaceState(null, "", `/chat?c=${id}`);
      await loadProposals(conv.messages);
    },
    [loadProposals],
  );

  useEffect(() => {
    if (me === null) window.location.href = "/";
    if (!me) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("agent")) setAgentId(params.get("agent")!);
    void loadList().catch((e) => setError(e.message));
    void api<AgentSummary[]>("/api/agents").then(setAgents, () => {});
    void api<Capability[]>("/api/capabilities").then(setCaps, () => {});
    const c = params.get("c");
    if (c) void open(c).catch(() => setError("That conversation isn't available."));
  }, [me, loadList, open]);

  const assistantMessages = (current?.messages ?? []).filter((m) => m.role === "assistant");
  const focus = assistantMessages.find((m) => m.id === selected) ?? [...assistantMessages].reverse().find((m) => m.citations.length) ?? assistantMessages.at(-1);
  const connections = useMemo(() => summarizeConnections(caps), [caps]);

  const poll = async (id: string) => {
    for (let i = 0; i < 60; i++) {
      const p = await api<ActionProposalView>(`/api/actions/${id}`);
      setProposals((prev) => ({ ...prev, [id]: p }));
      if (TERMINAL.has(p.state)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    notifyActionsChanged();
  };

  const decide = async (p: ActionProposalView, approve: boolean) => {
    setActing(p.id);
    setError(undefined);
    try {
      const updated = approve
        ? await api<ActionProposalView>(`/api/actions/${p.id}/approve`, { method: "POST", body: { payloadHash: p.payloadHash } })
        : await api<ActionProposalView>(`/api/actions/${p.id}/reject`, { method: "POST" });
      setProposals((prev) => ({ ...prev, [p.id]: updated }));
      notifyActionsChanged();
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
        window.history.replaceState(null, "", `/chat?c=${s.id}`);
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
            setSelected(e.assistantMessage.id);
            if (e.assistantMessage.proposalIds?.length) {
              void loadProposals([e.assistantMessage]);
              notifyActionsChanged();
            }
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
      <Header me={me} config={config} onLogout={refresh} active="assistants" />
      <div className="flex flex-wrap items-stretch">
        <aside aria-label="Assistants and history" className="min-h-[calc(100vh-56px)] max-w-[264px] min-w-[220px] flex-[1_1_240px] border-r border-line bg-panel px-4 py-5">
          <button
            type="button"
            onClick={() => {
              setCurrent(undefined);
              setSelected(undefined);
              window.history.replaceState(null, "", "/chat");
            }}
            className="min-h-11 w-full cursor-pointer rounded-[10px] border-0 bg-brand font-semibold text-on-brand hover:bg-brand-hover"
          >
            New conversation
          </button>
          <p className="mt-6 mb-2 text-xs font-semibold text-muted">Assistants</p>
          {agents.map((a) => (
            <AgentCard key={a.id} agent={a} href={`/chat?agent=${encodeURIComponent(a.id)}`} active={a.id === agentId} />
          ))}
          <p className="mt-6 mb-2 text-xs font-semibold text-muted">Recent</p>
          <ul className="m-0 flex flex-col gap-0.5 p-0 text-[13.5px]">
            {conversations.map((c) => (
              <li key={c.id} className="list-none">
                <button
                  type="button"
                  onClick={() => void open(c.id)}
                  title={c.title}
                  className={`w-full cursor-pointer truncate rounded-[10px] border-0 px-3 py-2 text-left ${current?.id === c.id ? "bg-brand-soft font-semibold text-brand" : "bg-transparent text-ink-2 hover:bg-surface"}`}
                >
                  {c.title}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-5 p-8">
          <h1 className="sr-only">Project assistant</h1>
          {!current?.messages.length && !busy && (
            <div className="max-w-[760px] rounded-[16px] border border-dashed border-line-strong p-6 text-ink-2">
              <p className="font-semibold">Ask about a project, or ask for a change.</p>
              <ul className="mt-2 list-disc pl-5 text-[13.5px] text-muted">
                <li>Why was Project Atlas delayed?</li>
                <li>What is the current status of the Atlas customer data migration?</li>
                <li>Add a comment to ATLAS-180 saying &quot;Readiness review moved to 3 November&quot;</li>
              </ul>
            </div>
          )}
          <ol className="m-0 flex flex-col gap-5 p-0" aria-live="polite">
            {current?.messages.map((m) => (
              <li key={m.id} className="list-none">
                {m.role === "user" ? (
                  <div className="flex justify-end">
                    <div className="max-w-[560px] rounded-xl bg-brand px-3.5 py-2.5 text-on-brand">{m.content}</div>
                  </div>
                ) : (
                  <article
                    className={`max-w-[760px] rounded-[16px] border bg-surface px-[22px] py-5 ${focus?.id === m.id ? "border-line-strong" : "border-line"}`}
                  >
                    <RunStatus calls={m.toolCalls ?? []} model={m.model ? `${m.model.name}${m.model.provider.startsWith("fake") ? " (fake)" : ", local"}` : undefined} />
                    {m.status && m.status !== "answered" && <p className="mb-2 text-xs font-bold text-warn-ink">{STATUS_LABEL[m.status] ?? m.status}</p>}
                    <AnswerText message={m} />
                    {(m.proposalIds ?? []).map((id) =>
                      proposals[id] ? (
                        <ApprovalCard key={id} proposal={proposals[id]} busy={acting === id} onApprove={(p) => void decide(p, true)} onReject={(p) => void decide(p, false)} />
                      ) : null,
                    )}
                    {m.citations.length > 0 && focus?.id !== m.id && (
                      <button type="button" onClick={() => setSelected(m.id)} className="mt-3 cursor-pointer border-0 bg-transparent p-0 text-[13px] font-semibold text-brand">
                        Show its {m.citations.length} sources
                      </button>
                    )}
                  </article>
                )}
              </li>
            ))}
          </ol>
          {busy && (
            <div className="max-w-[760px] rounded-[16px] border border-dashed border-line-strong px-[22px] py-4" role="status">
              <RunStatus calls={live} running />
              <p className="text-[13.5px] text-muted">Checking documents and live systems…</p>
            </div>
          )}

          <form
            className="mt-auto flex max-w-[760px] gap-2"
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
              value={draft}
              maxLength={4000}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask about a project, or ask for a change"
              disabled={busy}
              className="min-h-[46px] flex-1 rounded-xl border border-line-strong bg-surface px-3.5 text-ink placeholder:text-muted"
            />
            {busy ? (
              <button type="button" onClick={() => abort.current?.abort()} className="min-h-[46px] cursor-pointer rounded-xl border border-line-strong bg-transparent px-5">
                Cancel
              </button>
            ) : (
              <button type="submit" disabled={!draft.trim()} className="min-h-[46px] cursor-pointer rounded-xl border-0 bg-brand px-5 font-bold text-on-brand hover:bg-brand-hover disabled:opacity-50">
                Ask
              </button>
            )}
          </form>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </main>

        <div className="max-w-[336px] min-w-[260px] flex-[1_1_300px] border-l border-line bg-panel px-5 py-6">
          <ContextPanel citations={focus?.citations ?? []} connections={connections} documentHref={docHref} manageHref="/connections" />
        </div>
      </div>
    </>
  );
}
