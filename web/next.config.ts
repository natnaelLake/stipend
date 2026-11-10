import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The repo has lockfiles in both agent/ and web/, so name the root explicitly
  // rather than letting Turbopack guess.
  turbopack: { root: __dirname },
};

export default nextConfig;
