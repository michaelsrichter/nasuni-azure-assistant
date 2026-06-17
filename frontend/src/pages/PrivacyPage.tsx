import { APP_NAME, links } from '../config';

export function PrivacyPage() {
  return (
    <article className="doc-page">
      <h1>Privacy</h1>
      <p className="doc-lead">
        {APP_NAME} is a demonstration application. This page summarizes how it
        handles data; it is not legal advice.
      </p>

      <h2>What we store</h2>
      <ul>
        <li>
          <strong>Conversation history</strong> is stored only in your browser
          (localStorage) so you can revisit past demo runs. It never leaves your
          device through this app and you can clear it at any time from the
          history panel.
        </li>
        <li>
          <strong>Theme preference</strong> (light/dark) is stored locally in your
          browser.
        </li>
      </ul>

      <h2>What we process</h2>
      <ul>
        <li>
          Questions you submit are sent to a Microsoft Foundry hosted agent to
          generate an answer. Do not submit confidential information.
        </li>
        <li>
          Aggregate, non-identifying usage telemetry may be collected via Azure
          Application Insights and Microsoft Clarity to understand feature usage
          and diagnose errors.
        </li>
      </ul>

      <h2>Third-party services</h2>
      <p>
        This demo relies on Microsoft Azure services. Their handling of data is
        governed by Microsoft&apos;s own terms. For Nasuni&apos;s corporate
        privacy practices, see the{' '}
        <a href={links.nasuniPrivacy} target="_blank" rel="noreferrer">
          Nasuni privacy policy
        </a>
        .
      </p>
    </article>
  );
}
