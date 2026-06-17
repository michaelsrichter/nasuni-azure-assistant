import { useCallback, useEffect, useRef, useState } from 'react';
import { streamChat, type Citation, type StreamEvent } from '../api/streamChat';
import type { ChatTurn } from '../lib/types';
import { trackEvent, trackException } from '../lib/telemetry';
import { ToolPill } from './ToolPill';
import { UsageFooter } from './UsageFooter';
import { CannedQuestions } from './CannedQuestions';

interface ChatPanelProps {
  initialTurns?: ChatTurn[];
  readOnly?: boolean;
  onPersist?: (turns: ChatTurn[]) => void;
}

export function ChatPanel({ initialTurns = [], readOnly = false, onPersist }: ChatPanelProps) {
  const [turns, setTurns] = useState<ChatTurn[]>(initialTurns);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [cannedDismissed, setCannedDismissed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const logRef = useRef<HTMLOListElement | null>(null);
  // Whether the user is currently pinned to the bottom of the log. When they
  // scroll up to read earlier content we stop auto-scrolling so the stream
  // doesn't yank them back down.
  const pinnedRef = useRef(true);

  // Per-instance id counter that won't collide with ids from a loaded session.
  const nextIdRef = useRef(
    initialTurns.reduce((max, t) => Math.max(max, t.id), 0) + 1,
  );

  // Auto-persist a session once all of its turns have settled.
  useEffect(() => {
    if (readOnly || turns.length === 0) return;
    if (turns.some((t) => !t.done)) return;
    onPersist?.(turns);
  }, [turns, readOnly, onPersist]);

  // Keep the latest content in view as the answer streams in, but only when the
  // user is already at (or near) the bottom. Scroll the log container itself
  // rather than the whole page so the rest of the layout stays put.
  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distanceFromBottom < 80;
  }, []);

  const send = useCallback(async () => {
    const q = question.trim();
    if (!q || busy || readOnly) return;

    const id = nextIdRef.current++;
    // A freshly asked question should always scroll into view.
    pinnedRef.current = true;
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
    trackEvent('question_sent', { length: q.length });

    const t0 = performance.now();
    try {
      for await (const ev of streamChat({ input: q })) {
        setTurns((all) =>
          all.map((turn) => (turn.id === id ? applyEvent(turn, ev, t0) : turn)),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      trackException(err);
      setTurns((all) =>
        all.map((turn) => (turn.id === id ? { ...turn, error: msg, done: true } : turn)),
      );
    } finally {
      setTurns((all) => all.map((turn) => (turn.id === id ? { ...turn, done: true } : turn)));
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [question, busy, readOnly]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const pickCanned = useCallback((prompt: string) => {
    setQuestion(prompt);
    setCannedDismissed(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }, []);

  const showCanned = !readOnly && turns.length === 0 && !busy && !cannedDismissed;

  return (
    <div className="chat-panel">
      {readOnly && (
        <div className="readonly-banner" role="status">
          Viewing a saved conversation. Start a new chat to ask a question.
        </div>
      )}

      <ol className="chat-log" aria-live="polite" ref={logRef} onScroll={handleScroll}>
        {showCanned && (
          <li className="canned-host">
            <CannedQuestions onSelect={pickCanned} />
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

      {!readOnly && (
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
            placeholder="Ask about deploying Nasuni on Azure…"
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
      )}
    </div>
  );
}

function applyEvent(turn: ChatTurn, ev: StreamEvent, t0: number): ChatTurn {
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
    // Nasuni file chunks have no URL and often no title, so fall back to the
    // snippet prefix to avoid collapsing distinct passages into one.
    const key = c.url || c.title || `${c.source}:${(c.snippet ?? '').slice(0, 80)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

function CitationsList({ citations }: { citations: Citation[] }) {
  const nasuni = citations.filter((c) => c.source === 'Nasuni documentation').length;
  const msLearn = citations.filter((c) => c.source === 'Microsoft Learn').length;
  const breakdown = [
    nasuni > 0 ? `${nasuni} from Nasuni docs` : null,
    msLearn > 0 ? `${msLearn} from Microsoft Learn` : null,
  ].filter(Boolean);

  return (
    <details className="citations">
      <summary>
        {citations.length} citation{citations.length === 1 ? '' : 's'}
        {breakdown.length > 0 && (
          <span className="citations-breakdown"> · {breakdown.join(' · ')}</span>
        )}
      </summary>
      <ol>
        {citations.map((c, i) => (
          <li key={`${c.url || c.title}-${i}`}>
            <div className="citation-head">
              <SourceBadge source={c.source} />
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.title || c.url}
                </a>
              ) : (
                <span className="citation-title">{c.title || 'Nasuni documentation excerpt'}</span>
              )}
            </div>
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

function SourceBadge({ source }: { source: Citation['source'] }) {
  if (source === 'Microsoft Learn') {
    return (
      <span className="source-badge source-mslearn" title="Grounded in Microsoft Learn">
        <span aria-hidden>📘</span> Microsoft Learn
      </span>
    );
  }
  if (source === 'Nasuni documentation') {
    return (
      <span className="source-badge source-nasuni" title="Grounded in the Nasuni documentation PDFs">
        <span aria-hidden>📄</span> Nasuni PDF
      </span>
    );
  }
  return (
    <span className="source-badge source-unknown" title="Knowledge base">
      <span aria-hidden>📑</span> Knowledge base
    </span>
  );
}
