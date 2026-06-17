import type { StoredSession } from '../lib/sessions';
import { CloseIcon, PlusIcon, TrashIcon } from './icons';

interface HistoryDrawerProps {
  open: boolean;
  sessions: StoredSession[];
  activeId: string | null;
  onClose: () => void;
  onSelect: (session: StoredSession) => void;
  onDelete: (id: string) => void;
  onNewChat: () => void;
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function HistoryDrawer({
  open,
  sessions,
  activeId,
  onClose,
  onSelect,
  onDelete,
  onNewChat,
}: HistoryDrawerProps) {
  return (
    <>
      <div
        className={`drawer-overlay${open ? ' open' : ''}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`history-drawer${open ? ' open' : ''}`}
        aria-label="Conversation history"
        aria-hidden={!open}
      >
        <div className="drawer-header">
          <span className="drawer-title">History</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close history">
            <CloseIcon />
          </button>
        </div>

        <button type="button" className="drawer-new" onClick={onNewChat}>
          <PlusIcon />
          New chat
        </button>

        {sessions.length === 0 ? (
          <p className="drawer-empty">No saved conversations yet.</p>
        ) : (
          <ul className="drawer-list">
            {sessions.map((s) => (
              <li key={s.id} className={`drawer-item${s.id === activeId ? ' active' : ''}`}>
                <button type="button" className="drawer-item-main" onClick={() => onSelect(s)}>
                  <span className="drawer-item-title">{s.title}</span>
                  <span className="drawer-item-meta">{formatWhen(s.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  className="icon-button drawer-item-delete"
                  onClick={() => onDelete(s.id)}
                  aria-label={`Delete conversation: ${s.title}`}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </>
  );
}
