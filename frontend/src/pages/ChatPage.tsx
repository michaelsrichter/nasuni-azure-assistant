import { useCallback, useEffect, useState } from 'react';
import { ChatPanel } from '../components/ChatPanel';
import { HistoryDrawer } from '../components/HistoryDrawer';
import { HistoryIcon, PlusIcon, TrashIcon } from '../components/icons';
import type { ChatTurn } from '../lib/types';
import {
  clearSessions,
  deleteSession,
  loadSessions,
  newSessionId,
  upsertSession,
  type StoredSession,
} from '../lib/sessions';

export function ChatPage() {
  const [sessions, setSessions] = useState<StoredSession[]>(() => loadSessions());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [governanceOn, setGovernanceOn] = useState(true);

  // `chatKey` forces a fresh ChatPanel instance when starting/loading a session.
  const [chatKey, setChatKey] = useState(0);
  const [activeId, setActiveId] = useState<string>(() => newSessionId());
  const [replay, setReplay] = useState<{ turns: ChatTurn[]; readOnly: boolean } | null>(null);

  const handlePersist = useCallback(
    (turns: ChatTurn[]) => {
      setSessions(upsertSession(activeId, turns));
    },
    [activeId],
  );

  const startNewChat = useCallback(() => {
    setActiveId(newSessionId());
    setReplay(null);
    setChatKey((k) => k + 1);
    setDrawerOpen(false);
  }, []);

  const openSession = useCallback((session: StoredSession) => {
    setActiveId(session.id);
    setReplay({ turns: session.turns, readOnly: true });
    setChatKey((k) => k + 1);
    setDrawerOpen(false);
  }, []);

  const removeSession = useCallback(
    (id: string) => {
      const next = deleteSession(id);
      setSessions(next);
      if (id === activeId) startNewChat();
    },
    [startNewChat, activeId],
  );

  const clearAllSessions = useCallback(() => {
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(
        'Delete all saved conversations? This cannot be undone.',
      );
      if (!confirmed) return;
    }
    setSessions(clearSessions());
    startNewChat();
  }, [startNewChat]);

  // Lock body scroll while the drawer is open on mobile.
  useEffect(() => {
    document.body.classList.toggle('drawer-locked', drawerOpen);
    return () => document.body.classList.remove('drawer-locked');
  }, [drawerOpen]);

  return (
    <div className="chat-page">
      <aside className="history-rail" aria-label="Conversation history">
        <button type="button" className="rail-new" onClick={startNewChat}>
          <PlusIcon />
          New chat
        </button>
        <div className="rail-list">
          {sessions.length === 0 ? (
            <p className="rail-empty">No saved conversations yet.</p>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className={`rail-item${s.id === activeId ? ' active' : ''}`}
              >
                <button
                  type="button"
                  className="rail-item-main"
                  onClick={() => openSession(s)}
                  title={s.title}
                >
                  {s.title}
                </button>
                <button
                  type="button"
                  className="icon-button rail-item-delete"
                  onClick={() => removeSession(s.id)}
                  aria-label={`Delete conversation: ${s.title}`}
                >
                  <TrashIcon />
                </button>
              </div>
            ))
          )}
        </div>
        {sessions.length > 0 && (
          <button type="button" className="rail-clear-all" onClick={clearAllSessions}>
            <TrashIcon />
            Delete all
          </button>
        )}
      </aside>

      <div className="chat-main">
        <div className="chat-toolbar">
          <div className="toolbar-mobile-actions">
            <button
              type="button"
              className="icon-button history-button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open history"
            >
              <HistoryIcon />
              <span>History</span>
            </button>
            <button type="button" className="ghost-button" onClick={startNewChat}>
              <PlusIcon />
              <span>New chat</span>
            </button>
          </div>
          <label
            className={`gov-toggle${governanceOn ? ' on' : ' off'}`}
            title="Agent Governance Toolkit: deterministic policy enforcement, prompt-injection screening, sensitive-data egress control, and a tamper-evident audit log."
          >
            <input
              type="checkbox"
              checked={governanceOn}
              onChange={(e) => setGovernanceOn(e.target.checked)}
            />
            <span className="gov-toggle-track" aria-hidden>
              <span className="gov-toggle-thumb" />
            </span>
            <span className="gov-toggle-label">
              Governance {governanceOn ? 'ON' : 'OFF'}
            </span>
          </label>
        </div>

        <ChatPanel
          key={chatKey}
          initialTurns={replay?.turns ?? []}
          readOnly={replay?.readOnly ?? false}
          governanceOn={governanceOn}
          onPersist={handlePersist}
        />
      </div>

      <HistoryDrawer
        open={drawerOpen}
        sessions={sessions}
        activeId={activeId}
        onClose={() => setDrawerOpen(false)}
        onSelect={openSession}
        onDelete={removeSession}
        onClearAll={clearAllSessions}
        onNewChat={startNewChat}
      />
    </div>
  );
}
