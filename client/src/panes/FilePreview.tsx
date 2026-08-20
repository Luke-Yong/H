import { useMemo } from "react";
import type { VFile } from "./fileModel";

// ── Preview kinds ──

export type PreviewKind = "markdown" | "svg" | "image";

/** Determine whether a file can be rendered as a preview (and how). */
export function previewKindOf(file: VFile): PreviewKind | null {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "md" || ext === "markdown" || file.language === "markdown") return "markdown";
  if (ext === "svg") return "svg";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"].includes(ext)) return "image";
  return null;
}

// ── Lightweight markdown → HTML (safe: HTML is escaped first) ──

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline formatting: code, bold, italic, strikethrough, links, images. */
function renderInline(src: string): string {
  let s = escapeHtml(src);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<img src="$2" alt="$1" />');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return s;
}

function isTableSep(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

export function markdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  const para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push("<p>" + para.map(renderInline).join("<br />") + "</p>");
      para.length = 0;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^\s*```\s*([\w.-]*)\s*$/);
    if (fence) {
      flushPara();
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(escapeHtml(lines[i]));
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${buf.join("\n")}</code></pre>`);
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushPara();
      out.push("<hr />");
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push("<blockquote>" + buf.map(renderInline).join("<br />") + "</blockquote>");
      continue;
    }

    // Unordered list
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        if (m) {
          items.push(renderInline(m[1]));
          i++;
        } else if (/^\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s*[-*+]\s+/.test(lines[i + 1])) {
          i++;
        } else break;
      }
      out.push("<ul>" + items.map((it) => `<li>${it}</li>`).join("") + "</ul>");
      continue;
    }

    // Ordered list
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*\d+\.\s+(.*)$/);
        if (m) {
          items.push(renderInline(m[1]));
          i++;
        } else if (/^\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s*\d+\.\s+/.test(lines[i + 1])) {
          i++;
        } else break;
      }
      out.push("<ol>" + items.map((it) => `<li>${it}</li>`).join("") + "</ol>");
      continue;
    }

    // Table (header + separator + rows)
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        i++;
      }
      if (rows.length >= 2 && isTableSep(rows[1])) {
        const header = rows[0];
        const body = rows.slice(2);
        out.push(
          "<table><thead><tr>" +
          header.map((c) => `<th>${renderInline(c)}</th>`).join("") +
          "</tr></thead><tbody>" +
          body.map((row) => "<tr>" + row.map((c) => `<td>${renderInline(c)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>"
        );
      } else {
        for (const r of rows) para.push(r.join(" | "));
      }
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushPara();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join("\n");
}

// ── Preview component ──

export default function FilePreview({ file }: { file: VFile }) {
  const kind = previewKindOf(file);
  const mdHtml = useMemo(
    () => (kind === "markdown" ? markdownToHtml(file.content) : ""),
    [kind, file.content]
  );

  // Data URL instead of a Blob URL: React StrictMode double-runs effects and revokes
  // Blob URLs on the first cleanup pass, which leaves <img> pointing at a revoked URL.
  const svgSrc = useMemo(() => {
    if (kind !== "svg") return null;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(file.content);
  }, [kind, file.content]);

  if (!kind) return null;

  const imageSrc = file._fsPath
    ? `/api/fs/read-binary?path=${encodeURIComponent(file._fsPath)}`
    : null;

  return (
    <div className="file-preview">
      <div className="file-preview-inner">
        {kind === "markdown" && (
          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: mdHtml }} />
        )}
        {kind === "svg" && svgSrc && <img className="file-preview-img" src={svgSrc} alt={file.name} />}
        {kind === "image" && imageSrc && <img className="file-preview-img" src={imageSrc} alt={file.name} />}
        {kind === "image" && !imageSrc && (
          <div className="file-preview-msg">Binary image — save to disk to preview.</div>
        )}
      </div>
    </div>
  );
}
