import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  agentRules: false,
  turbopack: { root: __dirname },
};

export default nextConfig;
