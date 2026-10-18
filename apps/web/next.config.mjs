import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const apiOrigin = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  poweredByHeader: false,
  transpilePackages: ["@platform/ui", "@platform/contracts"],
  // Type checking runs separately via `pnpm typecheck` (TypeScript 7 native compiler).
  typescript: { ignoreBuildErrors: true },
  // Local development only: in Compose the TLS reverse proxy routes /api to the API.
  async rewrites() {
    return process.env.NODE_ENV === "development" ? [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }] : [];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
