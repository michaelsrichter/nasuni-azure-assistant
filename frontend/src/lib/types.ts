import type { Citation, Governance } from '../api/streamChat';
import type { TokenUsage } from '../pricing';

export interface ToolCall {
  callId: string;
  name: string;
  args: string;
  done: boolean;
}

export interface ChatTurn {
  id: number;
  question: string;
  text: string;
  toolCalls: ToolCall[];
  citations: Citation[];
  governance: Governance | null;
  model: string;
  usage: TokenUsage | null;
  elapsedMs: number;
  error?: string;
  done: boolean;
}
