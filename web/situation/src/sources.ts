// One place that says how each source type looks — color (the primary channel),
// an emoji glyph, a display label, and whether its author reads as an @handle.
// Shared by the feed labels, the map markers/legend, and the filter chips so a
// source is recognisable at a glance everywhere (feed card, map pin, filter).

export interface SourceStyle {
  color: string;
  emoji: string;
  label: string;
  /** author is a handle → prefix with @ (x / instagram / telegram / tiktok) */
  at: boolean;
}

const STYLES: Record<string, SourceStyle> = {
  // media → wall
  youtube: { color: "#ff4d4f", emoji: "▶️", label: "YouTube", at: false },
  tiktok: { color: "#ff4fd8", emoji: "🎵", label: "TikTok", at: true },
  x: { color: "#e8edf2", emoji: "𝕏", label: "X", at: true },
  twitter: { color: "#e8edf2", emoji: "𝕏", label: "X", at: true },
  instagram: { color: "#e1499a", emoji: "📸", label: "Instagram", at: true },
  telegram: { color: "#38b6ff", emoji: "📣", label: "Telegram", at: true },
  dl: { color: "#a78bfa", emoji: "⬇️", label: "Download", at: false },
  gdelttv: { color: "#f0a04b", emoji: "📺", label: "GDELT TV", at: false },
  // metadata → feed
  web: { color: "#38e8ff", emoji: "🌐", label: "Web", at: false },
  dork: { color: "#22d3ee", emoji: "🔍", label: "Dork", at: false },
  shodan: { color: "#ef4444", emoji: "🛰️", label: "Shodan", at: false },
  // gps → map
  overpass: { color: "#ffd166", emoji: "📍", label: "OSM", at: false },
  firms: { color: "#ff6b3d", emoji: "🔥", label: "FIRMS", at: false },
  flights: { color: "#5cff96", emoji: "✈️", label: "Flights", at: false },
  // recapture → stills
  webcam: { color: "#a3e635", emoji: "📹", label: "Webcam", at: false },
  browser: { color: "#60a5fa", emoji: "🖥️", label: "Browser", at: false },
  screenshot: { color: "#60a5fa", emoji: "🖥️", label: "Screenshot", at: false },
  // record-derived map points
  exif: { color: "#c084fc", emoji: "📷", label: "EXIF", at: false },
  chronolocate: { color: "#fbbf24", emoji: "🌇", label: "Chrono", at: false },
};

const FALLBACK: SourceStyle = { color: "#8aa69d", emoji: "•", label: "scan", at: false };

export function sourceStyle(type: string | null | undefined): SourceStyle {
  if (!type) return FALLBACK;
  return STYLES[type.toLowerCase()] ?? { ...FALLBACK, label: type.toUpperCase() };
}

/** Author formatted for display — @handle for platforms that use handles. */
export function formatAuthor(type: string | null | undefined, author: string | null | undefined): string | null {
  const a = (author ?? "").trim();
  if (!a) return null;
  const st = sourceStyle(type);
  if (st.at && !a.startsWith("@")) return `@${a}`;
  return a;
}
