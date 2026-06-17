// View-only conversation history, persisted client-side in localStorage.
//
// There is no backend database in this architecture, so each completed
// conversation's transcript is stored locally so the user can revisit past
// demo runs. Selecting a stored session replays it read-only; starting a new
// chat begins a fresh session.

import type { ChatTurn } from './types';

export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
}

const STORAGE_KEY = 'nasuni-azure-assistant.sessions';
const MAX_SESSIONS = 50;

function read(): StoredSession[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredSession[]) : [];
  } catch {
    return [];
  }
}

function write(sessions: StoredSession[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
  } catch {
    /* storage full or unavailable — ignore */
  }
}

export function loadSessions(): StoredSession[] {
  return read().sort((a, b) => b.updatedAt - a.updatedAt);
}

function deriveTitle(turns: ChatTurn[]): string {
  const first = turns.find((t) => t.question.trim().length > 0);
  const text = first?.question.trim() ?? 'New conversation';
  return text.length > 70 ? `${text.slice(0, 70)}…` : text;
}

/** Insert or update a session keyed by id; returns the saved list. */
export function upsertSession(id: string, turns: ChatTurn[]): StoredSession[] {
  if (turns.length === 0) return loadSessions();
  const sessions = read();
  const now = Date.now();
  const existing = sessions.find((s) => s.id === id);
  if (existing) {
    existing.turns = turns;
    existing.updatedAt = now;
    existing.title = deriveTitle(turns);
  } else {
    sessions.push({
      id,
      title: deriveTitle(turns),
      createdAt: now,
      updatedAt: now,
      turns,
    });
  }
  write(sessions);
  return loadSessions();
}

export function deleteSession(id: string): StoredSession[] {
  write(read().filter((s) => s.id !== id));
  return loadSessions();
}

export function clearSessions(): StoredSession[] {
  write([]);
  return [];
}

export function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
