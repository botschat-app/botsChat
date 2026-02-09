import React from "react";
import { Separator } from "react-resizable-panels";

type ResizeHandleProps = {
  direction?: "horizontal" | "vertical";
  className?: string;
};

/**
 * Custom drag handle for react-resizable-panels v4.
 * Default (1px line) → Hover/Active (3px, blue highlight).
 */
export function ResizeHandle({ direction = "horizontal", className = "" }: ResizeHandleProps) {
  const isVertical = direction === "vertical";

  return (
    <Separator
      className={`resize-handle group relative flex items-center justify-center ${
        isVertical ? "h-[6px] cursor-row-resize" : "w-[6px] cursor-col-resize"
      } ${className}`}
      style={{ flexShrink: 0, flexGrow: 0 }}
    >
      {/* Visible line */}
      <div
        className={`resize-handle-line transition-all duration-150 ${
          isVertical
            ? "w-full h-px group-hover:h-[3px]"
            : "h-full w-px group-hover:w-[3px]"
        }`}
        style={{ background: "var(--border)" }}
      />
    </Separator>
  );
}
