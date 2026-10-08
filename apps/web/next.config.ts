import type { NextConfig } from 'next';

// El navegador habla solo con el origen de la web; /api/* lo reenvía a la API
// src/app/api/[...path]/route.ts, leyendo API_INTERNAL_URL en tiempo de ejecución.
const config: NextConfig = {
  transpilePackages: ['@kaluch/shared'],
  output: 'standalone',
  poweredByHeader: false,
};

export default config;
