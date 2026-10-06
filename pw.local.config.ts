import base from './playwright.config';
const PORT = 5181;
export default {
  ...base,
  testDir: 'e2e',
  workers: 4,
  use: { ...base.use, baseURL: `http://localhost:${PORT}` },
  webServer: { ...base.webServer, command: `npx vite --mode e2e --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: false },
};
