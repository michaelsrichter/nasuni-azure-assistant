// Runtime + build-time configuration for the SPA.
//
// Telemetry identifiers are injected at *container start* by nginx, which
// renders `/config.js` from environment variables (see nginx.conf.template) and
// sets `window.__APP_CONFIG__`. This keeps connection strings and project ids
// OUT of the committed source and the static bundle. When the values are empty
// (e.g. local `vite dev`), the corresponding instrumentation simply no-ops.
//
// Non-secret links (GitHub, LinkedIn, docs) are plain constants — they are safe
// to ship in the bundle.

export interface BuildInfo {
  commit?: string;
  message?: string;
  author?: string;
  time?: string;
}

export interface AppRuntimeConfig {
  appInsightsConnectionString?: string;
  clarityProjectId?: string;
  buildInfo?: BuildInfo;
}

declare global {
  interface Window {
    __APP_CONFIG__?: AppRuntimeConfig;
  }
}

const runtime: AppRuntimeConfig =
  (typeof window !== 'undefined' && window.__APP_CONFIG__) || {};

function clean(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  // nginx leaves the literal placeholder when the env var is unset.
  if (!trimmed || trimmed.startsWith('${') || trimmed === 'undefined') return undefined;
  return trimmed;
}

export const config = {
  appInsightsConnectionString: clean(runtime.appInsightsConnectionString),
  clarityProjectId: clean(runtime.clarityProjectId),
};

const rawBuild = runtime.buildInfo ?? {};
export const buildInfo = {
  commit: clean(rawBuild.commit),
  message: clean(rawBuild.message),
  author: clean(rawBuild.author),
  time: clean(rawBuild.time),
};

export const APP_NAME = 'Nasuni on Azure Assistant';

export const links = {
  github: 'https://github.com/michaelsrichter/nasuni-azure-assistant',
  linkedIn: 'https://www.linkedin.com/in/mikerichter/',
  nasuni: 'https://www.nasuni.com/',
  nasuniPrivacy: 'https://www.nasuni.com/legal/privacy/',
  // Further reading — Microsoft Foundry building blocks used by this demo.
  foundry: 'https://learn.microsoft.com/azure/ai-foundry/',
  agentService: 'https://learn.microsoft.com/azure/ai-foundry/agents/',
  hostedAgents:
    'https://learn.microsoft.com/azure/foundry/agents/quickstarts/quickstart-hosted-agent',
  knowledgeBases: 'https://learn.microsoft.com/azure/search/',
  agentGovernance: 'https://github.com/microsoft/agent-governance-toolkit',
  foundryEvaluations: 'https://learn.microsoft.com/azure/ai-foundry/concepts/evaluation-approach-gen-ai',
};
