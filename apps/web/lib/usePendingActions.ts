"use client";

import { useCallback, useEffect, useState } from "react";
import type { ActionProposalView } from "@platform/contracts";
import { api } from "./api";

export const ACTIONS_CHANGED = "platform:actions-changed";

/** Tells the header (and any other listener) that proposals changed. */
export const notifyActionsChanged = () => window.dispatchEvent(new Event(ACTIONS_CHANGED));

/** The signed-in user's own proposals. Refreshes on ACTIONS_CHANGED and every 30 s. */
export function useActions(enabled: boolean) {
  const [actions, setActions] = useState<ActionProposalView[]>([]);
  // False until the first answer, so pages don't show "nothing here" while still loading.
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    try {
      setActions(await api<ActionProposalView[]>("/api/actions"));
    } catch {
      // header count is best-effort
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void load();
    const onChange = () => void load();
    window.addEventListener(ACTIONS_CHANGED, onChange);
    const t = setInterval(onChange, 30_000);
    return () => {
      window.removeEventListener(ACTIONS_CHANGED, onChange);
      clearInterval(t);
    };
  }, [enabled, load]);
  return { actions, loaded, reload: load };
}
