import { useState } from "react";

import { coverSrc } from "@/lib/asset";
import { cn } from "@/lib/utils";

export interface CoverImageProps {
  /** Absolute filesystem path from `games.coverPath`. */
  path: string | null;
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
export function CoverImage({ path, ...props }: CoverImageProps) {
  const src = coverSrc(path);
  // Remount the image state for each source. Resetting `failed` in an effect
  // races with cached image errors, which can otherwise leave a broken image.
  return <CoverImageSource key={src ?? ""} src={src} {...props} />;
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
}: Omit<CoverImageProps, "path"> & { src: string | undefined }) {
  const [failed, setFailed] = useState(false);
  const [landscape, setLandscape] = useState(false);

  if (!src || failed) {
    return (
      <div
        className={cn(
          "flex h-full w-full items-center justify-center px-2 text-center text-xs text-muted-foreground",
          fallbackClassName,
        )}
      >
        {fallbackText}
      </div>
    );
  }

  return (
    <img
      src={src}
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
      style={fitLandscape && landscape ? { objectFit: "contain", objectPosition: "center" } : undefined}
    />
  );
}

export default CoverImage;
