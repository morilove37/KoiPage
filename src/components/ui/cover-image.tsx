import { useState } from "react";

import { coverSrc } from "@/lib/asset";
import { cn } from "@/lib/utils";
import { useGameCover } from "@/features/covers/store";
import { effectiveCoverPath, coverThumbnailPath } from "@/features/covers/model";
import type { CropRect } from "@/features/covers/model";
import { useProtectedCover } from "@/lib/protected-cover";

export interface CoverImageProps {
  /** Absolute filesystem path from `games.coverPath`. */
  path: string | null;
  gameId?: number;
  censored?: boolean;
  alt: string;
  className?: string;
  /** Rendered when the path is empty *or* the image fails to load. */
  fallbackClassName?: string;
  fallbackText?: string;
  loading?: "eager" | "lazy";
  /** Show landscape artwork in full; portrait artwork keeps the caller's fit. */
  fitLandscape?: boolean;
  /** Explicitly opt into a crop. Detail, home and exports retain the full artwork. */
  crop?: CropRect | null;
  /** Report decoded dimensions; null means the image failed to load. */
  onDimensions?: (size: { width: number; height: number } | null) => void;
  /**
   * Load the small cached copy for grid/list layouts.
   *
   * Managed covers are stored as full-size originals next to a 320px WebP
   * thumbnail; lists only ever paint a few hundred pixels, so decoding the
   * original wastes memory and time on every card. Ignored when the caller
   * needs exact pixels (`onDimensions`) or an explicit crop, and never applied
   * to remote or protected sources.
   */
  thumbnail?: boolean;
}

/**
 * Cover thumbnail that survives bad data.
 *
 * The scanner can store a guessed path that later disappears, and a missing
 * `assetProtocol` scope fails the request outright. Both cases raise `onError`
 * instead of a silent broken image, so we swap to the same placeholder used for
 * "no cover".
 */
export function CoverImage({ path, gameId, censored, thumbnail, ...props }: CoverImageProps) {
  const { preferences, loaded, error } = useGameCover(gameId);
  const effective = loaded ? effectiveCoverPath(path, preferences) : null;
  // Crops are percentage-based so they work on the small copy too, but a
  // dimension readout needs the real pixels — that path keeps the original.
  const thumbnailPath = thumbnail && !props.onDimensions
    ? coverThumbnailPath(effective)
    : null;
  const src = loaded ? coverSrc(thumbnailPath ?? effective) : undefined;
  // Thumbnails are best-effort: a cover stored before they existed has no
  // cached copy, so fall back to the original instead of a blank card.
  const fallbackSrc = thumbnailPath ? coverSrc(effective) : undefined;
  // Remount the image state for each source. Resetting `failed` in an effect
  // races with cached image errors, which can otherwise leave a broken image.
  return <CoverImageSource key={src ?? ""} src={src} fallbackSrc={fallbackSrc} {...props}
    censored={censored ?? preferences.censored}
    fallbackText={!loaded ? error ? "封面设置读取失败" : "载入封面…" : props.fallbackText} />;
}

function CoverImageSource({
  src,
  fallbackSrc,
  alt,
  className,
  fallbackClassName,
  fallbackText = "无封面",
  loading = "lazy",
  fitLandscape = false,
  onDimensions,
  censored = false,
  crop,
}: Omit<CoverImageProps, "path"> & { src: string | undefined; fallbackSrc?: string }) {
  const [failed, setFailed] = useState(false);
  const [landscape, setLandscape] = useState(false);
  // Set when the cached thumbnail is unusable (e.g. the cover predates it).
  const [originalOnly, setOriginalOnly] = useState(false);
  const activeSrc = originalOnly && fallbackSrc ? fallbackSrc : src;
  const resolved = useProtectedCover(activeSrc);

  if (!resolved.src || failed) {
    return (
      <div
        className={cn(
          "flex h-full w-full items-center justify-center px-2 text-center text-xs text-muted-foreground",
          fallbackClassName,
        )}
      >
        {resolved.pending ? "载入封面…" : fallbackText}
      </div>
    );
  }

  const image = (
    <img
      src={resolved.src}
      alt={alt}
      loading={loading}
      onLoad={event => {
        const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
        if (fitLandscape) setLandscape(width > height);
        onDimensions?.({ width, height });
      }}
      onError={() => {
        // Thumbnails are best-effort: retry once with the stored original,
        // then give up so a genuinely broken file still shows the placeholder.
        if (fallbackSrc && !originalOnly) { setOriginalOnly(true); return; }
        setFailed(true);
        onDimensions?.(null);
      }}
      className={crop ? "absolute max-w-none" : className}
      data-landscape={fitLandscape ? landscape : undefined}
      data-censored={censored || undefined}
      style={{
        ...(crop ? { width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, left: `${-crop.x * 100 / crop.width}%`, top: `${-crop.y * 100 / crop.height}%`, objectFit: "fill" as const } : {}),
        ...(fitLandscape && landscape && !crop ? { objectFit: "contain", objectPosition: "center" } : {}),
        ...(censored && !crop ? { filter: "blur(20px)", transform: "scale(1.18)" } : {}),
      }}
    />
  );
  return crop ? <span className={cn("relative block overflow-hidden", className)} style={censored ? { filter: "blur(20px)", transform: "scale(1.18)" } : undefined}>{image}</span> : image;
}

export default CoverImage;
