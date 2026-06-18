import { MarkdownDoc } from '../components/MarkdownDoc';
import governanceMd from '../content/governance.md?raw';

export function GovernancePage() {
  return <MarkdownDoc title="AI Governance" source={governanceMd} />;
}
