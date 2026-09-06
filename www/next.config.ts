import type { NextConfig } from "next";

// Static export: the landing is plain HTML/CSS/JS that any static host
// (GitHub Pages, Cloudflare Pages, S3) can serve. No server, no API routes.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  agentRules: false,
  turbopack: { root: __dirname },
};

export default nextConfig;
