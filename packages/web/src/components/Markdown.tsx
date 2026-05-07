import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
        components={{
          p: ({ children }) => <p className="text-sm text-zinc-100 leading-relaxed">{children}</p>,
          h1: ({ children }) => (
            <h1 className="text-base font-semibold text-zinc-50 mt-3 mb-1">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm font-semibold text-zinc-50 mt-3 mb-1">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold text-zinc-100 mt-2 mb-1">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="text-sm text-zinc-100 list-disc pl-5 space-y-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="text-sm text-zinc-100 list-decimal pl-5 space-y-0.5">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          code: ({ className, children }) => {
            const isBlock = className?.startsWith("language-") === true;
            if (isBlock) {
              return (
                <code className="font-mono text-xs text-zinc-200">{children}</code>
              );
            }
            return (
              <code className="font-mono text-[0.85em] bg-zinc-900 border border-zinc-800 px-1 py-0.5 rounded text-emerald-300">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="whitespace-pre-wrap text-xs bg-zinc-950 border border-zinc-800 rounded p-2 my-2 overflow-x-auto">
              {children}
            </pre>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 underline hover:text-emerald-300"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-zinc-700 pl-3 my-1 text-zinc-300 italic">
              {children}
            </blockquote>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-zinc-50">{children}</strong>
          ),
          em: ({ children }) => <em className="italic text-zinc-100">{children}</em>,
          hr: () => <hr className="border-zinc-800 my-3" />,
          table: ({ children }) => (
            <table className="text-xs my-2 border border-zinc-800">{children}</table>
          ),
          th: ({ children }) => (
            <th className="border border-zinc-800 px-2 py-1 bg-zinc-900 text-left">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-zinc-800 px-2 py-1">{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
