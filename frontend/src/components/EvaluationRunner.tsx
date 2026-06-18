import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchInfo,
  runEvaluation,
  type CriterionResult,
  type EvalInfo,
  type EvalResult,
  type EvaluatorInfo,
} from '../api/evaluations';
import { links } from '../config';

type Phase = 'idle' | 'preparing' | 'scoring' | 'done' | 'error';

interface PromptRow {
  index: number;
  query: string;
  status: 'querying' | 'done' | 'skipped' | 'failed';
  searchCalls?: number;
  answerChars?: number;
}

const SAMPLE_LIMIT = 3;

export function EvaluationRunner() {
  const [info, setInfo] = useState<EvalInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [statusLine, setStatusLine] = useState<string>('');
  const [rows, setRows] = useState<PromptRow[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [result, setResult] = useState<EvalResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const running = phase === 'preparing' || phase === 'scoring';

  useEffect(() => {
    const controller = new AbortController();
    fetchInfo(controller.signal)
      .then(setInfo)
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setInfoError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const evaluators: EvaluatorInfo[] = info?.evaluators ?? [];

  const preparedCount = useMemo(
    () => rows.filter((r) => r.status === 'done').length,
    [rows],
  );

  const start = useCallback(
    async (opts: { limit: number | null; prepOnly: boolean }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setPhase('preparing');
      setError(null);
      setResult(null);
      setRows([]);
      setTotal(0);
      setStatusLine('Starting evaluation…');

      try {
        for await (const ev of runEvaluation({
          limit: opts.limit,
          prepOnly: opts.prepOnly,
          signal: controller.signal,
        })) {
          switch (ev.kind) {
            case 'start':
              setTotal(ev.total);
              setStatusLine(`Querying the live agent for ${ev.total} prompt(s)…`);
              break;
            case 'prompt':
              setRows((prev) => {
                const next = [...prev];
                const i = next.findIndex((r) => r.index === ev.index);
                const row: PromptRow = {
                  index: ev.index,
                  query: ev.query,
                  status: ev.status,
                  searchCalls: ev.searchCalls,
                  answerChars: ev.answerChars,
                };
                if (i === -1) next.push(row);
                else next[i] = row;
                next.sort((a, b) => a.index - b.index);
                return next;
              });
              break;
            case 'phase':
              if (ev.phase === 'upload' || ev.phase === 'evaluate' || ev.phase === 'poll') {
                setPhase('scoring');
              }
              setStatusLine(ev.message);
              break;
            case 'status':
              setStatusLine(`Scoring with Foundry evaluators — status: ${ev.status}`);
              break;
            case 'result':
              setResult(ev.result);
              break;
            case 'error':
              setError(ev.message);
              setPhase('error');
              break;
            case 'done':
              setPhase((p) => (p === 'error' ? p : 'done'));
              break;
            default:
              break;
          }
        }
      } catch (e: unknown) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase('error');
        }
      } finally {
        setPhase((p) => (p === 'preparing' || p === 'scoring' ? 'done' : p));
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setStatusLine('Canceled.');
    setPhase('idle');
  }, []);

  const progressPct = total > 0 ? Math.round((rows.length / total) * 100) : 0;

  return (
    <section className="eval-runner" aria-label="Run evaluation">
      <div className="eval-toolbar">
        <div className="eval-toolbar-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={running || !info}
            onClick={() => start({ limit: SAMPLE_LIMIT, prepOnly: false })}
          >
            Run sample ({SAMPLE_LIMIT})
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={running || !info}
            onClick={() => start({ limit: null, prepOnly: false })}
          >
            Run full set{info ? ` (${info.datasetCount})` : ''}
          </button>
          {running && (
            <button type="button" className="btn-ghost" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
        {info && (
          <p className="eval-config">
            Judge model <code>{info.model ?? 'n/a'}</code>
            {info.projectConfigured ? (
              <span className="eval-pill ok">Foundry project connected</span>
            ) : (
              <span className="eval-pill warn">scoring not configured</span>
            )}
          </p>
        )}
      </div>

      {infoError && (
        <p className="eval-error">
          Could not reach the evaluation service: {infoError}. Make sure it is
          running (see the Evaluations section of the README).
        </p>
      )}

      {/* What each evaluator measures */}
      {evaluators.length > 0 && (
        <div className="eval-criteria-cards">
          {evaluators.map((e) => (
            <div key={e.name} className="eval-criterion-card">
              <h3>{e.label}</h3>
              <p>{e.summary}</p>
            </div>
          ))}
        </div>
      )}

      {/* Progress */}
      {(running || rows.length > 0 || phase === 'done') && (
        <div className="eval-progress">
          <div className="eval-progress-head">
            <span className={`eval-spinner${running ? ' on' : ''}`} aria-hidden />
            <span className="eval-status-line">{statusLine || 'Ready.'}</span>
            {total > 0 && (
              <span className="eval-count">
                {rows.length}/{total}
              </span>
            )}
          </div>
          <div className="eval-bar" role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
            <div className={`eval-bar-fill${phase === 'scoring' ? ' indeterminate' : ''}`} style={{ width: `${progressPct}%` }} />
          </div>

          {rows.length > 0 && (
            <ul className="eval-prompt-list">
              {rows.map((r) => (
                <li key={r.index} className={`eval-prompt eval-prompt-${r.status}`}>
                  <span className="eval-prompt-icon" aria-hidden>
                    {r.status === 'done' ? '✓' : r.status === 'querying' ? '…' : r.status === 'failed' ? '✕' : '–'}
                  </span>
                  <span className="eval-prompt-text" title={r.query}>
                    {r.query}
                  </span>
                  {r.status === 'done' && (
                    <span className="eval-prompt-meta">
                      {r.searchCalls ?? 0} search · {r.answerChars ?? 0} chars
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="eval-error">{error}</p>}

      {/* Results */}
      {result && (
        <EvalResultView result={result} preparedCount={preparedCount} evaluators={evaluators} />
      )}

      <p className="eval-footnote">
        Powered by Microsoft Foundry built‑in evaluators via the{' '}
        <a href={links.foundry} target="_blank" rel="noreferrer">
          Foundry evaluations API
        </a>
        . Runs are scored keyless with a managed identity and logged to your
        Foundry project.
      </p>
    </section>
  );
}

function EvalResultView({
  result,
  preparedCount,
  evaluators,
}: {
  result: EvalResult;
  preparedCount: number;
  evaluators: EvaluatorInfo[];
}) {
  if (result.status === 'prep_only') {
    return (
      <div className="eval-results">
        <h2>Prepared {preparedCount} row(s)</h2>
        <p className="eval-lead">
          The agent answered every prompt and the rows are ready to score. Run
          again without “prepare only” to send them to the Foundry evaluators.
        </p>
      </div>
    );
  }

  const summaryByName = new Map(evaluators.map((e) => [e.name, e.summary] as const));
  const criteria: CriterionResult[] = result.criteria ?? [];
  const counts = result.counts;
  const overall =
    counts && counts.total
      ? Math.round(((counts.passed ?? 0) / counts.total) * 100)
      : null;

  return (
    <div className="eval-results">
      <div className="eval-results-head">
        <h2>Results</h2>
        <span className={`eval-pill ${result.status === 'completed' ? 'ok' : 'warn'}`}>{result.status}</span>
      </div>

      {overall != null && (
        <div className="eval-scorecard">
          <div className="eval-score-big">
            <span className="eval-score-value">{overall}%</span>
            <span className="eval-score-label">overall pass rate</span>
          </div>
          {counts && (
            <ul className="eval-score-breakdown">
              <li><strong>{counts.passed ?? 0}</strong> passed</li>
              <li><strong>{counts.failed ?? 0}</strong> failed</li>
              {counts.errored ? <li><strong>{counts.errored}</strong> errored</li> : null}
              <li><strong>{counts.total ?? 0}</strong> total checks</li>
            </ul>
          )}
        </div>
      )}

      {criteria.length > 0 && (
        <table className="eval-results-table">
          <thead>
            <tr>
              <th>Evaluator</th>
              <th>Passed</th>
              <th>Failed</th>
              <th>Avg score</th>
            </tr>
          </thead>
          <tbody>
            {criteria.map((c) => {
              const totalC = c.passed + c.failed;
              const pct = totalC ? Math.round((c.passed / totalC) * 100) : null;
              return (
                <tr key={c.name}>
                  <td>
                    <div className="eval-eval-name">{c.label}</div>
                    <div className="eval-eval-summary">{c.summary || summaryByName.get(c.name)}</div>
                  </td>
                  <td>
                    {c.passed}
                    {pct != null && <span className="eval-eval-pct"> ({pct}%)</span>}
                  </td>
                  <td>{c.failed}</td>
                  <td>{c.avgScore == null ? '—' : c.avgScore.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {result.reportUrl && (
        <p className="eval-report-link">
          <a href={result.reportUrl} target="_blank" rel="noreferrer">
            Open the full report in the Foundry portal →
          </a>
        </p>
      )}
    </div>
  );
}
