// Frontend telemetry: Azure Application Insights (page views + custom events)
// and Microsoft Clarity (session replay / heatmaps). Both initialise from the
// runtime-injected config and no-op when their identifiers are absent.

import {
  ApplicationInsights,
  type IExceptionTelemetry,
} from '@microsoft/applicationinsights-web';
import { config } from '../config';

let appInsights: ApplicationInsights | undefined;

export function initTelemetry(): void {
  initAppInsights();
  initClarity();
}

function initAppInsights(): void {
  if (appInsights || !config.appInsightsConnectionString) return;
  try {
    appInsights = new ApplicationInsights({
      config: {
        connectionString: config.appInsightsConnectionString,
        enableAutoRouteTracking: true,
        disableFetchTracking: false,
        enableCorsCorrelation: false,
      },
    });
    appInsights.loadAppInsights();
    appInsights.trackPageView();
  } catch (err) {
    console.warn('Application Insights init failed', err);
    appInsights = undefined;
  }
}

function initClarity(): void {
  const id = config.clarityProjectId;
  if (!id || typeof document === 'undefined') return;
  // Guard against double-injection (e.g. React StrictMode dev double-invoke).
  if (document.getElementById('ms-clarity')) return;
  try {
    const script = document.createElement('script');
    script.id = 'ms-clarity';
    script.type = 'text/javascript';
    script.async = true;
    script.text =
      '(function(c,l,a,r,i,t,y){' +
      'c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};' +
      't=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;' +
      'y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);' +
      `})(window, document, "clarity", "script", "${id}");`;
    document.head.appendChild(script);
  } catch (err) {
    console.warn('Clarity init failed', err);
  }
}

/** Record a custom event (no-op when App Insights is not configured). */
export function trackEvent(name: string, properties?: Record<string, unknown>): void {
  appInsights?.trackEvent({ name }, properties);
}

/** Record a handled exception (no-op when App Insights is not configured). */
export function trackException(error: unknown): void {
  if (!appInsights) return;
  const exception = error instanceof Error ? error : new Error(String(error));
  appInsights.trackException({ exception } as IExceptionTelemetry);
}
