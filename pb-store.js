// ─── Playbook state store ────────────────────────────────────────────────────
// A tiny hand-rolled store (no build step → no Zustand/CDN dependency) wired into
// React 18 via useSyncExternalStore. It exists to move churny shared state (the
// prices map, this increment) out of App()'s React state so a price-batch merge
// re-renders only the components that subscribe — not the whole tree. Third
// member of the pb-core/pb-data family: pure core is React-free + Node-testable;
// the hooks reach for the browser's React global and are only called in-browser.
//
// Dual-mode footer like pb-core.js/pb-data.js: CommonJS module.exports (Node
// tests) + globalThis.PBStore (browser <script> before app.js).
"use strict";
(function () {
  // Pure, React-free, fully unit-testable.
  function createStore(initial) {
    let state = initial;
    const listeners = new Set();
    return {
      getState() { return state; },
      setState(patchOrFn) {
        const patch = typeof patchOrFn === 'function' ? patchOrFn(state) : patchOrFn;
        state = Object.assign({}, state, patch);
        listeners.forEach(fn => fn());
      },
      subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }
    };
  }

  // The single app store. Holds only { prices } this increment (room to grow).
  const appStore = createStore({ prices: {} });

  function getPrices() { return appStore.getState().prices; }
  // Shallow-merge: unchanged symbols keep their existing quote object reference
  // (the per-symbol memo win depends on this — do NOT deep-clone untouched quotes).
  function mergePrices(obj) {
    if (!obj || !Object.keys(obj).length) return;
    appStore.setState(prev => ({ prices: Object.assign({}, prev.prices, obj) }));
  }
  function setPricesMap(map) { appStore.setState({ prices: map || {} }); }

  // ─── React bindings (browser-only) ──────────────────────────────────────────
  // Resolved lazily inside each hook so requiring this file under Node (where
  // there is no React) never throws — the hooks are simply never called there.
  function R() { return (typeof globalThis !== 'undefined' && globalThis.React) || null; }
  function usePricesMap() {
    return R().useSyncExternalStore(appStore.subscribe, getPrices);
  }

  const PBStore = {
    createStore,
    getPrices, mergePrices, setPricesMap,
    subscribe: appStore.subscribe,
    usePricesMap
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PBStore;
  if (typeof globalThis !== 'undefined') globalThis.PBStore = PBStore;
})();
