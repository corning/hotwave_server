/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // 启用 instrumentation hook（Next.js 14 需此 flag 才加载 src/instrumentation.ts）。
    // register() 启动 hotwave 长连接 WS server（:18791）。
    instrumentationHook: true,
    serverComponentsExternalPackages: ['better-sqlite3', 'ws'],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(Array.isArray(config.externals) ? config.externals : []), 'ws', 'bufferutil', 'utf-8-validate'];
    }
    return config;
  },
};

module.exports = nextConfig;
