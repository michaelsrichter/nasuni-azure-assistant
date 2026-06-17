import { useEffect, useRef, useState } from 'react';
// Raw markdown is bundled at build time; `server.fs.allow` permits the dev read.
import architectureMd from '../../../docs/architecture.md?raw';

type ThemeAttr = 'light' | 'dark';

function currentTheme(): ThemeAttr {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function ArchitecturePage() {
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

        const rendered = await marked.parse(architectureMd, { renderer, gfm: true });
        if (cancelled) return;
        setHtml(rendered);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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
      <h1>Architecture</h1>
      {error && <p className="error">Failed to render the architecture document: {error}</p>}
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
