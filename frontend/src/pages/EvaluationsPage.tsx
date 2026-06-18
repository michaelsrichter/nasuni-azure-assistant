import { MarkdownDoc } from '../components/MarkdownDoc';
import { EvaluationRunner } from '../components/EvaluationRunner';
import evaluationsMd from '../content/evaluations.md?raw';

export function EvaluationsPage() {
  return (
    <div className="eval-page">
      <div className="doc-page eval-runner-shell">
        <h2>Run it live</h2>
        <p className="doc-lead">
          Score the deployed agent right now and watch Microsoft Foundry's
          built‑in evaluators grade groundedness, relevance, and retrieval as the
          results stream in.
        </p>
        <EvaluationRunner />
      </div>
      <MarkdownDoc title="Evaluations" source={evaluationsMd} />
    </div>
  );
}
