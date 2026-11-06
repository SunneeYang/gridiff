# Gridiff interface prototype

This context is scoped to the design artifacts in this directory, not a production specification.

- Product: a read-only CSV/XLSX comparison tool, with a standalone CLI/browser and an independently usable VS Code extension.
- People: game configuration planners and developers reviewing saved local edits or Git versions on desktop.
- Task: identify the two versions, understand which records/fields changed, and inspect old versus new values in context.
- Evidence: repository before/after fixtures; synthetic second sheet and long-text states are explicitly labeled.
- Deliverable requested: design proposals and an interactive prototype, not production implementation or release.
- Current correction: palette changes and reading-layout changes are both insufficient. Component families must visibly differ in buttons, input construction, tabs, badges, borders, shadows and interaction states while keeping the same layout and data.
- Preserve: old then new, added/removed/modified and schema-only changes, source order, search/filter scope, loaded-sheet boundaries, accessible labels and keyboard focus.
- Limits: no edits to source tables, no approval state inferred from reading, no simulated Git provenance, no production comparison logic in the prototype.
- Themes: multiple contrasting style candidates, each with light/dark support; do not lock a single permanent product identity before user review.
