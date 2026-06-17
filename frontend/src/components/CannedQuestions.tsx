import { cannedQuestions } from '../cannedQuestions';

interface CannedQuestionsProps {
  onSelect: (prompt: string) => void;
}

export function CannedQuestions({ onSelect }: CannedQuestionsProps) {
  return (
    <section className="canned" aria-label="Suggested questions">
      <p className="canned-lead">
        Ask about deploying Nasuni on Azure — or pick a starter question:
      </p>
      <div className="canned-grid">
        {cannedQuestions.map((q) => (
          <button
            key={q.label}
            type="button"
            className="canned-card"
            onClick={() => onSelect(q.prompt)}
          >
            <span className="canned-category">{q.category}</span>
            <span className="canned-label">{q.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
