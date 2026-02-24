import React, { useEffect, useCallback, useState } from "react";

type LightboxState = { url: string; filename?: string } | null;

let _setLightbox: React.Dispatch<React.SetStateAction<LightboxState>> | null = null;

export function openImageLightbox(url: string, filename?: string) {
  _setLightbox?.({ url, filename });
}

export function ImageLightbox() {
  const [state, setState] = useState<LightboxState>(null);
  _setLightbox = setState;

  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, close]);

  if (!state) return null;

  const handleDownload = async () => {
    try {
      const res = await fetch(state.url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = state.filename || guessFilename(state.url);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(state.url, "_blank");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.85)" }}
      onClick={close}
    >
      {/* Toolbar */}
      <div
        className="fixed top-0 right-0 flex items-center gap-1 p-3 z-[101]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleDownload}
          className="p-2 rounded-full hover:bg-white/15 transition-colors"
          title="Download"
        >
          <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
        </button>
        <button
          onClick={close}
          className="p-2 rounded-full hover:bg-white/15 transition-colors"
          title="Close"
        >
          <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Image */}
      <img
        src={state.url}
        alt=""
        className="max-w-[90vw] max-h-[90vh] object-contain rounded select-none"
        style={{ boxShadow: "0 0 40px rgba(0,0,0,0.5)" }}
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
    </div>
  );
}

function guessFilename(url: string): string {
  try {
    const path = new URL(url, window.location.href).pathname;
    const name = path.split("/").pop();
    if (name && name.includes(".")) return name;
  } catch { /* ignore */ }
  return `image-${Date.now()}.png`;
}
