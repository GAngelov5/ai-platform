import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Company Brain", description: "Grounded answers from authorized company knowledge" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
