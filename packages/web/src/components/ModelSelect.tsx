import React, { useRef, useEffect, useState, useCallback } from "react";
import type { ModelInfo } from "../api";

type ModelSelectProps = {
  value: string;
  onChange: (modelId: string) => void;
  models: ModelInfo[];
  disabled?: boolean;
  placeholder?: string;
  compact?: boolean;
};

export function ModelSelect({
  value,
  onChange,
  models,
  disabled,
  placeholder = "Select model...",
  compact,
}: ModelSelectProps) {
  // Try exact match by id first; fall back to matching by model name
  // (e.g. value="gpt-5.2-chat" should resolve to id="azure-gpt52/gpt-5.2-chat")
  const exactMatch = models.find((m) => m.id === value);
  const nameMatch = !exactMatch && value ? models.find((m) => m.name === value) : null;
  const effectiveValue = nameMatch ? nameMatch.id : value;

  const currentInList = !effectiveValue || models.some((m) => m.id === effectiveValue);

  // Auto-correct: persist the full model id when we resolved via name match
  useEffect(() => {
    if (nameMatch && value !== nameMatch.id) {
      onChange(nameMatch.id);
    }
  }, [nameMatch, value, onChange]);

  const selectRef = useRef<HTMLSelectElement>(null);
  const [selectWidth, setSelectWidth] = useState<number | undefined>(undefined);

  const displayText = effectiveValue || placeholder;

  // Measure the text width using Canvas to match the select's actual font
  const updateWidth = useCallback(() => {
    if (!compact || !selectRef.current) return;
    const cs = getComputedStyle(selectRef.current);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    const textW = ctx.measureText(displayText).width;
    const padL = parseFloat(cs.paddingLeft) || 6;
    const padR = parseFloat(cs.paddingRight) || 6;
    // padding + ~20px native dropdown arrow + 2px buffer
    setSelectWidth(Math.ceil(textW) + padL + padR + 22);
  }, [compact, displayText]);

  useEffect(() => { updateWidth(); }, [updateWidth]);

  return (
    <select
      ref={selectRef}
      value={effectiveValue}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={`rounded-sm focus:outline-none ${compact ? "text-caption py-0.5 px-1.5" : "text-body py-1.5 px-2.5"}`}
      style={{
        background: compact ? "transparent" : "var(--bg-hover)",
        color: effectiveValue ? "var(--text-primary)" : "var(--text-muted)",
        border: compact ? "1px solid transparent" : "1px solid var(--border)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        width: compact && selectWidth ? selectWidth : undefined,
        maxWidth: "100%",
        fontFamily: "var(--font-mono)",
        textOverflow: "ellipsis",
        overflow: "hidden",
      }}
    >
      {!effectiveValue && <option value="">{placeholder}</option>}
      {effectiveValue && !currentInList && (
        <option value={effectiveValue}>{effectiveValue}</option>
      )}
      {models.map((m) => (
        <option key={m.id} value={m.id}>{m.id}</option>
      ))}
    </select>
  );
}
