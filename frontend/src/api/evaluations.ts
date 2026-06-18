import { parseSse } from '../streaming/sse';

// Client for the evaluation service (eval/service/app.py), reached at /api/eval/*.
// nginx (prod) and the vite dev server both forward /api/eval to the FastAPI
// service that runs Foundry built-in evaluators against the deployed agent.

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export interface EvaluatorInfo {
  name: string;
  label: string;
  summary: string;
}

export interface EvalInfo {
  agentUrl: string;
  projectConfigured: boolean;
  model: string | null;
  evaluators: EvaluatorInfo[];
  datasetCount: number;
}

export interface CriterionResult {
  name: string;
  label: string;
  summary: string;
  passed: number;
  failed: number;
  avgScore: number | null;
}

export interface ResultCounts {
  passed: number | null;
  failed: number | null;
  errored: number | null;
  total: number | null;
}

export interface EvalResult {
  status: string;
  counts: ResultCounts | null;
  criteria: CriterionResult[];
  reportUrl: string | null;
}

// --- Streaming events surfaced to the UI ---
export type EvalEvent =
  | { kind: 'start'; total: number; agentUrl: string; prepOnly: boolean; evaluators: EvaluatorInfo[]; projectConfigured: boolean }
  | { kind: 'prompt'; index: number; total: number; query: string; status: 'querying' | 'done' | 'skipped' | 'failed'; answerChars?: number; contextChars?: number; searchCalls?: number; error?: string }
  | { kind: 'phase'; phase: string; message: string }
  | { kind: 'status'; status: string }
  | { kind: 'result'; result: EvalResult }
  | { kind: 'log'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'done' };

export interface RunRequest {
  limit?: number | null;
  prepOnly?: boolean;
  signal?: AbortSignal;
}

export async function fetchInfo(signal?: AbortSignal): Promise<EvalInfo> {
  const res = await fetch(`${API_BASE}/api/eval/info`, { signal });
  if (!res.ok) throw new Error(`Failed to load evaluation info (${res.status})`);
  const j = await res.json();
  return {
    agentUrl: String(j.agent_url ?? ''),
    projectConfigured: Boolean(j.project_configured),
    model: j.model ?? null,
    evaluators: Array.isArray(j.evaluators) ? j.evaluators : [],
    datasetCount: Number(j.dataset_count ?? 0),
  };
}

export async function fetchDataset(signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/eval/dataset`, { signal });
  if (!res.ok) throw new Error(`Failed to load dataset (${res.status})`);
  const j = await res.json();
  return Array.isArray(j.prompts) ? j.prompts.map(String) : [];
}

export async function* runEvaluation(req: RunRequest): AsyncGenerator<EvalEvent> {
  const res = await fetch(`${API_BASE}/api/eval/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: req.limit ?? null, prep_only: req.prepOnly ?? false }),
    signal: req.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => res.statusText);
    yield { kind: 'error', message: `Evaluation request failed (${res.status}): ${text}` };
    return;
  }

  for await (const frame of parseSse(res.body)) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ev = translate(frame.event, payload);
    if (ev) yield ev;
    if (ev?.kind === 'done') return;
  }
}

function translate(event: string, p: Record<string, unknown>): EvalEvent | null {
  switch (event) {
    case 'start':
      return {
        kind: 'start',
        total: Number(p.total ?? 0),
        agentUrl: String(p.agent_url ?? ''),
        prepOnly: Boolean(p.prep_only),
        evaluators: Array.isArray(p.evaluators) ? (p.evaluators as EvaluatorInfo[]) : [],
        projectConfigured: Boolean(p.project_configured),
      };
    case 'prompt':
      return {
        kind: 'prompt',
        index: Number(p.index ?? 0),
        total: Number(p.total ?? 0),
        query: String(p.query ?? ''),
        status: normalizePromptStatus(p.status),
        answerChars: p.answer_chars == null ? undefined : Number(p.answer_chars),
        contextChars: p.context_chars == null ? undefined : Number(p.context_chars),
        searchCalls: p.search_calls == null ? undefined : Number(p.search_calls),
        error: p.error == null ? undefined : String(p.error),
      };
    case 'phase':
      return { kind: 'phase', phase: String(p.phase ?? ''), message: String(p.message ?? '') };
    case 'status':
      return { kind: 'status', status: String(p.status ?? '') };
    case 'result':
      return { kind: 'result', result: normalizeResult(p) };
    case 'log':
      return { kind: 'log', message: String(p.message ?? '') };
    case 'error':
      return { kind: 'error', message: String(p.message ?? 'Evaluation failed') };
    case 'done':
      return { kind: 'done' };
    default:
      return null;
  }
}

function normalizeResult(p: Record<string, unknown>): EvalResult {
  const countsRaw = p.counts as Record<string, unknown> | null | undefined;
  const counts: ResultCounts | null = countsRaw
    ? {
        passed: numOrNull(countsRaw.passed),
        failed: numOrNull(countsRaw.failed),
        errored: numOrNull(countsRaw.errored),
        total: numOrNull(countsRaw.total),
      }
    : null;
  const criteria = Array.isArray(p.criteria)
    ? (p.criteria as Record<string, unknown>[]).map((c) => ({
        name: String(c.name ?? ''),
        label: String(c.label ?? c.name ?? ''),
        summary: String(c.summary ?? ''),
        passed: Number(c.passed ?? 0),
        failed: Number(c.failed ?? 0),
        avgScore: numOrNull(c.avg_score),
      }))
    : [];
  return {
    status: String(p.status ?? ''),
    counts,
    criteria,
    reportUrl: p.report_url == null ? null : String(p.report_url),
  };
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type PromptStatus = 'querying' | 'done' | 'skipped' | 'failed';

function normalizePromptStatus(v: unknown): PromptStatus {
  return v === 'done' || v === 'skipped' || v === 'failed' ? v : 'querying';
}
