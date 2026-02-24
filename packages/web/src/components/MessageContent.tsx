import React, { useState, useCallback, useMemo, useEffect } from "react";
import { E2eService } from "../e2e";
import { openImageLightbox } from "./ImageLightbox";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single option in an action card (button or select item). */
type ActionItem = {
  label: string;
  value: string;
  style?: "primary" | "secondary" | "danger";
};

/** Parsed action block data from ```action fenced blocks. */
type ParsedAction = {
  kind: "buttons" | "confirm" | "select" | "input";
  prompt?: string;
  items?: ActionItem[];
  placeholder?: string;
};

type MessageContentProps = {
  text: string;
  mediaUrl?: string;
  /** Message ID — used to derive E2E decryption context as "{messageId}:media" */
  messageId?: string;
  /** Whether this message was E2E encrypted (media binary may also be encrypted) */
  encrypted?: boolean;
  a2ui?: string;
  className?: string;
  isStreaming?: boolean;
  /** Called when user clicks an A2UI action button */
  onAction?: (action: string, payload?: Record<string, unknown>) => void;
  /** Called when user resolves an action card */
  onResolveAction?: (value: string, label: string) => void;
  /** Already-resolved actions keyed by prompt hash */
  resolvedActions?: Record<string, { value: string; label: string }>;
};

// ---------------------------------------------------------------------------
// A2UI types (subset of v0.8 spec we render)
// ---------------------------------------------------------------------------

type A2UIComponent =
  | { Text: { text: A2UIValue; usageHint?: string } }
  | { Button: { label: A2UIValue; action?: A2UIAction; style?: string } }
  | { Column: { children: A2UIChildren; gap?: number } }
  | { Row: { children: A2UIChildren; gap?: number } }
  | { Card: { children: A2UIChildren; title?: A2UIValue } }
  | { List: { children: A2UIChildren } }
  | { Image: { url: A2UIValue; alt?: A2UIValue; usageHint?: string } }
  | { Divider: Record<string, unknown> }
  | { Icon: { name: A2UIValue } };

type A2UIValue = { literalString: string } | { dataPath: string } | string;
type A2UIAction = { sendMessage?: string; [key: string]: unknown };
type A2UIChildren = { explicitList: string[] } | string[];

type A2UIComponentEntry = {
  id: string;
  component: A2UIComponent;
};

type A2UISurfaceUpdate = {
  surfaceUpdate: {
    surfaceId: string;
    components: A2UIComponentEntry[];
  };
};

type A2UIBeginRendering = {
  beginRendering: {
    surfaceId: string;
    root: string;
  };
};

type A2UIDataModelUpdate = {
  dataModelUpdate: {
    surfaceId: string;
    updates: { path: string; value: A2UIValue }[];
  };
};

type A2UIMessage = A2UISurfaceUpdate | A2UIBeginRendering | A2UIDataModelUpdate;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveValue(val: A2UIValue | undefined): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if ("literalString" in val) return val.literalString;
  if ("dataPath" in val) return `{{${val.dataPath}}}`;
  return "";
}

function resolveChildren(children: A2UIChildren | undefined): string[] {
  if (!children) return [];
  if (Array.isArray(children)) return children;
  if ("explicitList" in children) return children.explicitList;
  return [];
}

