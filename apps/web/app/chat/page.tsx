"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { Citation, ConversationDetail, ConversationSummary, Message, PostMessageResponse } from "@platform/contracts";
import { SourceCitation } from "@platform/ui";
import { api } from "../../lib/api";
import { useSession } from "../../lib/useSession";
import { Header } from "../Header";

const docHref = (c: Citation) => `/documents/${encodeURIComponent(c.documentId)}#${encodeURIComponent(c.chunkId)}`;

/** Renders [[evidenceId]] markers as numbered links to the citation list. */
function AnswerText({ message }: { message: Message }) {
  const order = new Map(message.citations.map((c, i) => [c.evidenceId, i + 1]));
  const parts = message.content.split(/(\[\[ev_[A-Za-z0-9_-]+\]\])/g);
  return (
    <p className="whitespace-pre-wrap leading-relaxed">
      {parts.map((p, i) => {
        const id = /^\[\[(ev_[A-Za-z0-9_-]+)\]\]$/.exec(p)?.[1];
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
  error: "Error",
};

export default function ChatPage() {
  const { me, config, refresh } = useSession();
  const [agentId, setAgentId] = useState("project-assistant");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [current, setCurrent] = useState<ConversationDetail>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController | null>(null);

  const loadList = useCallback(async () => setConversations(await api<ConversationSummary[]>("/api/conversations")), []);

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
    setCurrent(await api<ConversationDetail>(`/api/conversations/${id}`));
  };

  const send = async () => {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(undefined);
    abort.current = new AbortController();
    try {
      let conv = current;
      if (!conv) {
        const s = await api<ConversationSummary>("/api/conversations", { method: "POST", body: { agentId } });
        conv = { ...s, messages: [] };
      }
      const r = await api<PostMessageResponse>(`/api/conversations/${conv.id}/messages`, {
        method: "POST",
        body: { content },
        signal: abort.current.signal,
      });
      setCurrent({ ...conv, messages: [...conv.messages, r.userMessage, r.assistantMessage] });
      setDraft("");
      await loadList();
    } catch (e) {
      setError((e as Error).name === "AbortError" ? "Cancelled. The server may still finish the run; reload to see it." : (e as Error).message);
    } finally {
      setBusy(false);
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
                    {m.status && m.status !== "answered" && (
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">{STATUS_LABEL[m.status] ?? m.status}</p>
                    )}
                    <AnswerText message={m} />
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
          {!current?.messages.length && <p className="text-slate-500">Ask about project history, decisions or blockers. Try: “Why was Project Atlas delayed?”</p>}

          <form
            className="mt-6 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label htmlFor="q" className="sr-only">Question</label>
            <input
              id="q"
              className="flex-1 rounded border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
              value={draft}
              maxLength={4000}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask a question…"
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
          {busy && <p className="mt-2 text-sm text-slate-500" role="status">Searching authorized sources and drafting an answer…</p>}
          {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        </main>
      </div>
    </>
  );
}
