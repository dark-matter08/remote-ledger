import { renderMarkdown } from "../markdown";

/**
 * Model-written markdown, typeset. Uses the same rules as the rendered job
 * description, so a prep and a posting read as one document.
 */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return <div className={`jd-rendered md-free ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
