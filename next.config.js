/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lint and TypeScript checks run explicitly in the build script before bundling.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true }
};

module.exports = nextConfig;
