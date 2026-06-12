import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

interface Props {
  readonly text: string;
}

// Memoized markdown renderer for transcript message bodies. Memoization is
// load-bearing — long transcripts can have hundreds of messages and
// re-parsing every one on each render stutters scrolling. React.memo with
// a primitive `text` prop hits the cache for free across re-renders.
//
// Syntax highlighting in code blocks is intentionally not wired up yet —
// see #43 acceptance: the heavier highlight.js / Shiki integration lands
// as a follow-up. CSS-styled <pre> is the placeholder.
export const Markdown = memo(function Markdown({ text }: Props) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          p: ({ children }) => <p className="text-sm text-text leading-relaxed">{children}</p>,
          h1: ({ children }) => (
            <h1 className="text-base font-semibold text-text mt-3 mb-1">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm font-semibold text-text mt-3 mb-1">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold text-text mt-2 mb-1">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="text-sm text-text list-disc pl-5 space-y-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="text-sm text-text list-decimal pl-5 space-y-0.5">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          code: ({ className, children }) => {
            // rehype-highlight rewrites a fenced block's <code> className to
            // include `hljs` + `language-x` and replaces children with token
            // spans. Pass className through so the theme + token colors apply.
            const isBlock =
              className !== undefined && /\b(?:language-|hljs)\b/.test(className);
            if (isBlock) {
              return <code className={`font-mono text-xs ${className}`}>{children}</code>;
            }
            return (
              <code className="font-mono text-[0.85em] bg-surface border border-border px-1 py-0.5 rounded text-accent">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="whitespace-pre-wrap text-xs bg-bg border border-border rounded p-2 my-2 overflow-x-auto">
              {children}
            </pre>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-info-text underline hover:text-info"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border-strong pl-3 my-1 text-text-soft italic">
              {children}
            </blockquote>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-text">{children}</strong>
          ),
          em: ({ children }) => <em className="italic text-text">{children}</em>,
          hr: () => <hr className="border-border my-3" />,
          table: ({ children }) => (
            <table className="text-xs my-2 border border-border">{children}</table>
          ),
          th: ({ children }) => (
            <th className="border border-border px-2 py-1 bg-surface text-left">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-1">{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
