import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Pin the workspace root: this app lives inside the omp-squad repo, which has its own lockfile.
  turbopack: { root: import.meta.dirname },
};

export default withMDX(config);
