import { useEffect, useRef, useState } from 'react';

type ThemeAttr = 'light' | 'dark';

function currentTheme(): ThemeAttr {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

interface MarkdownDocProps {
  /** Heading rendered above the document body. */
  title: string;
  /** Raw markdown source (imported with Vite's `?raw`). */
  source: string;
}

/**
 * Renders a markdown document with GitHub-flavoured markdown plus mermaid
 * diagram support. Shared by the Architecture-style content pages so the
 * marked + mermaid pipeline lives in exactly one place.
 */
export function MarkdownDoc({ title, source }: MarkdownDocProps) {
  const [html, setHtml] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { marked } = await import('marked');

        // Render fenced ```mermaid blocks into <pre class="mermaid"> for mermaid.run().
        const renderer = new marked.Renderer();
        const baseCode = renderer.code.bind(renderer);
        renderer.code = (token) => {
          if (token.lang === 'mermaid') {
            return `<pre class="mermaid">${escapeHtml(token.text)}</pre>`;
          }
          return baseCode(token);
        };

        const rendered = await marked.parse(source, { renderer, gfm: true });
        if (cancelled) return;
        setHtml(rendered);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source]);

  // Render mermaid diagrams after the markdown HTML is committed to the DOM.
  useEffect(() => {
    if (!html || !containerRef.current) return;
    const container = containerRef.current;
    let cancelled = false;

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        if (cancelled) return;
        const nodes = container.querySelectorAll<HTMLElement>('pre.mermaid:not([data-processed])');
        if (nodes.length === 0) return;
        mermaid.initialize({
          startOnLoad: false,
          theme: currentTheme() === 'light' ? 'default' : 'dark',
          securityLevel: 'strict',
        });
        // Render each diagram independently so one bad block can't abort the rest.
        let i = 0;
        for (const node of Array.from(nodes)) {
          if (cancelled) return;
          node.setAttribute('data-processed', 'true');
          const code = node.textContent ?? '';
          try {
            const { svg } = await mermaid.render(`mermaid-${Date.now()}-${i++}`, code);
            const wrapper = document.createElement('div');
            wrapper.className = 'mermaid-rendered';
            wrapper.innerHTML = svg;
            node.replaceWith(wrapper);
          } catch {
            // Leave the original code block visible if a diagram fails to parse.
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [html]);

  return (
    <article className="doc-page">
      <h1>{title}</h1>
      {error && <p className="error">Failed to render this document: {error}</p>}
      <div
        ref={containerRef}
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </article>
  );
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
