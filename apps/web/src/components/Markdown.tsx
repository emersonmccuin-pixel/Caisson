// Project-wide markdown renderer. View knowledge / instructions / draft text
// through this; raw textareas stay for edit mode. Wraps ReactMarkdown with the
// canonical plugin set (gfm + breaks) and the shared `.markdown-body` styles
// from index.css.

import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { mermaidCodeOverride } from './MermaidBlock';

const COMPONENTS = { code: mermaidCodeOverride };

interface MarkdownProps {
  text: string;
  /** Optional extra classes appended to the `.markdown-body` wrapper. */
  className?: string;
}

export function Markdown({ text, className }: MarkdownProps) {
  const cls = className ? `markdown-body ${className}` : 'markdown-body';
  return (
    <div className={cls}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
