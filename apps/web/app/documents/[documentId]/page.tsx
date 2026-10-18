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
      <Header me={me} config={config} onLogout={refresh} />
      <main className="mx-auto max-w-3xl px-4 py-8">
        {me === null && <p>Please sign in.</p>}
        {state === "loading" && me && <p className="text-slate-500">Loading…</p>}
        {state === "unavailable" && <p role="alert">This document is not available. It may not exist, or you may not have access.</p>}
        {doc && (
          <article>
            <h1 className="text-2xl font-semibold">{doc.title}</h1>
            <p className="mt-1 text-sm text-slate-500">
              source {doc.sourceId} · version {doc.version} · indexed {doc.indexedAt.slice(0, 10)}
            </p>
            {doc.chunks.map((c) => (
              <section
                key={c.chunkId}
                id={c.chunkId}
                className={`mt-6 rounded p-3 ${anchor === c.chunkId ? "bg-yellow-100 ring-2 ring-yellow-400 dark:bg-yellow-900/30" : ""}`}
              >
                {c.location && <h2 className="font-semibold">{c.location}</h2>}
                <p className="mt-1 whitespace-pre-wrap">{c.text}</p>
              </section>
            ))}
          </article>
        )}
      </main>
    </>
  );
}
