# Diagram sources

- `arch.txt` → `../architecture.png`, rendered with [carbon.now.sh](https://carbon.now.sh):
  theme `seti`, language Plain Text, font Hack 13.5px, line-height 100%, padding 28px,
  transparent background, drop shadow, 2x export. Paste the file into carbon (or build a
  share URL with those params as `URLSearchParams` + `code=`), zero out the editor's
  min-height, and use quick export.
- `../tui.png` is **not** a mockup — it's a screenshot of the real TUI against a scratch
  daemon (three agents: one held on a bash approval, one working, one idle), captured from
  a 112×12 tmux pane with `capture-pane -e`, converted SGR→HTML, screenshotted at 2x, and
  finished with rounded corners + shadow via sharp. Re-stage with the scratch-daemon skill.
