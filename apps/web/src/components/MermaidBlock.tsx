// Mermaid diagram renderer for fenced ```mermaid code blocks.
// Lazy-loads the mermaid library so it doesn't bloat the initial chat bundle.
// Use `mermaidCodeOverride` as components.code in any ReactMarkdown instance.
//
// Interaction: inline diagram is compact + clickable → lightbox with zoom/pan.

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Components } from 'react-markdown';
import { Maximize2 } from 'lucide-react';

// One-time initialisation guard — mermaid.initialize() must only run once.
let mermaidReady = false;

async function loadMermaid() {
  const { default: mermaid } = await import('mermaid');
  if (!mermaidReady) {
    mermaid.initialize({
      startOnLoad: false,
      // App uses a single locked dark theme — match it.
      theme: 'dark',
      // Pin every color explicitly so a diagram can NEVER come out as light
      // text on a light fill. Mermaid's stock 'dark' theme still derives some
      // node/label fills heuristically (esp. classDef, subgraphs, sequence
      // actors, pie/gantt) and can land light-on-light. These overrides force
      // light text (the app's cream foreground) over dark fills everywhere.
      themeVariables: {
        darkMode: true,
        background: '#100c08',
        // General text — always the light cream foreground.
        textColor: '#f0e4c4',
        // Node fills + their text.
        mainBkg: '#1a1610',
        primaryColor: '#1a1610',
        primaryTextColor: '#f0e4c4',
        primaryBorderColor: 'rgba(240, 208, 128, 0.55)',
        secondaryColor: '#241d14',
        secondaryTextColor: '#f0e4c4',
        secondaryBorderColor: 'rgba(240, 208, 128, 0.45)',
        tertiaryColor: '#2e261a',
        tertiaryTextColor: '#f0e4c4',
        tertiaryBorderColor: 'rgba(240, 208, 128, 0.35)',
        // Edges + their labels.
        lineColor: '#9a8e7a',
        edgeLabelBackground: '#100c08',
        // Cluster / subgraph boxes.
        clusterBkg: '#140f0a',
        clusterBorder: 'rgba(240, 208, 128, 0.35)',
        // Notes (sequence/flow) — a slightly warm fill with light text.
        noteBkgColor: '#241d14',
        noteTextColor: '#f0e4c4',
        noteBorderColor: 'rgba(240, 208, 128, 0.45)',
        // Sequence-diagram actors + labels.
        actorBkg: '#1a1610',
        actorTextColor: '#f0e4c4',
        actorBorder: 'rgba(240, 208, 128, 0.55)',
        labelBoxBkgColor: '#1a1610',
        labelTextColor: '#f0e4c4',
        labelBoxBorderColor: 'rgba(240, 208, 128, 0.45)',
        // Generic label background used across diagram types.
        nodeTextColor: '#f0e4c4',
        titleColor: '#f0e4c4',
      },
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
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDiagram({ status: 'pending' });

    // Remove any temp/error element mermaid may have appended to <body>. On a
    // parse error, mermaid.render() injects its full-width "bomb" error graphic
    // into document.body and does NOT clean it up — that's the banner spanning
    // the screen. We pre-validate to avoid creating it, and sweep it here as a
    // belt-and-braces (the measurement element id is `d${diagramId}`).
    const sweepOrphan = () => {
      document.getElementById(diagramId)?.remove();
      document.getElementById(`d${diagramId}`)?.remove();
    };

    loadMermaid()
      .then(async (mermaid) => {
        // Validate WITHOUT rendering. suppressErrors makes parse resolve to a
        // falsy value on bad syntax instead of throwing + injecting the bomb.
        const valid = await mermaid.parse(code, { suppressErrors: true });
        if (!valid) throw new Error('Invalid diagram syntax');
        return mermaid.render(diagramId, code);
      })
      .then(({ svg }) => {
        if (!cancelled) setDiagram({ status: 'ok', svg });
      })
      .catch((err: unknown) => {
        sweepOrphan();
        if (!cancelled)
          setDiagram({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
      });

    return () => {
      cancelled = true;
      sweepOrphan();
    };
  }, [code, diagramId]);

  const fallbackBlock = (
    <pre className="overflow-auto rounded bg-muted/30 p-3 text-xs font-mono">
      <code>{code}</code>
    </pre>
  );

  if (diagram.status === 'ok') {
    return (
      <>
        {/* Inline diagram — compact glance, click to expand. */}
        <div
          role="button"
          tabIndex={0}
          className="group relative my-2 cursor-pointer overflow-x-auto [&_svg]:max-w-full"
          onClick={() => setLightboxOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setLightboxOpen(true);
          }}
          title="Click to expand"
          aria-label="Workflow diagram — click to expand"
        >
          {/* Hover affordance */}
          <div className="absolute right-2 top-2 z-10 hidden items-center gap-1 rounded bg-background/80 px-1.5 py-1 text-muted-foreground group-hover:flex">
            <Maximize2 className="h-3 w-3" />
            <span className="text-[10px] uppercase tracking-wider">expand</span>
          </div>
          {/* SVG comes from the mermaid library rendering the AI's diagram spec.
              dangerouslySetInnerHTML is safe here: mermaid's `antiscript`
              security level sanitises the output before we receive it. */}
          {/* Solid dark backdrop so the diagram is never light-on-light,
              regardless of what mermaid emits or what's behind the bubble. */}
          {/* eslint-disable-next-line react/no-danger */}
          <div
            className="rounded bg-card p-2"
            dangerouslySetInnerHTML={{ __html: diagram.svg }}
          />
        </div>
        {lightboxOpen &&
          createPortal(
            <MermaidLightbox svg={diagram.svg} onClose={() => setLightboxOpen(false)} />,
            document.body,
          )}
      </>
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

// ---------------------------------------------------------------------------
// Lightbox — zoomable / pannable overlay
// ---------------------------------------------------------------------------

function MermaidLightbox({ svg, onClose }: { svg: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  // Refs avoid stale closure issues during rapid mouse-move events.
  const pointerRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const offsetRef = useRef({ x: 0, y: 0 });

  // Keep offsetRef in sync so mouse-down always captures the current offset.
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  // Escape to close.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => Math.max(0.2, Math.min(5, s * (e.deltaY < 0 ? 1.1 : 0.9))));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    pointerRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: offsetRef.current.x,
      originY: offsetRef.current.y,
    };
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!pointerRef.current) return;
    const next = {
      x: pointerRef.current.originX + e.clientX - pointerRef.current.startX,
      y: pointerRef.current.originY + e.clientY - pointerRef.current.startY,
    };
    offsetRef.current = next;
    setOffset(next);
  }, []);

  const stopDrag = useCallback(() => {
    pointerRef.current = null;
    setIsDragging(false);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-background/80 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative flex h-[90vh] w-[min(1200px,95vw)] flex-col border border-border bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
          <span className="text-xs text-muted-foreground">scroll to zoom · drag to pan</span>
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            Close (Esc)
          </button>
        </div>
        {/* Canvas — zoom + pan surface */}
        <div
          className={`flex flex-1 select-none items-center justify-center overflow-hidden ${
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopDrag}
          onMouseLeave={stopDrag}
        >
          <div
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: 'center',
              // Suppress transition while actively dragging so it tracks the pointer.
              transition: isDragging ? 'none' : 'transform 0.08s ease-out',
            }}
          >
            {/* eslint-disable-next-line react/no-danger */}
            <div
              className="rounded bg-card p-3"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </div>
      </div>
    </div>
  );
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
