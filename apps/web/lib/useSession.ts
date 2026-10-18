"use client";

import { useCallback, useEffect, useState } from "react";
import type { MeResponse, PublicConfig } from "@platform/contracts";
import { api, ApiRequestError } from "./api";

export function useSession() {
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
  const [config, setConfig] = useState<PublicConfig | undefined>();
  const refresh = useCallback(async () => {
    try {
      setMe(await api<MeResponse>("/api/auth/me"));
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) setMe(null);
      else throw e;
    }
  }, []);
  useEffect(() => {
    void refresh();
    void api<PublicConfig>("/api/config/public").then(setConfig, () => {});
  }, [refresh]);
  return { me, config, refresh };
}
