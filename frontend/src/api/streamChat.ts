import { parseSse } from '../streaming/sse';
import type { TokenUsage } from '../pricing';

// --- Citation shape (matches what the agent's knowledge_base_search tool returns) ---
export interface Citation {
  index: number;
  title: string;
  url: string;
  snippet?: string;
}

// --- Stream events surfaced to the UI ---
export type StreamEvent =
  | { kind: 'created'; responseId: string }
  | { kind: 'toolCallStarted'; callId: string; name: string }
  | { kind: 'toolCallArgsDelta'; callId: string; delta: string }
  | { kind: 'toolCallCompleted'; callId: string; name: string; citations: Citation[] }
  | { kind: 'textDelta'; delta: string }
  | { kind: 'completed'; model: string; usage: TokenUsage | null }
  | { kind: 'error'; message: string };

export interface StreamRequest {
  input: string;
  conversationId?: string;
  signal?: AbortSignal;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export async function* streamChat(req: StreamRequest): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = { input: req.input, stream: true };
  if (req.conversationId) body.conversation = req.conversationId;

  const res = await fetch(`${API_BASE}/api/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => res.statusText);
    yield { kind: 'error', message: `Chat request failed (${res.status}): ${text}` };
    return;
  }

  const toolCallNames = new Map<string, string>(); // callId -> tool name

  for await (const frame of parseSse(res.body)) {
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const ev = translate(frame.event, payload, toolCallNames);
    if (ev) yield ev;
  }
}

function translate(event: string, payload: unknown, toolCallNames: Map<string, string>): StreamEvent | null {
  const p = payload as Record<string, unknown>;

  switch (event) {
    case 'response.created': {
      const response = p.response as { id?: string } | undefined;
      return { kind: 'created', responseId: response?.id ?? '' };
    }

    case 'response.output_item.added': {
      const item = p.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call') {
        const callId = String(item.call_id ?? item.id ?? '');
        const name = String(item.name ?? '');
        toolCallNames.set(callId, name);
        return { kind: 'toolCallStarted', callId, name };
      }
      return null;
    }

    case 'response.function_call_arguments.delta': {
      const callId = String(p.call_id ?? p.item_id ?? '');
      const delta = String(p.delta ?? '');
      return { kind: 'toolCallArgsDelta', callId, delta };
    }

    case 'response.output_item.done': {
      const item = p.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call_output') {
        const callId = String(item.call_id ?? '');
        const name = toolCallNames.get(callId) ?? '';
        const citations = parseCitations(item.output);
        return { kind: 'toolCallCompleted', callId, name, citations };
      }
      return null;
    }

    case 'response.output_text.delta': {
      return { kind: 'textDelta', delta: String(p.delta ?? '') };
    }

    case 'response.completed': {
      const response = p.response as Record<string, unknown> | undefined;
      const model = String(response?.model ?? '');
      const usageRaw = response?.usage as Record<string, unknown> | undefined;
      const usage: TokenUsage | null = usageRaw
        ? {
            inputTokens: Number(usageRaw.input_tokens ?? 0),
            outputTokens: Number(usageRaw.output_tokens ?? 0),
            totalTokens: Number(usageRaw.total_tokens ?? 0),
          }
        : null;
      return { kind: 'completed', model, usage };
    }

    case 'response.failed':
    case 'response.error': {
      const err = (p.error as { message?: string } | undefined) ?? (p as { message?: string });
      return { kind: 'error', message: err?.message ?? 'Stream failed' };
    }

    default:
      return null;
  }
}

function parseCitations(output: unknown): Citation[] {
  if (typeof output !== 'string') return [];
  try {
    const arr = JSON.parse(output);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x, i) => ({
        index: Number(x.index ?? i + 1),
        title: String(x.title ?? ''),
        url: String(x.url ?? ''),
        snippet: x.snippet == null ? undefined : String(x.snippet),
      }));
  } catch {
    return [];
  }
}
