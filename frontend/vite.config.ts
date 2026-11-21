import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Запросы /api уходят на бэкенд. Для браузера это один и тот же адрес,
// поэтому cookie сессии работает без настройки CORS.
const api = process.env.API_URL ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': api } },
  preview: { host: '127.0.0.1', port: 5173, proxy: { '/api': api } },
});
