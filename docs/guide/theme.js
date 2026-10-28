'use strict';
(() => {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const modes = ['system', 'light', 'dark'];
  const palettes = ['cobalt', 'nord', 'solarized'];
  const storageKey = 'gridiff-guide-theme';
  const valid = value => value && modes.includes(value.mode) && palettes.includes(value.palette);
  let preferences = { mode: 'system', palette: 'cobalt' };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (valid(saved)) preferences = { mode: saved.mode, palette: saved.palette };
  } catch { /* Local-file browsers can deny storage; current-page switching still works. */ }

  function apply() {
    root.dataset.appearance = preferences.mode === 'system' ? (system.matches ? 'dark' : 'light') : preferences.mode;
    root.dataset.palette = preferences.palette;
    const mode = document.getElementById('theme-mode'), palette = document.getElementById('theme-palette');
    if (mode) mode.value = preferences.mode;
    if (palette) palette.value = preferences.palette;
  }
  // Apply before the stylesheet and body load to avoid a light flash in dark mode.
  apply();
  system.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    const mode = document.getElementById('theme-mode'), palette = document.getElementById('theme-palette');
    const change = () => {
      const next = { mode: mode.value, palette: palette.value };
      if (!valid(next)) return;
      preferences = next;
      apply();
      const status = document.getElementById('theme-status');
      try { localStorage.setItem(storageKey, JSON.stringify(preferences)); status.textContent = ''; }
      catch { status.textContent = '当前页面已应用；浏览器未允许保存主题设置。'; }
    };
    mode.addEventListener('change', change);
    palette.addEventListener('change', change);
  }, { once: true });
})();
