import { lazy, Suspense } from "react";

// The Markdown renderer (react-markdown + remark-gfm) is only needed when a Markdown file is opened,
// so it is split into its own chunk instead of growing the bundle every user downloads.
const MarkdownView = lazy(() => import("./MarkdownView").then((m) => ({ default: m.MarkdownView })));

export function LazyMarkdownView({ source }: { source: string }) {
  return (
    <Suspense fallback={<p className="text-[14.5px] text-muted">Preparing preview…</p>}>
      <MarkdownView source={source} />
    </Suspense>
  );
}
