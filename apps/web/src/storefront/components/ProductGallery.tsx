import { useState } from "react";

import type { StorefrontMedia } from "../types.js";
import { ProductPhoto } from "./ProductPhoto.js";

/**
 * Product media gallery: up to 8 images and 1 video per product.
 *
 * Desktop shows a thumbnail rail under the stage; mobile hides the rail and
 * offers previous/next controls with position dots (the carousel pattern —
 * large buttons rather than touch-only gestures, so it works for every input
 * and stays keyboard accessible). Tapping the stage opens a full-screen
 * preview.
 *
 * The video entry is a PLACEHOLDER PLAYER demonstrating the intended
 * behaviour: a poster with a play badge, tap to "play" (a subtle shimmer
 * stands in for footage), always muted, and never autoplay — the badge and the
 * muted note communicate the contract the real player will honour. No video
 * file ships with the prototype.
 */
export function ProductGallery({ media }: { readonly media: readonly StorefrontMedia[] }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const current = media[Math.min(index, media.length - 1)]!;

  const go = (next: number) => {
    setIndex((next + media.length) % media.length);
    setPlaying(false);
  };

  return (
    <div>
      <div className="sf-gallery-stage">
        {current.kind === "video" ? (
          <button
            aria-label={playing ? "Pause video preview" : `Play video: ${current.label} (muted)`}
            aria-pressed={playing}
            className="sf-card-media"
            onClick={() => setPlaying((state) => !state)}
            style={{ border: 0, cursor: "pointer", padding: 0, width: "100%" }}
            type="button"
          >
            <ProductPhoto className={`sf-photo${playing ? " sf-video-live" : ""}`} media={current} />
            {playing ? null : (
              <span aria-hidden="true" className="sf-play-badge">
                ▶
              </span>
            )}
            <span className="sf-video-note">
              {playing ? "Playing preview · muted" : "Video preview · plays muted"}
            </span>
          </button>
        ) : (
          <button
            aria-label={`Open full-screen preview of ${current.label}`}
            className="sf-card-media"
            onClick={() => setFullscreen(true)}
            style={{ border: 0, cursor: "zoom-in", padding: 0, width: "100%" }}
            type="button"
          >
            <ProductPhoto media={current} />
          </button>
        )}
        {media.length > 1 ? (
          <>
            <button
              aria-label="Previous image"
              className="sf-gallery-nav sf-prev"
              onClick={() => go(index - 1)}
              type="button"
            >
              ‹
            </button>
            <button
              aria-label="Next image"
              className="sf-gallery-nav sf-next"
              onClick={() => go(index + 1)}
              type="button"
            >
              ›
            </button>
            <div aria-hidden="true" className="sf-gallery-dots">
              {media.map((entry, dot) => (
                <span className={dot === index ? "sf-active" : undefined} key={entry.label} />
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div className="sf-thumbs">
        {media.map((entry, thumb) => (
          <button
            aria-current={thumb === index}
            aria-label={entry.kind === "video" ? `Video: ${entry.label}` : entry.label}
            className={`sf-thumb${thumb === index ? " sf-active" : ""}`}
            key={entry.label}
            onClick={() => go(thumb)}
            type="button"
          >
            <span style={{ display: "block", position: "relative" }}>
              <ProductPhoto className="sf-photo sf-photo-square" media={entry} />
              {entry.kind === "video" ? (
                <span
                  aria-hidden="true"
                  className="sf-thumb-video-mark"
                  style={{ height: 24, inset: 0, margin: "auto", position: "absolute", width: 24 }}
                >
                  ▶
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>

      {fullscreen && current.kind === "image" ? (
        <div
          aria-label={`Full-screen preview of ${current.label}`}
          aria-modal="true"
          className="sf-fullscreen"
          role="dialog"
        >
          <figure>
            <ProductPhoto media={current} />
            <figcaption>{current.label}</figcaption>
          </figure>
          <button
            autoFocus
            className="sf-button sf-button-ghost"
            onClick={() => setFullscreen(false)}
            style={{ color: "#f6f1e7" }}
            type="button"
          >
            Close preview
          </button>
        </div>
      ) : null}
    </div>
  );
}
