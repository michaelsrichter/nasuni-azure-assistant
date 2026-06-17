import { describe, it, expect } from 'vitest';
import { parseSse } from '../streaming/sse';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe('parseSse', () => {
  it('parses a single event with explicit event name', async () => {
    const stream = streamOf('event: response.created\ndata: {"id":"r1"}\n\n');
    const frames = await collect(parseSse(stream));
    expect(frames).toEqual([{ event: 'response.created', data: '{"id":"r1"}' }]);
  });

  it('parses multiple events in one chunk', async () => {
    const stream = streamOf(
      'event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n',
    );
    const frames = await collect(parseSse(stream));
    expect(frames.map((f) => `${f.event}:${f.data}`)).toEqual(['a:1', 'b:2', 'c:3']);
  });

  it('handles events split across chunk boundaries', async () => {
    const stream = streamOf('event: response.output_text', '.delta\ndata: {"de', 'lta":"hi"}\n\n');
    const frames = await collect(parseSse(stream));
    expect(frames).toEqual([{ event: 'response.output_text.delta', data: '{"delta":"hi"}' }]);
  });

  it('joins multi-line data fields with newlines', async () => {
    const stream = streamOf('event: x\ndata: line1\ndata: line2\n\n');
    const frames = await collect(parseSse(stream));
    expect(frames).toEqual([{ event: 'x', data: 'line1\nline2' }]);
  });

  it('skips comment lines and empty separators', async () => {
    const stream = streamOf(':keepalive\n\nevent: ok\ndata: 1\n\n');
    const frames = await collect(parseSse(stream));
    expect(frames).toEqual([{ event: 'ok', data: '1' }]);
  });

  it('defaults event to "message" when no event field is present', async () => {
    const stream = streamOf('data: just-data\n\n');
    const frames = await collect(parseSse(stream));
    expect(frames).toEqual([{ event: 'message', data: 'just-data' }]);
  });

  it('handles CRLF line endings', async () => {
    const stream = streamOf('event: ok\r\ndata: 1\r\n\r\n');
    const frames = await collect(parseSse(stream));
    expect(frames).toEqual([{ event: 'ok', data: '1' }]);
  });
});
