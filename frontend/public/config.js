// Default runtime config used during local development (`vite dev`) and as a
// fallback. In production this file is shadowed by nginx, which generates
// /config.js from container environment variables (see nginx.conf.template).
window.__APP_CONFIG__ = {
  appInsightsConnectionString: '',
  clarityProjectId: '',
};
