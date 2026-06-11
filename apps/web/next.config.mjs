/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@app/shared'],
  // Produces a self-contained server in .next/standalone for the prod image.
  output: 'standalone',
  // Moved out of `experimental` in Next 15.5 (the old location now warns on build).
  typedRoutes: false,
  // Dev only: disable webpack's persistent filesystem cache. On this machine the
  // repo lives under OneDrive, which syncs/locks files in `.next/cache` and
  // node_modules mid-write and corrupts the compiled chunk graph — producing a
  // recurring "Cannot read properties of undefined (reading 'call')" in the RSC
  // client. An in-memory cache is rebuilt cleanly every run, so the corruption
  // can't persist. (`.next` is also junctioned out of OneDrive; see README.)
  webpack: (config, { dev }) => {
    if (dev) config.cache = false;
    return config;
  },
};

export default nextConfig;
