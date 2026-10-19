import { useEffect, useState } from 'react';
import { metadataCoverPreview } from './db';

/** 2DFan's CDN requires its site as Referer, which a WebView cannot set. */
export function useProtectedCover(src: string | undefined) {
  const protectedSource = Boolean(src && /^https:\/\/img\.achost\.top\//i.test(src));
  const [local, setLocal] = useState<string | undefined>();
  const [pending, setPending] = useState(protectedSource);
  useEffect(() => {
    if (!protectedSource || !src) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    setPending(true);
    void metadataCoverPreview(src).then(bytes => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([bytes]));
      setLocal(objectUrl);
    }).catch(() => { if (!cancelled) setLocal(undefined); })
      .finally(() => { if (!cancelled) setPending(false); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, protectedSource]);
  return { src: protectedSource ? local : src, pending: protectedSource && pending };
}
