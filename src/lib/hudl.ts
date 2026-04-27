/**
 * hudl.ts — Hudl URL normalization utilities.
 *
 * Hudl's share links (`hudl.com/video/<videoId>`) are watch pages and 403 in an
 * iframe. The playable embed lives at `hudl.com/embed/video/<videoId>`. This
 * module converts the former to the latter and also recognizes already-embed
 * links, VIDEO-query-string variants, and the `krossover.com` legacy domain.
 *
 * Returns null for anything we can't confidently embed — callers (FilmEmbed)
 * should treat null as "unsupported provider" and fall back to a link-out.
 */

const HUDL_HOSTS    = new Set(['hudl.com', 'www.hudl.com', 'krossover.com', 'www.krossover.com']);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com']);
const VIMEO_HOSTS   = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);

export type EmbedProvider = 'hudl' | 'youtube' | 'vimeo';

export interface FilmEmbed {
  provider: EmbedProvider;
  embedUrl: string;
  /** The original URL, for "Open in Hudl" fallback affordances. */
  sourceUrl: string;
}

/** Strip whitespace + normalize to a URL instance, or null on garbage input. */
function safeParse(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    // Accept inputs with missing scheme (e.g. "hudl.com/video/123")
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withScheme);
  } catch {
    return null;
  }
}

function hudlVideoId(url: URL): string | null {
  // /video/<id>         — standard share
  // /embed/video/<id>   — already embeddable
  const parts = url.pathname.split('/').filter(Boolean);

  const videoIdx = parts.indexOf('video');
  if (videoIdx >= 0 && parts[videoIdx + 1]) {
    // Strip trailing non-alphanumerics (Hudl sometimes appends titles)
    return parts[videoIdx + 1].replace(/[^a-zA-Z0-9-_]+$/, '') || null;
  }

  // Query-style: /athlete/.../video?vid=<id>
  const vid = url.searchParams.get('vid') ?? url.searchParams.get('videoId');
  if (vid) return vid;

  return null;
}

function youtubeVideoId(url: URL): string | null {
  if (url.hostname === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id || null;
  }
  // /watch?v=<id>  or  /embed/<id>  or  /shorts/<id>
  const v = url.searchParams.get('v');
  if (v) return v;
  const parts = url.pathname.split('/').filter(Boolean);
  if ((parts[0] === 'embed' || parts[0] === 'shorts') && parts[1]) return parts[1];
  return null;
}

function vimeoVideoId(url: URL): string | null {
  // vimeo.com/<id>       or  player.vimeo.com/video/<id>
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'video' && parts[1]) return parts[1];
  if (/^\d+$/.test(parts[0] ?? '')) return parts[0];
  return null;
}

/**
 * Parse a user-supplied film URL into a provider-specific embed descriptor.
 * Returns null if the host is unsupported or the video ID can't be extracted.
 */
export function parseFilmUrl(raw: string | null | undefined): FilmEmbed | null {
  const url = safeParse(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();

  if (HUDL_HOSTS.has(host)) {
    const id = hudlVideoId(url);
    if (!id) return null;
    return {
      provider:  'hudl',
      embedUrl:  `https://www.hudl.com/embed/video/${id}`,
      sourceUrl: url.toString(),
    };
  }

  if (YOUTUBE_HOSTS.has(host)) {
    const id = youtubeVideoId(url);
    if (!id) return null;
    return {
      provider:  'youtube',
      embedUrl:  `https://www.youtube.com/embed/${id}`,
      sourceUrl: url.toString(),
    };
  }

  if (VIMEO_HOSTS.has(host)) {
    const id = vimeoVideoId(url);
    if (!id) return null;
    return {
      provider:  'vimeo',
      embedUrl:  `https://player.vimeo.com/video/${id}`,
      sourceUrl: url.toString(),
    };
  }

  return null;
}

/** Thin convenience wrapper for call-sites that only need the iframe src. */
export function toHudlEmbed(raw: string | null | undefined): string | null {
  const parsed = parseFilmUrl(raw);
  return parsed?.provider === 'hudl' ? parsed.embedUrl : null;
}