// ---------------------------------------------------------------------------
// Code block with copy button + syntax highlighting
// ---------------------------------------------------------------------------

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  const code = String(children).replace(/\n$/, "");
  // Extract language from className (e.g. "language-python" -> "python")
  const lang = className?.replace(/^language-/, "") ?? "";

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <div className="group/code relative my-2 rounded-md overflow-hidden" style={{ border: "1px solid var(--border)" }}>
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-3 py-1.5"
        style={{ background: "var(--bg-hover)", borderBottom: "1px solid var(--border)" }}
      >
        <span className="text-tiny font-mono uppercase" style={{ color: "var(--text-muted)" }}>
          {lang || "code"}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-tiny transition-colors"
          style={{
            color: copied ? "var(--accent-green)" : "var(--text-muted)",
            background: "transparent",
          }}
          title="Copy code"
        >
          {copied ? (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Copied
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      {/* Code content — rehype-highlight adds classes to <code> */}
      <pre
        className="overflow-x-auto p-3 text-[13px] leading-[1.5]"
        style={{ background: "var(--code-bg)", color: "var(--text-primary)", margin: 0 }}
      >
        <code className={className} style={{ fontFamily: "var(--font-mono)" }}>
          {children}
        </code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Enhanced table
// ---------------------------------------------------------------------------

function DataTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-2 overflow-x-auto rounded-md" style={{ border: "1px solid var(--border)" }}>
      <table
        className="min-w-full text-[13px]"
        style={{ borderCollapse: "collapse" }}
      >
        {children}
      </table>
    </div>
  );
}

function TableHead({ children }: { children: React.ReactNode }) {
  return (
    <thead style={{ background: "var(--bg-hover)" }}>
      {children}
    </thead>
  );
}

function TableRow({ children, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      {...props}
      style={{ borderBottom: "1px solid var(--border)" }}
      className="hover:bg-[--bg-hover] transition-colors"
    >
      {children}
    </tr>
  );
}

