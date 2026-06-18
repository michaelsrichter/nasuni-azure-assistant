import { MarkdownDoc } from '../components/MarkdownDoc';
import knowledgeBaseMd from '../content/knowledge-base.md?raw';

export function KnowledgeBasePage() {
  return <MarkdownDoc title="Knowledge Base" source={knowledgeBaseMd} />;
}
