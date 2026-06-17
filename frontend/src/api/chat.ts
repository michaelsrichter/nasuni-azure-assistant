export interface Citation {
  title: string;
  url: string;
  snippet?: string;
}

export interface ChatRequest {
  question: string;
  history?: { role: string; content: string }[];
}

export interface ChatResponse {
  answer: string;
  citations: Citation[];
  source: string;
  elapsedMs: number;
  traceId?: string;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export async function askChat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Chat request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as ChatResponse;
}
