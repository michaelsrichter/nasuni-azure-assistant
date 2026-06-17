import { useCallback, useRef, useState } from 'react';
import { askChat, type ChatResponse, type Citation } from '../api/chat';

interface Turn {
  id: number;
  question: string;
  response?: ChatResponse;
  error?: string;
  loading: boolean;
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
    setTurns((t) => [...t, { id, question: q, loading: true }]);
    setQuestion('');
    setBusy(true);
    try {
      const response = await askChat({ question: q });
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, response, loading: false } : x)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: msg, loading: false } : x)));
    } finally {
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
          Grounded in Microsoft Learn via Azure AI Foundry Knowledge Base (with MCP fallback).
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
              <div className="role">
                Assistant
                {turn.response?.source && (
                  <span className={`source-badge ${turn.response.source}`}>
                    {turn.response.source === 'kb' ? 'Knowledge Base' : 'MCP (fallback)'}
                  </span>
                )}
              </div>
              <div className="content">
                {turn.loading && <span className="dots">Thinking&hellip;</span>}
                {turn.error && <span className="error">{turn.error}</span>}
                {turn.response && (
                  <>
                    <pre className="answer">{turn.response.answer}</pre>
                    {turn.response.citations.length > 0 && (
                      <CitationsList citations={turn.response.citations} />
                    )}
                    <div className="meta">
                      {turn.response.elapsedMs} ms
                      {turn.response.traceId ? ` · trace ${turn.response.traceId.slice(0, 8)}` : ''}
                    </div>
                  </>
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
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function CitationsList({ citations }: { citations: Citation[] }) {
  return (
    <details className="citations" open>
      <summary>{citations.length} citation{citations.length === 1 ? '' : 's'}</summary>
      <ol>
        {citations.map((c, i) => (
          <li key={`${c.url}-${i}`}>
            <a href={c.url} target="_blank" rel="noreferrer">
              {c.title || c.url}
            </a>
            {c.snippet && <div className="snippet">{c.snippet.slice(0, 240)}{c.snippet.length > 240 ? '…' : ''}</div>}
          </li>
        ))}
      </ol>
    </details>
  );
}
