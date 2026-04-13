/**
 * Prose — react-markdown wrapper for the Brain reader.
 *
 * Typography mapping per DESIGN.md:
 *   h1, h2      → Instrument Serif italic (page-stamp moments)
 *   h3, h4      → Switzer 600, 15px
 *   p           → Switzer 400, 15px, line-height 1.6
 *   inline code → JetBrains Mono 13px, thin --rule outline, 2px radius
 *   pre > code  → JetBrains Mono 13px, --surface bg
 *   a           → --oxide color underline
 *   blockquote  → 1px left border --rule-strong, italic, --ink-2
 *
 * No shiki highlighting for now — plain mono code blocks.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { Components } from "react-markdown";
import { cn } from "@/lib/utils";
import { MermaidBlock } from "./MermaidBlock";

type Props = {
  body: string;
  className?: string;
};

const components: Components = {
  h1: ({ children, ...rest }) => (
    <h1
      className="page-stamp mb-4 mt-8 text-[32px] first:mt-0"
      {...rest}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...rest }) => (
    <h2
      className="page-stamp mb-3 mt-7 text-[24px] first:mt-0"
      {...rest}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...rest }) => (
    <h3
      className="mb-2 mt-6 font-body text-[15px] font-semibold text-ink first:mt-0"
      {...rest}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...rest }) => (
    <h4
      className="mb-2 mt-5 font-body text-[15px] font-semibold text-ink-2 first:mt-0"
      {...rest}
    >
      {children}
    </h4>
  ),
  p: ({ children, ...rest }) => (
    <p
      className="mb-4 font-body text-[15px] leading-[1.6] text-ink"
      {...rest}
    >
      {children}
    </p>
  ),
  a: ({ children, href, ...rest }) => (
    <a
      href={href}
      className="text-oxide underline decoration-oxide/40 underline-offset-2 transition-colors duration-120 ease-operator hover:no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-oxide-edge"
      target="_blank"
      rel="noopener noreferrer"
      {...rest}
    >
      {children}
    </a>
  ),
  blockquote: ({ children, ...rest }) => (
    <blockquote
      className="my-4 border-l border-rule-strong pl-4 font-body text-[15px] italic text-ink-2"
      {...rest}
    >
      {children}
    </blockquote>
  ),
  code: ({ children, className: codeClassName, ...rest }) => {
    // Detect if this is inside a <pre> (fenced code block) vs inline
    const isBlock = codeClassName?.startsWith("language-");

    // Mermaid fenced code blocks → render as diagram
    if (codeClassName === "language-mermaid") {
      return <MermaidBlock code={String(children).replace(/\n$/, "")} />;
    }

    if (isBlock) {
      return (
        <code
          className={cn(
            "block font-mono text-[13px] leading-snug text-ink",
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
        className="rounded-sm border border-rule px-1.5 py-0.5 font-mono text-[13px] text-ink"
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...rest }) => {
    // MermaidBlock is already a complete component — skip the pre wrapper.
    // react-markdown renders code inside pre; if the code handler returned
    // a MermaidBlock, the child won't be a <code> element.
    const child = children as React.ReactElement;
    if (child?.type === MermaidBlock) {
      return <>{children}</>;
    }
    return (
      <pre
        className="my-4 overflow-x-auto bg-surface p-4 font-mono text-[13px] leading-snug"
        {...rest}
      >
        {children}
      </pre>
    );
  },
  ul: ({ children, ...rest }) => (
    <ul className="mb-4 list-disc pl-6 font-body text-[15px] text-ink" {...rest}>
      {children}
    </ul>
  ),
  ol: ({ children, ...rest }) => (
    <ol className="mb-4 list-decimal pl-6 font-body text-[15px] text-ink" {...rest}>
      {children}
    </ol>
  ),
  li: ({ children, ...rest }) => (
    <li className="mb-1 leading-[1.6]" {...rest}>
      {children}
    </li>
  ),
  table: ({ children, ...rest }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[13px]" {...rest}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...rest }) => (
    <th
      className="border-b border-rule-strong px-3 py-1.5 text-left text-[10px] uppercase tracking-marker text-ink-muted"
      {...rest}
    >
      {children}
    </th>
  ),
  td: ({ children, ...rest }) => (
    <td className="border-b border-rule px-3 py-1.5 text-ink" {...rest}>
      {children}
    </td>
  ),
  hr: ({ ...rest }) => <hr className="my-6 border-rule" {...rest} />,
};

export function Prose({ body, className }: Props) {
  return (
    <div className={cn("prose-operator", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
