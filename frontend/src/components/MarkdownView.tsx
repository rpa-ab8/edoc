import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders a Markdown document in the viewer — formatted, and safe.
 *
 * A Markdown file can contain raw HTML (including <script>/<iframe>) and links with `javascript:`
 * URLs. None of that may run inside the app, which holds the reader's session:
 *  - `skipHtml` drops every raw HTML node; react-markdown never injects HTML (no dangerouslySetInnerHTML),
 *  - react-markdown's default `urlTransform` neutralises `javascript:`, `vbscript:`, `data:` … links,
 *  - images are NOT fetched (a document could otherwise load a tracking pixel or leak the reader's IP
 *    to a third party); they render as a link the reader can choose to open,
 *  - external links open in a new tab with `noopener noreferrer`.
 * GitHub-flavoured Markdown (tables, task lists, strikethrough, autolinks) via remark-gfm.
 */
const components: Components = {
  h1: ({ children }) => <h1 className="mb-4 mt-2 text-[28px] font-bold leading-tight tracking-[-0.5px] text-ink">{children}</h1>,
  h2: ({ children }) => (
    <h2 className="mb-3 mt-8 border-b border-line-muted pb-2 text-[21px] font-semibold tracking-[-0.3px] text-ink">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mb-2 mt-6 text-[17px] font-semibold text-ink">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-2 mt-5 text-[15px] font-semibold text-ink">{children}</h4>,
  h5: ({ children }) => <h5 className="mb-2 mt-4 text-[14px] font-semibold text-muted">{children}</h5>,
  h6: ({ children }) => <h6 className="mb-2 mt-4 text-[13.5px] font-semibold uppercase tracking-[0.05em] text-subtle">{children}</h6>,
  p: ({ children }) => <p className="my-3 text-[15px] leading-[1.7] text-ink">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-6 text-[15px] leading-[1.65] text-ink marker:text-subtle">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-6 text-[15px] leading-[1.65] text-ink marker:text-subtle">{children}</ol>,
  li: ({ children }) => <li className="pl-1 [&>input]:mr-2 [&>input]:align-middle">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-[3px] border-primary/40 bg-surface-muted/60 py-1 pl-4 pr-3 text-muted [&>p]:text-muted">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-8 border-line" />,
  a: ({ href, children }) => {
    const internal = typeof href === "string" && href.startsWith("#");
    return (
      <a
        href={href}
        className="font-medium text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
        {...(internal ? {} : { target: "_blank", rel: "noopener noreferrer nofollow" })}
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="inline-flex items-center gap-1 rounded border border-line bg-surface-muted px-1.5 py-0.5 text-[13px] text-muted hover:text-primary"
        title="Images aren't loaded automatically — open it in a new tab"
      >
        Image{alt ? `: ${alt}` : ""} ↗
      </a>
    ) : null,
  code: ({ children }) => (
    <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[13px] text-ink">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-lg border border-line bg-surface-inset p-4 font-mono text-[13px] leading-relaxed text-ink [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-left text-[14px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-muted text-[13px] font-semibold text-muted">{children}</thead>,
  th: ({ children, style }) => <th style={style} className="border-b border-line px-3.5 py-2.5">{children}</th>,
  td: ({ children, style }) => <td style={style} className="border-b border-line-muted px-3.5 py-2.5 text-ink">{children}</td>,
  del: ({ children }) => <del className="text-subtle">{children}</del>,
};

export function MarkdownView({ source }: { source: string }) {
  if (!source.trim()) {
    return <p className="text-[14.5px] text-subtle">This document is empty.</p>;
  }
  return (
    <article className="mx-auto max-w-[760px] break-words">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {source}
      </Markdown>
    </article>
  );
}
