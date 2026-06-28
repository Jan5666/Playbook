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

  // The single app store. Holds prices (Increment 1) + settings (Increment 2).
  const appStore = createStore({ prices: {}, settings: {} });

  function getPrices() { return appStore.getState().prices; }
  // Shallow-merge: unchanged symbols keep their existing quote object reference
  // (the per-symbol memo win depends on this — do NOT deep-clone untouched quotes).
  function mergePrices(obj) {
    if (!obj || !Object.keys(obj).length) return;
    appStore.setState(prev => ({ prices: Object.assign({}, prev.prices, obj) }));
  }
  function setPricesMap(map) { appStore.setState({ prices: map || {} }); }

  // ─── Settings slice (Increment 2) ───────────────────────────────────────────
  // App-agnostic: app.js injects the schema (name→localStorage key + default) and
  // a storage adapter ({get,set}) at startup via configureSettings. The store
  // seeds from storage on configure and write-throughs on every setSetting, so each
  // setting keeps its own pb.* key (cloud backup/restore stays byte-compatible).
  let _settingsSchema = [];       // [{ name, key, default }]
  let _settingsKeyByName = {};    // name -> localStorage key
  let _settingsStorage = null;    // { get(key, default), set(key, value) }

  function configureSettings(cfg) {
    _settingsSchema = (cfg && cfg.schema) || [];
    _settingsStorage = (cfg && cfg.storage) || null;
    _settingsKeyByName = {};
    const seeded = {};
    for (const e of _settingsSchema) {
      _settingsKeyByName[e.name] = e.key;
      seeded[e.name] = _settingsStorage ? _settingsStorage.get(e.key, e.default) : e.default;
    }
    appStore.setState({ settings: seeded });
  }
  function getSettings() { return appStore.getState().settings; }
  function getSetting(name) { return appStore.getState().settings[name]; }
  // Replace only the changed key (selector-stability contract: siblings keep refs).
  function setSetting(name, value) {
    const key = _settingsKeyByName[name];
    if (!key) return;             // unknown setting: no-op
    if (_settingsStorage) _settingsStorage.set(key, value);
    appStore.setState(prev => ({ settings: Object.assign({}, prev.settings, { [name]: value }) }));
  }

  // ─── React bindings (browser-only) ──────────────────────────────────────────
  // Resolved lazily inside each hook so requiring this file under Node (where
  // there is no React) never throws — the hooks are simply never called there.
  function R() { return (typeof globalThis !== 'undefined' && globalThis.React) || null; }
  function usePricesMap() {
    return R().useSyncExternalStore(appStore.subscribe, getPrices);
  }
  function useSettings() {
    return R().useSyncExternalStore(appStore.subscribe, getSettings);
  }
  function useSetting(name) {
    return R().useSyncExternalStore(appStore.subscribe, () => appStore.getState().settings[name]);
  }

  const PBStore = {
    createStore,
    getPrices, mergePrices, setPricesMap,
    configureSettings, getSettings, getSetting, setSetting,
    subscribe: appStore.subscribe,
    usePricesMap, useSettings, useSetting
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PBStore;
  if (typeof globalThis !== 'undefined') globalThis.PBStore = PBStore;
})();
