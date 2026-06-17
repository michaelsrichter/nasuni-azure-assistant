import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatPanel } from '../components/ChatPanel';

function sseStream(events: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) {
        const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
        controller.enqueue(encoder.encode(`event: ${e.event}\ndata: ${data}\n\n`));
      }
      controller.close();
    },
  });
}

function mockResponse(body: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('ChatPanel (streaming)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the canned starter questions in the empty state', () => {
    render(<ChatPanel />);
    expect(screen.getByText(/pick a starter question/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Edge Appliance VM SKUs/i }),
    ).toBeInTheDocument();
  });

  it('streams a tool call, text deltas, citations, and a usage footer', async () => {
    const citations = [
      {
        index: 1,
        title: 'List blobs with .NET',
        url: 'https://learn.microsoft.com/azure/storage/blobs/storage-blobs-list',
        snippet: 'List blobs in a container...',
      },
    ];

    const body = sseStream([
      { event: 'response.created', data: { response: { id: 'r_1' } } },
      {
        event: 'response.output_item.added',
        data: { item: { type: 'function_call', call_id: 'c1', name: 'knowledge_base_search' } },
      },
      {
        event: 'response.function_call_arguments.delta',
        data: { call_id: 'c1', delta: '{"query":"list blobs"}' },
      },
      {
        event: 'response.output_item.done',
        data: {
          item: {
            type: 'function_call_output',
            call_id: 'c1',
            output: JSON.stringify(citations),
          },
        },
      },
      { event: 'response.output_text.delta', data: { delta: 'Use ' } },
      { event: 'response.output_text.delta', data: { delta: 'BlobContainerClient.GetBlobs() [1].' } },
      {
        event: 'response.completed',
        data: {
          response: {
            id: 'r_1',
            model: 'gpt-4.1-mini',
            usage: { input_tokens: 4295, output_tokens: 88, total_tokens: 4383 },
          },
        },
      },
    ]);

    const fetchMock = vi.fn().mockResolvedValue(mockResponse(body));
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatPanel />);

    fireEvent.change(screen.getByLabelText(/ask a question/i), {
      target: { value: 'How do I list blobs?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Use BlobContainerClient\.GetBlobs/)).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain('/api/responses');
    const sent = JSON.parse(call[1].body);
    expect(sent.input).toBe('How do I list blobs?');
    expect(sent.stream).toBe(true);

    // Tool pill rendered (name humanized + completed state)
    expect(screen.getByText(/Searched the knowledge base/i)).toBeInTheDocument();

    // Citation link
    expect(
      screen.getByRole('link', { name: /list blobs with \.net/i }),
    ).toHaveAttribute('href', 'https://learn.microsoft.com/azure/storage/blobs/storage-blobs-list');

    // Usage footer
    expect(screen.getByLabelText(/token usage and estimated cost/i)).toBeInTheDocument();
    expect(screen.getByText(/4,295 in/)).toBeInTheDocument();
    expect(screen.getByText(/88 out/)).toBeInTheDocument();
    expect(screen.getByText(/gpt-4\.1-mini/)).toBeInTheDocument();
  });

  it('shows an error when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
      ),
    );

    render(<ChatPanel />);
    fireEvent.change(screen.getByLabelText(/ask a question/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Chat request failed \(500\)/)).toBeInTheDocument();
    });
  });
});
