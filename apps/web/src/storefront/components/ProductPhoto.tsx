import type { StorefrontMedia } from "../types.js";

/**
 * Local placeholder "photography".
 *
 * The prototype ships no binary assets and hotlinks nothing: every product
 * image is an inline SVG scene generated from the media entry's tone and
 * label. Deterministic — the same media entry always renders the same scene —
 * and each carries the label as its accessible alt text, exactly as a real
 * photo would.
 */

/** Base hue per tone family; suffixes (-2, -3…) rotate the lighting. */
const tones: Readonly<Record<string, readonly [string, string]>> = {
  amber: ["#8a5a24", "#e0b877"],
  blush: ["#d9a7a0", "#f2d9d3"],
  cloud: ["#c9cdd4", "#eef0f3"],
  emerald: ["#1f5c4a", "#7fae9b"],
  gold: ["#b98a3c", "#e8d3a4"],
  navy: ["#1e2c4a", "#7787a8"],
  noir: ["#241f1a", "#6f675d"],
  rose: ["#b97f7f", "#e8cfc7"],
  sand: ["#c2a878", "#e9dcc3"],
  sky: ["#6d8fb5", "#d4e1ee"],
  slate: ["#4a4f57", "#a9adb4"],
  tan: ["#a06b3b", "#d9b98c"],
};

function toneColors(tone: string): readonly [string, string] {
  const [family = "sand", variant = "1"] = tone.split("-");
  const base = tones[family] ?? tones.sand!;
  const shift = Number.parseInt(variant, 10) || 1;
  // Rotate the gradient angleless-ly by swapping emphasis per variant so
  // detail shots read as different frames of the same shoot.
  return shift % 2 === 0 ? [base[1], base[0]] : base;
}

export function ProductPhoto({
  className = "sf-photo",
  media,
}: {
  readonly className?: string;
  readonly media: StorefrontMedia;
}) {
  // A real image wins when the Product carries one. `loading="lazy"` and
  // `referrerPolicy` keep a catalogue page cheap and quiet; the alt text is the
  // Trader's own, rendered as text and never as markup.
  if (media.url !== undefined && media.url !== "") {
    return (
      <img
        alt={media.label}
        className={className}
        loading="lazy"
        referrerPolicy="no-referrer"
        src={media.url}
      />
    );
  }
  const [from, to] = toneColors(media.tone);
  const id = `sfg-${media.tone.replaceAll(/[^a-z0-9-]/gi, "")}`;
  return (
    <svg
      aria-label={media.label}
      className={className}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      viewBox="0 0 400 500"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={id} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      <rect fill={`url(#${id})`} height="500" width="400" />
      <circle cx="200" cy="205" fill="rgba(255,255,255,0.22)" r="118" />
      <path
        d="M200 122c-26 0-42 20-42 46v18l-52 44 20 24 32-24v160h84V230l32 24 20-24-52-44v-18c0-26-16-46-42-46z"
        fill="rgba(20,31,54,0.28)"
      />
      <text
        fill="rgba(255,255,255,0.85)"
        fontFamily="Georgia, serif"
        fontSize="20"
        textAnchor="middle"
        x="200"
        y="452"
      >
        {media.label.length > 34 ? `${media.label.slice(0, 33)}…` : media.label}
      </text>
    </svg>
  );
}
