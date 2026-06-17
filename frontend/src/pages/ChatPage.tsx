import { useCallback, useEffect, useState } from 'react';
import { ChatPanel } from '../components/ChatPanel';
import { HistoryDrawer } from '../components/HistoryDrawer';
import { HistoryIcon, PlusIcon } from '../components/icons';
import type { ChatTurn } from '../lib/types';
import {
  deleteSession,
  loadSessions,
  newSessionId,
  upsertSession,
  type StoredSession,
} from '../lib/sessions';

export function ChatPage() {
  const [sessions, setSessions] = useState<StoredSession[]>(() => loadSessions());
  const [drawerOpen, setDrawerOpen] = useState(false);

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
              <button
                key={s.id}
                type="button"
                className={`rail-item${s.id === activeId ? ' active' : ''}`}
                onClick={() => openSession(s)}
                title={s.title}
              >
                {s.title}
              </button>
            ))
          )}
        </div>
      </aside>

      <div className="chat-main">
        <div className="chat-toolbar">
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

        <ChatPanel
          key={chatKey}
          initialTurns={replay?.turns ?? []}
          readOnly={replay?.readOnly ?? false}
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
        onNewChat={startNewChat}
      />
    </div>
  );
}
