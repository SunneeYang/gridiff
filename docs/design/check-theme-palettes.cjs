'use strict';

// Run with node docs/design/check-theme-palettes.cjs. The HTML is the token source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, 'diff-review-prototype.html'), 'utf8');
const palettes = JSON.parse(html.match(/<script type="application\/json" id="palette-data">([\s\S]*?)<\/script>/)[1]);
assert.deepEqual(Object.keys(palettes), ['default', 'github', 'catppuccin', 'solarized', 'nord']);
const roles = 'bg fg muted line surface elevated hover control accent selection selection-fg focus add add-bg add-mark remove remove-bg remove-mark modify modify-bg'.split(' ');
function luminance(hex) {
  return hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
}
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (light + .05) / (dark + .05);
}
const checks = [];
for (const background of ['bg', 'surface', 'elevated', 'hover']) {
  for (const foreground of ['fg', 'muted', 'accent']) checks.push([foreground, background, 4.5]);
  for (const foreground of ['focus', 'control']) checks.push([foreground, background, 3]);
}
for (const role of ['add', 'remove', 'modify']) {
  checks.push([role, 'bg', 4.5], [role, `${role}-bg`, 4.5], ['fg', `${role}-bg`, 4.5]);
}
checks.push(['fg', 'add-mark', 4.5], ['fg', 'remove-mark', 4.5], ['selection-fg', 'selection', 4.5], ['focus', 'selection', 3]);
const failures = [];
for (const [name, palette] of Object.entries(palettes)) {
  for (const mode of ['light', 'dark']) {
    const tokens = palette[mode];
    assert.deepEqual(Object.keys(tokens), roles, `${name}/${mode}: complete roles`);
    Object.values(tokens).forEach(value => assert.match(value, /^#[0-9a-f]{6}$/));
    assert.notEqual(tokens['add-bg'], tokens['add-mark']);
    assert.notEqual(tokens['remove-bg'], tokens['remove-mark']);
    if (mode === 'dark') assert(luminance(tokens.bg) < luminance(tokens.surface) && luminance(tokens.surface) < luminance(tokens.elevated), `${name}: raised dark surfaces`);
    const ratios = checks.map(([fg, bg, min]) => {
      const ratio = contrast(tokens[fg], tokens[bg]);
      if (ratio < min) failures.push(`${name}/${mode}: ${fg} on ${bg} ${ratio.toFixed(2)} < ${min}`);
      return {ratio, min};
    });
    console.log(`${name}/${mode}: text min ${Math.min(...ratios.filter(r => r.min === 4.5).map(r => r.ratio)).toFixed(2)}, control min ${Math.min(...ratios.filter(r => r.min === 3).map(r => r.ratio)).toFixed(2)}`);
  }
}
assert.equal(failures.length, 0, failures.join('\n'));
console.log(`Passed ${checks.length * 10} contrast pairs and ten palette structure checks.`);
