import { MarkdownDoc } from '../components/MarkdownDoc';
import costsMd from '../content/costs.md?raw';

export function CostsPage() {
  return <MarkdownDoc title="Cost Estimate" source={costsMd} />;
}
