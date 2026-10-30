/* Run in a development WebView with:
 * node scripts/cdp-eval.mjs --file scripts/benchmark-library.js
 * Synthetic cards exist only in a temporary DOM root; nothing is saved.
 * Measures component mounting without image decoding or database loading.
 */
(async () => {
  const { default: React } = await import('/node_modules/.vite/deps/react.js');
  const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
  const { flushSync } = (await import('/node_modules/.vite/deps/react-dom.js')).default;
  // Use Vite's exact optimized URL so the card and harness share router context.
  const cardSource = await (await fetch('/src/features/library/GameCard.tsx')).text();
  const routerPath = cardSource.match(/from\s+["']([^"']*react-router-dom[^"']*)["']/)?.[1];
  if (!routerPath) throw new Error('Cannot locate the development router module');
  const { MemoryRouter } = await import(routerPath);
  const { GameCard } = await import('/src/features/library/GameCard.tsx');
  const { libraryRenderCount } = await import('/src/features/library/render-window.ts');
  const { loadCoverPreferences } = await import('/src/features/covers/store.ts');
  const { loadInstallationState } = await import('/src/features/installation/store.ts');
  await Promise.all([loadCoverPreferences(), loadInstallationState()]);
  const host = document.createElement('div');
  host.setAttribute('aria-label', '临时游戏库性能验证');
  host.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#171923;padding:20px;';
  document.body.append(host);
  const root = createRoot(host);
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const results = [];
  try {
    // Warm the component and its stores before taking measurements.
    for (const total of [100, 1000, 5000, 10000]) {
      const games = Array.from({ length: total }, (_, i) => ({
        id: -i - 1, title: `合成作品 ${i + 1}`, originalTitle: `Synthetic ${i + 1}`,
        developer: `合成社团 ${i % 20}`, releaseDate: '2025-01-01', status: 'unplayed',
        rating: 8.5, favorite: 0, coverPath: null,
      }));
      for (const mode of ['all', 'initial-batch']) {
        flushSync(() => root.render(null));
        await frame();
        const count = mode === 'all' ? total : libraryRenderCount(total);
        const start = performance.now();
        flushSync(() => root.render(React.createElement(MemoryRouter, null,
          React.createElement('div', { className: 'grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3' },
            games.slice(0, count).map(game => React.createElement(GameCard, {
              key: game.id, game, tags: [], onToggleFavorite: () => {},
            }))))));
        const mountMs = performance.now() - start;
        await frame();
        if (total > 100) results.push({ total, mode, mountedCards: host.querySelectorAll('[data-game-entry]').length, mountMs: Math.round(mountMs * 10) / 10 });
      }
    }
    return { environment: navigator.userAgent, note: 'Development React; synthetic cards; no cover decoding or database load included.', results };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
})();
