/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export for Cloudflare Pages (all data fetching is client-side).
  output: "export",
  images: { unoptimized: true },
};
module.exports = nextConfig;
