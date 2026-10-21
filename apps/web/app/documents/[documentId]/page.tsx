"use client";

import { use, useEffect, useState } from "react";
import type { DocumentView } from "@platform/contracts";
import { api, ApiRequestError } from "../../../lib/api";
import { useSession } from "../../../lib/useSession";
import { Header } from "../../Header";

export default function DocumentPage({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = use(params);
  const { me, config, refresh } = useSession();
  const [doc, setDoc] = useState<DocumentView>();
  const [state, setState] = useState<"loading" | "ok" | "unavailable">("loading");
  const [anchor, setAnchor] = useState<string>();

  useEffect(() => {
    if (!me) return;
    api<DocumentView>(`/api/knowledge/documents/${encodeURIComponent(documentId)}`)
      .then((d) => {
        setDoc(d);
        setState("ok");
        setAnchor(decodeURIComponent(window.location.hash.slice(1)));
      })
      .catch((e) => setState(e instanceof ApiRequestError ? "unavailable" : "unavailable"));
  }, [me, documentId]);

  useEffect(() => {
    if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: "center" });
  }, [anchor, doc]);

  return (
    <>
      <Header me={me} config={config} onLogout={refresh} active="assistants" />
      <main className="mx-auto max-w-3xl px-6 py-10">
        {me === null && <p>Please sign in.</p>}
        {state === "loading" && me && <p className="text-muted">Loading…</p>}
        {state === "unavailable" && <p role="alert">This document is not available. It may not exist, or you may not have access.</p>}
        {doc && (
          <article>
            <a href="/chat" className="text-sm font-semibold">Back to Project assistant</a>
            <h1 className="mt-2 text-[26px] font-bold tracking-tight">{doc.title}</h1>
            <p className="mt-1 text-sm text-muted">
              source {doc.sourceId} · version {doc.version} · indexed {doc.indexedAt.slice(0, 10)}
            </p>
            {doc.chunks.map((c) => (
              <section
                key={c.chunkId}
                id={c.chunkId}
                className={`mt-4 rounded-[16px] border p-5 ${anchor === c.chunkId ? "border-warn-line bg-warn-bg" : "border-line bg-surface"}`}
              >
                {c.location && <h2 className="font-bold">{c.location}</h2>}
                <p className="mt-1 whitespace-pre-wrap">{c.text}</p>
              </section>
            ))}
          </article>
        )}
      </main>
    </>
  );
}
