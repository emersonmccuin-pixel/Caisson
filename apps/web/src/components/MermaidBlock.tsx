// Mermaid diagram renderer for fenced ```mermaid code blocks.
// Lazy-loads the mermaid library so it doesn't bloat the initial chat bundle.
// Use `mermaidCodeOverride` as components.code in any ReactMarkdown instance.

import { useEffect, useId, useState } from 'react';
import type { Components } from 'react-markdown';

// One-time initialisation guard — mermaid.initialize() must only run once.
let mermaidReady = false;

async function loadMermaid() {
  const { default: mermaid } = await import('mermaid');
  if (!mermaidReady) {
    mermaid.initialize({
      startOnLoad: false,
      // App uses a single locked dark theme — match it.
      theme: 'dark',
      // antiscript strips script tags but avoids the sandboxed-iframe path
      // that can break in Electron's CSP environment.
      securityLevel: 'antiscript',
    });
    mermaidReady = true;
  }
  return mermaid;
}

type DiagramState =
  | { status: 'pending' }
  | { status: 'ok'; svg: string }
  | { status: 'error'; message: string };

export function MermaidBlock({ code }: { code: string }) {
  const reactId = useId();
  // useId may return strings like ":r0:" — strip non-alphanumeric chars so the
  // string is a valid SVG / DOM element id.
  const diagramId = `mermaid_${reactId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const [diagram, setDiagram] = useState<DiagramState>({ status: 'pending' });

  useEffect(() => {
    let cancelled = false;
    setDiagram({ status: 'pending' });

    loadMermaid()
      .then((mermaid) => mermaid.render(diagramId, code))
      .then(({ svg }) => {
        if (!cancelled) setDiagram({ status: 'ok', svg });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setDiagram({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
      });

    return () => {
      cancelled = true;
    };
  }, [code, diagramId]);

  const fallbackBlock = (
    <pre className="overflow-auto rounded bg-muted/30 p-3 text-xs font-mono">
      <code>{code}</code>
    </pre>
  );

  if (diagram.status === 'ok') {
    return (
      <div
        className="my-2 overflow-auto [&_svg]:max-w-full"
        // SVG comes from the mermaid library rendering the AI's diagram spec.
        // dangerouslySetInnerHTML is safe here: mermaid's `antiscript`
        // security level sanitises the output before we receive it.
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: diagram.svg }}
      />
    );
  }

  if (diagram.status === 'error') {
    return (
      <div>
        {fallbackBlock}
        <div className="mt-1 text-xs text-destructive">
          Diagram error: {diagram.message}
        </div>
      </div>
    );
  }

  // Pending — show raw code while the library loads (first render only).
  return fallbackBlock;
}

// Drop-in components.code override for any ReactMarkdown instance.
// Routes `language-mermaid` fenced blocks through MermaidBlock; passes all
// other <code> elements through as-is.
export const mermaidCodeOverride: Components['code'] = ({
  className,
  children,
  node: _node,
  ...props
}) => {
  if (className === 'language-mermaid') {
    return <MermaidBlock code={String(children).replace(/\n$/, '')} />;
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
};
