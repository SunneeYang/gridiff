'use strict';
(() => {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const modes = ['system', 'light', 'dark'];
  const palettes = ['default', 'github', 'catppuccin', 'solarized', 'nord'];
  let preferences = { mode: 'system', palette: 'default', style: 'material', layout: 'matrix' }, revision = 0, save = Promise.resolve();
  const valid = value => value && modes.includes(value.mode) && palettes.includes(value.palette) &&
    ['github', 'material', 'soft', 'brutalist'].includes(value.style) && ['matrix', 'paper', 'focus', 'terminal'].includes(value.layout);
  const controls = { mode: 'theme-mode', palette: 'theme-palette', style: 'theme-style', layout: 'read-layout' };
  function apply() {
    root.dataset.appearance = preferences.mode === 'system' ? (system.matches ? 'dark' : 'light') : preferences.mode;
    root.dataset.palette = preferences.palette;
    const oldLayout = root.dataset.layout;
    root.dataset.style = preferences.style;
    root.dataset.layout = preferences.layout;
    for (const [key, id] of Object.entries(controls)) {
      const control = document.getElementById(id);
      if (control) control.value = preferences[key];
    }
    if (oldLayout !== preferences.layout) window.dispatchEvent(new Event('gridiff-layout'));
  }
  // Apply the OS preference before the body renders, then restore the saved palette.
  apply();
  system.addEventListener('change', apply);
  const ready = fetch('preferences', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5000) })
    .then(response => response.ok ? response.json() : null)
    .then(value => { const restored = { ...preferences, ...value }; if (!revision && valid(restored)) { preferences = restored; apply(); } })
    .catch(() => {});
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    const status = document.getElementById('theme-save-status');
    const change = () => {
      preferences = Object.fromEntries(Object.entries(controls).map(([key, id]) => [key, document.getElementById(id).value])); revision++;
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
    for (const id of Object.values(controls)) document.getElementById(id).addEventListener('change', change);
  }, { once: true });
})();
