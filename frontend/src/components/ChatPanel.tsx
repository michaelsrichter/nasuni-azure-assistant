import { useCallback, useRef, useState } from 'react';
import { streamChat, type Citation, type StreamEvent } from '../api/streamChat';
import type { TokenUsage } from '../pricing';
import { ToolPill } from './ToolPill';
import { UsageFooter } from './UsageFooter';

interface ToolCall {
  callId: string;
  name: string;
  args: string;
  done: boolean;
}

interface Turn {
  id: number;
  question: string;
  text: string;
  toolCalls: ToolCall[];
  citations: Citation[];
  model: string;
  usage: TokenUsage | null;
  elapsedMs: number;
  error?: string;
  done: boolean;
}

let nextId = 1;

export function ChatPanel() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const send = useCallback(async () => {
    const q = question.trim();
    if (!q || busy) return;

    const id = nextId++;
    setTurns((t) => [
      ...t,
      {
        id,
        question: q,
        text: '',
        toolCalls: [],
        citations: [],
        model: '',
        usage: null,
        elapsedMs: 0,
        done: false,
      },
    ]);
    setQuestion('');
    setBusy(true);

    const t0 = performance.now();
    try {
      for await (const ev of streamChat({ input: q })) {
        setTurns((all) =>
          all.map((turn) => (turn.id === id ? applyEvent(turn, ev, t0) : turn)),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTurns((all) =>
        all.map((turn) => (turn.id === id ? { ...turn, error: msg, done: true } : turn)),
      );
    } finally {
      setTurns((all) => all.map((turn) => (turn.id === id ? { ...turn, done: true } : turn)));
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [question, busy]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="chat-panel">
      <header className="chat-header">
        <h1>Microsoft Docs Chatbot</h1>
        <p className="subtitle">
          Streamed from a Foundry hosted agent grounded in Microsoft Learn via the
          kb-mslearn Knowledge Base.
        </p>
      </header>

      <ol className="chat-log" aria-live="polite">
        {turns.length === 0 && (
          <li className="hint">
            Ask a question about Microsoft APIs &mdash; for example,{' '}
            <em>&ldquo;How do I list blobs with Azure.Storage.Blobs in C#?&rdquo;</em>
          </li>
        )}
        {turns.map((turn) => (
          <li key={turn.id} className="chat-turn">
            <div className="bubble user">
              <div className="role">You</div>
              <div className="content">{turn.question}</div>
            </div>
            <div className="bubble assistant">
              <div className="role">Assistant</div>
              <div className="content">
                {turn.toolCalls.length > 0 && (
                  <div className="tool-pills">
                    {turn.toolCalls.map((tc) => (
                      <ToolPill key={tc.callId} name={tc.name} args={tc.args} done={tc.done} />
                    ))}
                  </div>
                )}
                {turn.error && <span className="error">{turn.error}</span>}
                {turn.text.length > 0 && <pre className="answer">{turn.text}</pre>}
                {!turn.done && turn.text.length === 0 && turn.toolCalls.length === 0 && (
                  <span className="dots">Thinking&hellip;</span>
                )}
                {turn.citations.length > 0 && <CitationsList citations={turn.citations} />}
                {turn.usage && (
                  <UsageFooter model={turn.model} usage={turn.usage} elapsedMs={turn.elapsedMs} />
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={inputRef}
          aria-label="Ask a question"
          placeholder="Ask about a Microsoft API…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          disabled={busy}
        />
        <button type="submit" disabled={busy || question.trim().length === 0}>
          {busy ? 'Streaming…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function applyEvent(turn: Turn, ev: StreamEvent, t0: number): Turn {
  switch (ev.kind) {
    case 'toolCallStarted':
      return {
        ...turn,
        toolCalls: [
          ...turn.toolCalls,
          { callId: ev.callId, name: ev.name, args: '', done: false },
        ],
      };
    case 'toolCallArgsDelta':
      return {
        ...turn,
        toolCalls: turn.toolCalls.map((tc) =>
          tc.callId === ev.callId ? { ...tc, args: tc.args + ev.delta } : tc,
        ),
      };
    case 'toolCallCompleted':
      return {
        ...turn,
        toolCalls: turn.toolCalls.map((tc) =>
          tc.callId === ev.callId ? { ...tc, done: true } : tc,
        ),
        citations: dedupeCitations([...turn.citations, ...ev.citations]),
      };
    case 'textDelta':
      return { ...turn, text: turn.text + ev.delta };
    case 'completed':
      return {
        ...turn,
        model: ev.model,
        usage: ev.usage,
        elapsedMs: Math.round(performance.now() - t0),
        done: true,
      };
    case 'error':
      return { ...turn, error: ev.message, done: true };
    case 'created':
    default:
      return turn;
  }
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const key = c.url || c.title;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

function CitationsList({ citations }: { citations: Citation[] }) {
  return (
    <details className="citations" open>
      <summary>
        {citations.length} citation{citations.length === 1 ? '' : 's'}
      </summary>
      <ol>
        {citations.map((c, i) => (
          <li key={`${c.url}-${i}`}>
            <a href={c.url} target="_blank" rel="noreferrer">
              {c.title || c.url}
            </a>
            {c.snippet && (
              <div className="snippet">
                {c.snippet.slice(0, 240)}
                {c.snippet.length > 240 ? '…' : ''}
              </div>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
