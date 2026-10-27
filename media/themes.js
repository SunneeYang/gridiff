'use strict';
(() => {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const modes = ['system', 'light', 'dark'];
  const palettes = ['default', 'github', 'catppuccin', 'solarized', 'nord'];
  let preferences = { mode: 'system', palette: 'default' }, revision = 0, save = Promise.resolve();
  const valid = value => value && modes.includes(value.mode) && palettes.includes(value.palette);
  function apply() {
    root.dataset.appearance = preferences.mode === 'system' ? (system.matches ? 'dark' : 'light') : preferences.mode;
    root.dataset.palette = preferences.palette;
    const mode = document.getElementById('theme-mode'), palette = document.getElementById('theme-palette');
    if (mode) mode.value = preferences.mode;
    if (palette) palette.value = preferences.palette;
  }
  // Apply the OS preference before the body renders, then restore the saved palette.
  apply();
  system.addEventListener('change', apply);
  const ready = fetch('preferences', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5000) })
    .then(response => response.ok ? response.json() : null)
    .then(value => { if (!revision && valid(value)) { preferences = { mode: value.mode, palette: value.palette }; apply(); } })
    .catch(() => {});
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    const mode = document.getElementById('theme-mode'), palette = document.getElementById('theme-palette');
    const status = document.getElementById('theme-save-status');
    const change = () => {
      preferences = { mode: mode.value, palette: palette.value }; revision++;
      const next = { ...preferences }; apply(); status.textContent = '';
      // Serialize saves so quick changes cannot leave an older preference on disk.
      save = save.catch(() => {}).then(async () => {
        await ready;
        const response = await fetch('preferences', { method: 'POST', credentials: 'omit',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next), signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('save');
        status.textContent = '';
      }).catch(() => { status.textContent = '偏好未能保存，当前页面已应用。'; });
    };
    mode.addEventListener('change', change);
    palette.addEventListener('change', change);
  }, { once: true });
})();
