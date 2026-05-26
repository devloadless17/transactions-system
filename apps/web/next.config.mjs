/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@app/shared'],
  // Produces a self-contained server in .next/standalone for the prod image.
  output: 'standalone',
  experimental: {
    typedRoutes: false,
  },
};

export default nextConfig;
