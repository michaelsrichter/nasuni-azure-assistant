import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatPanel } from '../components/ChatPanel';

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header and an empty-state hint', () => {
    render(<ChatPanel />);
    expect(screen.getByRole('heading', { name: /microsoft docs chatbot/i })).toBeInTheDocument();
    expect(screen.getByText(/Ask a question about Microsoft APIs/i)).toBeInTheDocument();
  });

  it('sends a question and renders the answer + citations', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        answer: 'Use BlobContainerClient.GetBlobs().',
        citations: [
          {
            title: 'List blobs with .NET',
            url: 'https://learn.microsoft.com/azure/storage/blobs/storage-blobs-list',
            snippet: 'List blobs in a container...'
          }
        ],
        source: 'mcp',
        elapsedMs: 1234,
        traceId: 'abcdef0123456789'
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatPanel />);

    const textarea = screen.getByLabelText(/ask a question/i);
    fireEvent.change(textarea, { target: { value: 'How do I list blobs?' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText(/Use BlobContainerClient\.GetBlobs/)).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain('/api/chat');
    expect(JSON.parse(call[1].body)).toEqual({ question: 'How do I list blobs?' });

    expect(screen.getByText(/MCP \(fallback\)/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /list blobs with \.net/i })).toHaveAttribute(
      'href',
      'https://learn.microsoft.com/azure/storage/blobs/storage-blobs-list'
    );
  });

  it('shows an error when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'boom'
      })
    );

    render(<ChatPanel />);
    fireEvent.change(screen.getByLabelText(/ask a question/i), {
      target: { value: 'hi' }
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText(/Chat request failed \(500\)/)).toBeInTheDocument();
    });
  });
});
