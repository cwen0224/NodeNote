import { defineConfig } from 'vite';

export default defineConfig(() => {
  const buildTimestamp = new Date().toISOString();

  return {
    server: {
      host: '127.0.0.1',
      port: 5173,
      open: true,
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      open: true,
    },
    define: {
      __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
    },
  };
});
