/**
 * TranscriptProse — compact react-markdown wrapper for session transcripts.
 *
 * Derived from brain/Prose.tsx but with tighter spacing for the
 * transcript editorial layout.  Half the vertical margins, matching
 * the text-ink-2 color already used by Turn, and optional search
 * query highlighting via <mark> wrapper.
 */

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { Components } from "react-markdown";
import { cn } from "@/lib/utils";

type Props = {
  body: string;
  highlightQuery?: string;
  className?: string;
};

const components: Components = {
  h1: ({ children, ...rest }) => (
    <h1
      className="page-stamp mb-2 mt-4 text-[22px] first:mt-0"
      {...rest}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...rest }) => (
    <h2
      className="page-stamp mb-2 mt-3 text-[18px] first:mt-0"
      {...rest}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...rest }) => (
    <h3
      className="mb-1 mt-3 font-body text-[15px] font-semibold text-ink first:mt-0"
      {...rest}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...rest }) => (
    <h4
      className="mb-1 mt-2 font-body text-[14px] font-semibold text-ink-2 first:mt-0"
      {...rest}
    >
      {children}
    </h4>
  ),
  p: ({ children, ...rest }) => (
    <p
      className="mb-2 font-body text-[15px] leading-[1.6] text-ink-2 last:mb-0"
      {...rest}
    >
      {children}
    </p>
  ),
  a: ({ children, href, ...rest }) => (
    <a
      href={href}
      className="text-oxide underline decoration-oxide/40 underline-offset-2 transition-colors duration-120 ease-operator hover:no-underline"
      target="_blank"
      rel="noopener noreferrer"
      {...rest}
    >
      {children}
    </a>
  ),
  blockquote: ({ children, ...rest }) => (
    <blockquote
      className="my-2 border-l border-rule-strong pl-4 font-body text-[14px] italic text-ink-2"
      {...rest}
    >
      {children}
    </blockquote>
  ),
  code: ({ children, className: codeClassName, ...rest }) => {
    const isBlock = codeClassName?.startsWith("language-");
    if (isBlock) {
      return (
        <code
          className={cn(
            "block font-mono text-[12px] leading-snug text-ink",
            codeClassName,
          )}
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded-sm border border-rule px-1 py-0.5 font-mono text-[12px] text-ink"
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...rest }) => (
    <pre
      className="my-2 overflow-x-auto bg-surface p-3 font-mono text-[12px] leading-snug"
      {...rest}
    >
      {children}
    </pre>
  ),
  ul: ({ children, ...rest }) => (
    <ul className="mb-2 list-disc pl-5 font-body text-[15px] text-ink-2" {...rest}>
      {children}
    </ul>
  ),
  ol: ({ children, ...rest }) => (
    <ol className="mb-2 list-decimal pl-5 font-body text-[15px] text-ink-2" {...rest}>
      {children}
    </ol>
  ),
  li: ({ children, ...rest }) => (
    <li className="mb-0.5 leading-[1.6]" {...rest}>
      {children}
    </li>
  ),
  table: ({ children, ...rest }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[12px]" {...rest}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...rest }) => (
    <th
      className="border-b border-rule-strong px-2 py-1 text-left text-[10px] uppercase tracking-marker text-ink-muted"
      {...rest}
    >
      {children}
    </th>
  ),
  td: ({ children, ...rest }) => (
    <td className="border-b border-rule px-2 py-1 text-ink-2" {...rest}>
      {children}
    </td>
  ),
  hr: ({ ...rest }) => <hr className="my-3 border-rule" {...rest} />,
};

/**
 * Highlight all occurrences of `query` in `text` by wrapping matches
 * in <mark> elements.  Used as a post-render pass on the markdown
 * output so search terms remain visible inside formatted content.
 */
function highlightInNode(node: React.ReactNode, query: string): React.ReactNode {
  if (!query) return node;
  if (typeof node === "string") {
    const regex = new RegExp(
      `(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
    const parts = node.split(regex);
    if (parts.length === 1) return node;
    return parts.map((part, i) =>
      regex.test(part) ? (
        <mark key={i} className="bg-oxide-wash text-oxide">
          {part}
        </mark>
      ) : (
        part
      ),
    );
  }
  if (Array.isArray(node)) {
    return node.map((child, i) => (
      <span key={i}>{highlightInNode(child, query)}</span>
    ));
  }
  // For React elements, recurse into children
  if (node && typeof node === "object" && "props" in node) {
    const el = node as React.ReactElement<{ children?: React.ReactNode }>;
    // Don't highlight inside code blocks
    const tag = typeof el.type === "string" ? el.type : "";
    if (tag === "code" || tag === "pre") return node;
    if (el.props.children) {
      return { ...el, props: { ...el.props, children: highlightInNode(el.props.children, query) } };
    }
  }
  return node;
}

export function TranscriptProse({ body, highlightQuery, className }: Props) {
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={components}
      >
        {body}
      </ReactMarkdown>
    ),
    [body],
  );

  if (highlightQuery) {
    return (
      <div className={cn("transcript-prose", className)}>
        {highlightInNode(rendered, highlightQuery)}
      </div>
    );
  }

  return (
    <div className={cn("transcript-prose", className)}>
      {rendered}
    </div>
  );
}
