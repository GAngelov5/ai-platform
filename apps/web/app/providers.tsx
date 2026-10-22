"use client";

import { I18nProvider } from "@platform/ui";

/** Client-side providers for every page (UI language). */
export function Providers({ children }: { children: React.ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}