function TableCell({
  children,
  isHeader = false,
  style,
}: {
  children: React.ReactNode;
  isHeader?: boolean;
  style?: React.CSSProperties;
}) {
  const Tag = isHeader ? "th" : "td";
  return (
    <Tag
      className={`px-3 py-2 text-left ${isHeader ? "font-bold" : ""}`}
      style={{
        color: isHeader ? "var(--text-primary)" : "var(--text-secondary)",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// A2UI Renderer
// ---------------------------------------------------------------------------

function A2UIRenderer({
  jsonl,
  onAction,
}: {
  jsonl: string;
  onAction?: (action: string, payload?: Record<string, unknown>) => void;
}) {
  const parsed = useMemo(() => parseA2UI(jsonl), [jsonl]);

  if (!parsed) {
    // Fallback: show raw JSONL in a code block
    return (
      <div
        className="mt-2 px-2 py-1.5 rounded-sm text-caption"
        style={{ background: "var(--code-bg)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
      >
        <span className="font-bold text-tiny" style={{ color: "var(--text-muted)" }}>A2UI</span>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words max-h-32" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {jsonl}
        </pre>
      </div>
    );
  }

  return (
    <div className="mt-1">
      {renderA2UIComponent(parsed.rootId, parsed.components, onAction)}
    </div>
  );
}

type ParsedA2UI = {
  rootId: string;
  components: Map<string, A2UIComponent>;
};

function parseA2UI(jsonl: string): ParsedA2UI | null {
  try {
    const lines = jsonl.trim().split("\n").filter(Boolean);
    const components = new Map<string, A2UIComponent>();
    let rootId = "";

    for (const line of lines) {
      const msg = JSON.parse(line) as A2UIMessage;

      if ("surfaceUpdate" in msg) {
        for (const entry of msg.surfaceUpdate.components) {
          components.set(entry.id, entry.component);
        }
      }
      if ("beginRendering" in msg) {
        rootId = msg.beginRendering.root;
      }
    }

    if (!rootId || components.size === 0) return null;
    return { rootId, components };
  } catch {
    return null;
  }
}

function renderA2UIComponent(
  id: string,
  components: Map<string, A2UIComponent>,
  onAction?: (action: string, payload?: Record<string, unknown>) => void,
): React.ReactNode {
  const comp = components.get(id);
  if (!comp) return null;

  // Text
  if ("Text" in comp) {
    const { text, usageHint } = comp.Text;
    const content = resolveValue(text);
    const tag = usageHint ?? "body";

    const styleMap: Record<string, string> = {
      h1: "text-h1 font-bold",
      h2: "text-h2 font-bold",
      h3: "text-[14px] font-bold",
      h4: "text-caption font-bold",
      h5: "text-tiny font-bold uppercase tracking-wide",
      caption: "text-caption",
      body: "text-body",
    };

    return (
      <p
        key={id}
        className={`${styleMap[tag] ?? "text-body"} my-0.5`}
        style={{ color: tag.startsWith("h") ? "var(--text-primary)" : "var(--text-secondary)" }}
      >
        {content}
      </p>
    );
  }

  // Button
  if ("Button" in comp) {
    const { label, action, style: btnStyle } = comp.Button;
    const text = resolveValue(label);
    const isPrimary = btnStyle === "primary" || btnStyle === "filled";

    return (
      <button
        key={id}
        onClick={() => {
          if (action?.sendMessage && onAction) {
            onAction(action.sendMessage, action);
          }
        }}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-caption font-bold transition-colors ${
          isPrimary
            ? "text-white"
            : "hover:bg-[--bg-hover]"
        }`}
        style={{
          background: isPrimary ? "var(--bg-active)" : "transparent",
          color: isPrimary ? "#fff" : "var(--text-link)",
          border: isPrimary ? "none" : "1px solid var(--border)",
        }}
      >
        {text}
      </button>
    );
  }

  // Column
  if ("Column" in comp) {
    const childIds = resolveChildren(comp.Column.children);
    const gap = comp.Column.gap ?? 4;
    return (
      <div key={id} className="flex flex-col" style={{ gap }}>
        {childIds.map((cid) => renderA2UIComponent(cid, components, onAction))}
      </div>
    );
  }

  // Row
  if ("Row" in comp) {
    const childIds = resolveChildren(comp.Row.children);
    const gap = comp.Row.gap ?? 8;
    return (
      <div key={id} className="flex flex-row flex-wrap items-center" style={{ gap }}>
        {childIds.map((cid) => renderA2UIComponent(cid, components, onAction))}
      </div>
    );
  }

  // Card
  if ("Card" in comp) {
    const childIds = resolveChildren(comp.Card.children);
    const title = comp.Card.title ? resolveValue(comp.Card.title) : null;
    return (
      <div
        key={id}
        className="rounded-md p-3 my-1"
        style={{ background: "var(--bg-hover)", border: "1px solid var(--border)" }}
      >
        {title && (
          <p className="text-h2 font-bold mb-2" style={{ color: "var(--text-primary)" }}>{title}</p>
        )}
        <div className="flex flex-col gap-1">
          {childIds.map((cid) => renderA2UIComponent(cid, components, onAction))}
        </div>
      </div>
    );
  }

  // List
  if ("List" in comp) {
    const childIds = resolveChildren(comp.List.children);
    return (
      <div key={id} className="flex flex-col gap-0.5 my-1">
        {childIds.map((cid) => (
          <div
            key={cid}
            className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-[--bg-hover] transition-colors"
          >
            <span className="text-tiny mt-1" style={{ color: "var(--text-muted)" }}>&#x2022;</span>
            {renderA2UIComponent(cid, components, onAction)}
          </div>
        ))}
      </div>
    );
  }

  // Image
  if ("Image" in comp) {
    const url = resolveValue(comp.Image.url);
    const alt = comp.Image.alt ? resolveValue(comp.Image.alt) : "";
    return (
      <img
        key={id}
        src={url}
        alt={alt}
        className="max-w-[360px] max-h-64 rounded-md object-contain my-1 cursor-pointer hover:opacity-90 transition-opacity"
        style={{ border: "1px solid var(--border)" }}
        onClick={() => openImageLightbox(url)}
      />
    );
  }

  // Divider
  if ("Divider" in comp) {
    return (
      <hr
        key={id}
        className="my-2"
        style={{ border: "none", borderTop: "1px solid var(--border)" }}
      />
    );
  }

  // Icon
  if ("Icon" in comp) {
    const name = resolveValue(comp.Icon.name);
    return (
      <span key={id} className="text-body" style={{ color: "var(--text-secondary)" }}>
        [{name}]
      </span>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Markdown component overrides
// ---------------------------------------------------------------------------

// Build markdown components dynamically so ActionCard can access resolve callbacks
function buildMarkdownComponents(
  onResolveAction?: (value: string, label: string) => void,
  resolvedActions?: Record<string, { value: string; label: string }>,
): Record<string, React.FC<any>> {
  return {
  // Fenced code blocks: <pre> wraps <code>, we render CodeBlock inside pre
  pre({ children, node }: { children: React.ReactNode; node?: any }) {
    // react-markdown wraps fenced code in <pre><code>…</code></pre>.
    // Extract the <code> child's props and render our CodeBlock directly.
    const codeChild = node?.children?.[0];
    if (codeChild?.tagName === "code") {
      const className = codeChild.properties?.className
        ? Array.isArray(codeChild.properties.className)
          ? codeChild.properties.className.join(" ")
          : String(codeChild.properties.className)
        : undefined;

      // Intercept ```action blocks — render as ActionCard instead of CodeBlock
      if (className?.includes("language-action")) {
        const raw = String((children as any)?.props?.children ?? children).trim();
        try {
          const parsed: ParsedAction = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && parsed.kind) {
            const promptKey = simpleHash(parsed.prompt ?? raw);
            const resolved = resolvedActions?.[promptKey];
            return (
              <ActionCard
                action={parsed}
                resolved={resolved}
                onResolve={onResolveAction
                  ? (v, l) => onResolveAction(v, l)
                  : undefined
                }
              />
            );
          }
        } catch {
          // JSON parse failed — fall through to CodeBlock
        }
      }

      // Get text content from the React children (the rendered <code> element)
      return <CodeBlock className={className}>{(children as any)?.props?.children ?? children}</CodeBlock>;
    }
    return <pre>{children}</pre>;
  },
  // Inline code: all <code> not inside <pre> arrive here
  code({
    className,
    children,
    ...props
  }: {
    className?: string;
    children: React.ReactNode;
  }) {
    // Inline code — simple styled span
    return (
      <code
        className="px-1 py-0.5 rounded text-[0.85em]"
        style={{
          background: "var(--code-bg)",
          color: "var(--code-text)",
          fontFamily: "var(--font-mono)",
        }}
        {...props}
      >
        {children}
      </code>
    );
  },
  // Enhanced tables
  table({ children }: { children: React.ReactNode }) {
    return <DataTable>{children}</DataTable>;
  },
  thead({ children }: { children: React.ReactNode }) {
    return <TableHead>{children}</TableHead>;
  },
  tr({ children, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
    return <TableRow {...props}>{children}</TableRow>;
  },
  th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
    return <TableCell isHeader style={style}>{children}</TableCell>;
  },
  td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
    return <TableCell style={style}>{children}</TableCell>;
  },
  // Links — open in new tab
  a({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "var(--text-link)" }}
        className="underline underline-offset-2 hover:opacity-80 transition-opacity"
        {...props}
      >
        {children}
      </a>
    );
  },
  // Blockquotes
  blockquote({ children }: { children: React.ReactNode }) {
    return (
      <blockquote
        className="my-2 pl-3 py-0.5"
        style={{
          borderLeft: "3px solid var(--bg-active)",
          color: "var(--text-secondary)",
        }}
      >
        {children}
      </blockquote>
    );
  },
  // Images — open in lightbox
  img({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
    return (
      <img
        src={src}
        alt={alt ?? ""}
        className="max-w-[360px] max-h-64 rounded-md object-contain my-1 cursor-pointer hover:opacity-90 transition-opacity"
        style={{ border: "1px solid var(--border)" }}
        onClick={() => src && openImageLightbox(src)}
        {...props}
      />
    );
  },
};
}

// ---------------------------------------------------------------------------
// Simple hash for action prompt keys
// ---------------------------------------------------------------------------

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// Streaming-aware text preprocessor: splits text around ```action blocks,
// hides incomplete blocks behind a pulsing placeholder, and passes complete
// blocks through for the markdown renderer to handle.
// ---------------------------------------------------------------------------

function preprocessActionBlocks(text: string, isStreaming?: boolean): string {
  // Fast path – no action blocks at all
  if (!text.includes("```action")) return text;

  // Split by ```action ... ``` boundaries.
  // We keep complete blocks intact (markdown renderer handles them),
  // and hide any trailing incomplete block while streaming.
  const parts: string[] = [];
  let remaining = text;

  // Match complete ```action ... ``` blocks
  const completeRe = /```action\s*\n[\s\S]*?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = completeRe.exec(remaining)) !== null) {
    // Text before this block
    if (match.index > lastIndex) {
      parts.push(remaining.slice(lastIndex, match.index));
    }
    // The complete block itself — keep it
    parts.push(match[0]);
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after the last complete block
  const tail = remaining.slice(lastIndex);

  // Check if tail contains an incomplete ```action block (started but not closed)
  const incompleteStart = tail.indexOf("```action");
  if (incompleteStart !== -1 && isStreaming) {
    // Text before the incomplete block
    parts.push(tail.slice(0, incompleteStart));
    // Don't include the incomplete block — it will show as a placeholder
    // (handled in MessageContent render)
  } else {
    parts.push(tail);
  }

  return parts.join("");
}

/** Check if text has an incomplete (unclosed) ```action block */
function hasIncompleteActionBlock(text: string): boolean {
  if (!text.includes("```action")) return false;
  // Remove all complete blocks
  const stripped = text.replace(/```action\s*\n[\s\S]*?```/g, "");
  // Check if there's still a ```action tag left (unclosed)
  return stripped.includes("```action");
}

// ---------------------------------------------------------------------------
// ActionCard — interactive decision widget (rendered from parsed action JSON)
// ---------------------------------------------------------------------------

function ActionCard({
  action,
  resolved,
  onResolve,
}: {
  action: ParsedAction;
  resolved?: { value: string; label: string };
  onResolve?: (value: string, label: string) => void;
}) {
  const [inputValue, setInputValue] = useState("");
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // ---- Resolved state: show what was selected ----
  if (resolved) {
    return (
      <div
        className="mt-2 rounded-lg px-4 py-3 flex items-center gap-2"
        style={{
          background: "var(--bg-hover)",
          border: "1px solid var(--border)",
          opacity: 0.85,
        }}
      >
        <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} style={{ color: "var(--accent-green, #34d399)" }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        <span className="text-caption" style={{ color: "var(--text-secondary)" }}>
          Selected: <strong style={{ color: "var(--text-primary)" }}>{resolved.label ?? resolved.value}</strong>
        </span>
      </div>
    );
  }

  const handleClick = (item: ActionItem) => {
    if (onResolve) onResolve(item.value, item.label);
  };

  const handleSubmitInput = () => {
    const trimmed = inputValue.trim();
    if (trimmed && onResolve) onResolve(trimmed, trimmed);
  };

  // ---- Style helpers for buttons ----
  const btnColor = (item: ActionItem, idx: number) => {
    const isHover = hoveredIdx === idx;
    if (item.style === "primary") {
      return {
        background: isHover ? "var(--bg-active)" : "var(--bg-active)",
        color: "#fff",
        border: "none",
        opacity: isHover ? 0.9 : 1,
      };
    }
    if (item.style === "danger") {
      return {
        background: isHover ? "rgba(239,68,68,0.15)" : "transparent",
        color: "var(--accent-red, #ef4444)",
        border: "1px solid var(--accent-red, #ef4444)",
      };
    }
    // secondary / default
    return {
      background: isHover ? "var(--bg-hover)" : "transparent",
      color: "var(--text-link)",
      border: "1px solid var(--border)",
    };
  };

  // ---- Render confirm (Yes / No) ----
  if (action.kind === "confirm") {
    const yesItem: ActionItem = action.items?.[0] ?? { label: "Yes", value: "yes", style: "primary" };
    const noItem: ActionItem = action.items?.[1] ?? { label: "No", value: "no", style: "secondary" };
    return (
      <div
        className="mt-2 rounded-lg overflow-hidden"
        style={{ border: "1px solid var(--border)", background: "var(--bg-secondary, var(--bg-hover))" }}
      >
        {action.prompt && (
          <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <p className="text-body font-bold" style={{ color: "var(--text-primary)" }}>{action.prompt}</p>
          </div>
        )}
        <div className="flex">
          <button
            onClick={() => handleClick(noItem)}
            onMouseEnter={() => setHoveredIdx(0)}
            onMouseLeave={() => setHoveredIdx(null)}
            className="flex-1 px-4 py-2.5 text-caption font-bold transition-all cursor-pointer"
            style={{
              background: hoveredIdx === 0 ? "var(--bg-hover)" : "transparent",
              color: "var(--text-secondary)",
              borderRight: "1px solid var(--border)",
              border: "none",
              borderRightWidth: 1,
              borderRightStyle: "solid",
              borderRightColor: "var(--border)",
            }}
          >
            {noItem.label}
          </button>
          <button
            onClick={() => handleClick(yesItem)}
            onMouseEnter={() => setHoveredIdx(1)}
            onMouseLeave={() => setHoveredIdx(null)}
            className="flex-1 px-4 py-2.5 text-caption font-bold transition-all cursor-pointer"
            style={{
              background: hoveredIdx === 1 ? "var(--bg-active)" : "var(--bg-active)",
              color: "#fff",
              border: "none",
              opacity: hoveredIdx === 1 ? 0.9 : 1,
            }}
          >
            {yesItem.label}
          </button>
        </div>
      </div>
    );
  }

  // ---- Render buttons (multiple options) ----
  if (action.kind === "buttons" && action.items) {
    return (
      <div
        className="mt-2 rounded-lg overflow-hidden"
        style={{ border: "1px solid var(--border)", background: "var(--bg-secondary, var(--bg-hover))" }}
      >
        {action.prompt && (
          <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <p className="text-body font-bold" style={{ color: "var(--text-primary)" }}>{action.prompt}</p>
          </div>
        )}
        <div className="flex flex-wrap gap-2 px-4 py-3">
          {action.items.map((item, idx) => (
            <button
              key={item.value}
              onClick={() => handleClick(item)}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-caption font-bold transition-all cursor-pointer"
              style={btnColor(item, idx)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ---- Render select (vertical option list) ----
  if (action.kind === "select" && action.items) {
    return (
      <div
        className="mt-2 rounded-lg overflow-hidden"
        style={{ border: "1px solid var(--border)", background: "var(--bg-secondary, var(--bg-hover))" }}
      >
        {action.prompt && (
          <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <p className="text-body font-bold" style={{ color: "var(--text-primary)" }}>{action.prompt}</p>
          </div>
        )}
        <div className="flex flex-col">
          {action.items.map((item, idx) => (
            <button
              key={item.value}
              onClick={() => handleClick(item)}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              className="flex items-center gap-3 px-4 py-2.5 text-left transition-all cursor-pointer"
              style={{
                background: hoveredIdx === idx ? "var(--bg-hover)" : "transparent",
                color: "var(--text-primary)",
                borderBottom: idx < action.items!.length - 1 ? "1px solid var(--border)" : "none",
                border: "none",
                borderBottomWidth: idx < action.items!.length - 1 ? 1 : 0,
                borderBottomStyle: "solid",
                borderBottomColor: "var(--border)",
              }}
            >
              <span
                className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  border: "2px solid var(--border)",
                  background: hoveredIdx === idx ? "var(--bg-active)" : "transparent",
                }}
              >
                {hoveredIdx === idx && (
                  <span className="w-2 h-2 rounded-full" style={{ background: "#fff" }} />
                )}
              </span>
              <span className="text-caption">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ---- Render input (free text entry) ----
  if (action.kind === "input") {
    return (
      <div
        className="mt-2 rounded-lg overflow-hidden"
        style={{ border: "1px solid var(--border)", background: "var(--bg-secondary, var(--bg-hover))" }}
      >
        {action.prompt && (
          <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <p className="text-body font-bold" style={{ color: "var(--text-primary)" }}>{action.prompt}</p>
          </div>
        )}
        <div className="flex items-center gap-2 px-4 py-3">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmitInput(); }}
            placeholder={action.placeholder ?? "Type your answer..."}
            className="flex-1 px-3 py-2 rounded-md text-caption outline-none"
            style={{
              background: "var(--bg-primary, var(--bg))",
              color: "var(--text-primary)",
              border: "1px solid var(--border)",
            }}
          />
          <button
            onClick={handleSubmitInput}
            disabled={!inputValue.trim()}
            className="px-4 py-2 rounded-md text-caption font-bold transition-all cursor-pointer"
            style={{
              background: inputValue.trim() ? "var(--bg-active)" : "var(--bg-hover)",
              color: inputValue.trim() ? "#fff" : "var(--text-muted)",
              border: "none",
            }}
          >
            Submit
          </button>
        </div>
      </div>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Streaming placeholder for incomplete action blocks
// ---------------------------------------------------------------------------

function ActionBlockPlaceholder() {
  return (
    <div
      className="mt-2 rounded-lg px-4 py-3 flex items-center gap-3"
      style={{
        background: "var(--bg-secondary, var(--bg-hover))",
        border: "1px solid var(--border)",
      }}
    >
      <span
        className="inline-block w-2 h-2 rounded-full animate-pulse"
        style={{ background: "var(--text-link)" }}
      />
      <span className="text-caption" style={{ color: "var(--text-muted)" }}>
        Preparing options...
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/** Renders message body: optional image, Markdown text, A2UI blocks, action widgets. */
export function MessageContent({
  text,
  mediaUrl,
  messageId,
  encrypted,
  a2ui,
  className = "",
  isStreaming,
  onAction,
  onResolveAction,
  resolvedActions,
}: MessageContentProps) {
  // Build markdown components with action-resolve callbacks baked in
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(onResolveAction, resolvedActions),
    [onResolveAction, resolvedActions],
  );

  // Preprocess text: strip incomplete ```action blocks during streaming
  const processedText = useMemo(
    () => preprocessActionBlocks(text, isStreaming),
    [text, isStreaming],
  );

  // Show placeholder while an action block is being streamed
  const showActionPlaceholder = isStreaming && hasIncompleteActionBlock(text);

  return (
    <div className={className}>
      {/* Media preview */}
      {mediaUrl && (
        <div className="mb-2">
          <MediaPreview url={mediaUrl} mediaContextId={encrypted && messageId ? `${messageId}:media` : undefined} />
        </div>
      )}

      {/* Markdown text with enhanced rendering */}
      {processedText ? (
        <div
          className="prose prose-sm max-w-none overflow-hidden prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-pre:my-0 prose-code:before:content-none prose-code:after:content-none prose-headings:my-2"
          style={{
            color: "var(--text-primary)",
            overflowWrap: "break-word",
            wordBreak: "break-word",
            "--tw-prose-headings": "var(--text-primary)",
            "--tw-prose-bold": "var(--text-primary)",
            "--tw-prose-code": "var(--code-text)",
            "--tw-prose-pre-code": "var(--text-primary)",
            "--tw-prose-pre-bg": "var(--code-bg)",
            "--tw-prose-bullets": "var(--text-muted)",
            "--tw-prose-counters": "var(--text-muted)",
          } as React.CSSProperties}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents}
          >
            {processedText}
          </ReactMarkdown>
        </div>
      ) : null}

      {/* Pulsing placeholder for incomplete action block during streaming */}
      {showActionPlaceholder && <ActionBlockPlaceholder />}

      {/* A2UI structured rendering */}
      {a2ui && <A2UIRenderer jsonl={a2ui} onAction={onAction} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Media preview — handles images, audio, video, and file downloads
// ---------------------------------------------------------------------------

/**
 * MediaPreview — renders images, audio, video, and files.
 * If mediaContextId is provided and E2E key is available, fetches the media,
 * decrypts it client-side, and renders a local object URL.
 */
function MediaPreview({ url, mediaContextId }: { url: string; mediaContextId?: string }) {
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);

  useEffect(() => {
    if (!mediaContextId || !E2eService.hasKey()) {
      setDecryptedUrl(null);
      return;
    }

    let cancelled = false;
    setDecrypting(true);

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const encrypted = new Uint8Array(await res.arrayBuffer());
        const decrypted = await E2eService.decryptMedia(encrypted, mediaContextId);
        if (!cancelled) {
          const blob = new Blob([decrypted.buffer.slice(0) as ArrayBuffer]);
          setDecryptedUrl(URL.createObjectURL(blob));
        }
      } catch (err) {
        console.warn("[E2E] Media decryption failed, falling back to direct URL:", err);
        if (!cancelled) setDecryptedUrl(null);
      } finally {
        if (!cancelled) setDecrypting(false);
      }
    })();

    return () => {
      cancelled = true;
      if (decryptedUrl) URL.revokeObjectURL(decryptedUrl);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, mediaContextId]);

  // Use decrypted URL if available, otherwise fall back to direct URL
  const effectiveUrl = decryptedUrl || url;
  const ext = url.split(".").pop()?.toLowerCase().split("?")[0] ?? "";

  if (decrypting) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md max-w-[360px]"
        style={{ background: "var(--bg-hover)", border: "1px solid var(--border)" }}>
        <span className="text-caption" style={{ color: "var(--text-muted)" }}>Decrypting media...</span>
      </div>
    );
  }

  // Audio
  if (["mp3", "wav", "ogg", "m4a", "aac", "webm"].includes(ext)) {
    return (
      <div
        className="flex items-center gap-3 px-3 py-2 rounded-md max-w-[360px]"
        style={{ background: "var(--bg-hover)", border: "1px solid var(--border)" }}
      >
        <svg className="w-8 h-8 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--text-link)" }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
        </svg>
        <audio controls className="flex-1 h-8" style={{ maxWidth: 280 }}>
          <source src={effectiveUrl} />
        </audio>
      </div>
    );
  }

  // Video
  if (["mp4", "mov", "avi", "mkv"].includes(ext)) {
    return (
      <video
        controls
        className="max-w-[360px] max-h-64 rounded-md"
        style={{ border: "1px solid var(--border)" }}
      >
        <source src={effectiveUrl} />
      </video>
    );
  }

  // PDF / downloadable file
  if (["pdf", "zip", "tar", "gz", "doc", "docx", "xls", "xlsx", "csv"].includes(ext)) {
    const filename = url.split("/").pop()?.split("?")[0] ?? "file";
    return (
      <a
        href={effectiveUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 px-3 py-2.5 rounded-md max-w-[360px] hover:opacity-90 transition-opacity"
        style={{ background: "var(--bg-hover)", border: "1px solid var(--border)", textDecoration: "none" }}
      >
        <svg className="w-8 h-8 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--text-link)" }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-caption font-bold truncate" style={{ color: "var(--text-primary)" }}>
            {filename}
          </p>
          <p className="text-tiny" style={{ color: "var(--text-muted)" }}>
            {ext.toUpperCase()} — Click to open
          </p>
        </div>
        <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: "var(--text-muted)" }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
      </a>
    );
  }

  // Default: image
  return (
    <img
      src={effectiveUrl}
      alt=""
      className="max-w-[360px] max-h-64 rounded-md object-contain cursor-pointer hover:opacity-90 transition-opacity"
      style={{ border: "1px solid var(--border)" }}
      onClick={() => openImageLightbox(effectiveUrl)}
    />
  );
}
