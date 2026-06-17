interface ToolPillProps {
  name: string;
  args?: string;
  done: boolean;
}

export function ToolPill({ name, args, done }: ToolPillProps) {
  const preview = previewArgs(args);
  return (
    <span className={`tool-pill ${done ? 'done' : 'active'}`} aria-live="polite">
      <span className="tool-pill-icon" aria-hidden>{done ? '✓' : '⋯'}</span>
      <span className="tool-pill-name">{name}</span>
      {preview && <span className="tool-pill-args">({preview})</span>}
    </span>
  );
}

function previewArgs(args: string | undefined): string | null {
  if (!args) return null;
  try {
    const obj = JSON.parse(args) as Record<string, unknown>;
    if (typeof obj.query === 'string') return truncate(obj.query, 60);
    const first = Object.values(obj)[0];
    if (typeof first === 'string') return truncate(first, 60);
  } catch {
    // partial JSON during streaming — fall through
  }
  const m = /"query"\s*:\s*"([^"]*)/.exec(args);
  if (m) return truncate(m[1], 60);
  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
