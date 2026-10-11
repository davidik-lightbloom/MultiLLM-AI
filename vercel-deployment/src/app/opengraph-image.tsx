import { ImageResponse } from "next/og";

export const alt = "MultiLLM - Ensemble AI Platform";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Generated from code, not a static asset -- reuses the same purple-to-blue
// gradient and "M" mark as icon.svg so a shared link's preview actually
// matches the product instead of showing no image at all (there was no
// opengraph-image before this, so every shared link fell back to a bare
// title/description card).
export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #9333ea 0%, #2563eb 100%)",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 24,
            marginBottom: 32,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 96,
              height: 96,
              borderRadius: 22,
              background: "rgba(255,255,255,0.15)",
              fontSize: 56,
              fontWeight: 700,
              color: "white",
            }}
          >
            M
          </div>
          <div style={{ fontSize: 72, fontWeight: 700, color: "white" }}>MultiLLM</div>
        </div>
        <div style={{ fontSize: 34, color: "rgba(255,255,255,0.9)", textAlign: "center", padding: "0 80px" }}>
          One prompt. Multiple LLMs. The best answer, automatically selected.
        </div>
      </div>
    ),
    { ...size }
  );
}
