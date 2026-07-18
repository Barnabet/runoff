import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  // The workspace packages ship raw TypeScript from `src`, so Next must compile
  // them rather than treat them as prebuilt node_modules.
  transpilePackages: ["@runoff/core", "@runoff/engine"],
  webpack: (config) => {
    // Those packages use NodeNext-style relative imports with `.js` extensions
    // (e.g. `./db/index.js`); map them back to the `.ts` sources for webpack.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
