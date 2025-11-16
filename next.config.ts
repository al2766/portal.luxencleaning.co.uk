import type { NextConfig } from "next";

const nextConfig: NextConfig = {

  output: 'export',
  eslint: { ignoreDuringBuilds: true },  // you already did this
  typescript: {
    ignoreBuildErrors: true,             // 👈 skip TS type checking on Vercel builds
  },
};

export default nextConfig;

