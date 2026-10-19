import { useState } from "react";

import { coverSrc } from "@/lib/asset";
import { cn } from "@/lib/utils";
import { useGameCover } from "@/features/covers/store";
import { effectiveCoverPath } from "@/features/covers/model";
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
  /** Report decoded dimensions; null means the image failed to load. */
  onDimensions?: (size: { width: number; height: number } | null) => void;
}

/**
 * Cover thumbnail that survives bad data.
 *
 * The scanner can store a guessed path that later disappears, and a missing
 * `assetProtocol` scope fails the request outright. Both cases raise `onError`
 * instead of a silent broken image, so we swap to the same placeholder used for
 * "no cover".
 */
export function CoverImage({ path, gameId, censored, ...props }: CoverImageProps) {
  const { preferences, loaded, error } = useGameCover(gameId);
  const src = loaded ? coverSrc(effectiveCoverPath(path, preferences)) : undefined;
  // Remount the image state for each source. Resetting `failed` in an effect
  // races with cached image errors, which can otherwise leave a broken image.
  return <CoverImageSource key={src ?? ""} src={src} {...props}
    censored={censored ?? preferences.censored}
    fallbackText={!loaded ? error ? "封面设置读取失败" : "载入封面…" : props.fallbackText} />;
}

function CoverImageSource({
  src,
  alt,
  className,
  fallbackClassName,
  fallbackText = "无封面",
  loading = "lazy",
  fitLandscape = false,
  onDimensions,
  censored = false,
}: Omit<CoverImageProps, "path"> & { src: string | undefined }) {
  const [failed, setFailed] = useState(false);
  const [landscape, setLandscape] = useState(false);
  const resolved = useProtectedCover(src);

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

  return (
    <img
      src={resolved.src}
      alt={alt}
      loading={loading}
      onLoad={event => {
        const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
        if (fitLandscape) setLandscape(width > height);
        onDimensions?.({ width, height });
      }}
      onError={() => { setFailed(true); onDimensions?.(null); }}
      className={className}
      data-landscape={fitLandscape ? landscape : undefined}
      data-censored={censored || undefined}
      style={{
        ...(fitLandscape && landscape ? { objectFit: "contain", objectPosition: "center" } : {}),
        ...(censored ? { filter: "blur(20px)", transform: "scale(1.18)" } : {}),
      }}
    />
  );
}

export default CoverImage;
