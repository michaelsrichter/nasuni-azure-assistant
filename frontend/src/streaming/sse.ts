// Minimal SSE parser over a fetch ReadableStream. The Foundry Responses API
// emits multi-line `event: …\ndata: {json}\n\n` frames; we yield one parsed
// frame per separator.

export interface SseFrame {
  event: string;
  data: string;
}

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.trim().length > 0) {
          const frame = parseBlock(buffer);
          if (frame) yield frame;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = indexOfSeparator(buffer)) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + separatorLength(buffer, sep));
        const frame = parseBlock(block);
        if (frame) yield frame;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function indexOfSeparator(s: string): number {
  const lf = s.indexOf('\n\n');
  const crlf = s.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function separatorLength(s: string, at: number): number {
  return s.startsWith('\r\n\r\n', at) ? 4 : 2;
}

function parseBlock(block: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.length === 0 || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}
