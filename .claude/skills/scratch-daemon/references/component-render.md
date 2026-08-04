# Component-level rendering without a daemon

For verifying a single UI component when booting a daemon is overkill: SSR the component with
real receipt data, bundle as **IIFE** (ESM breaks over `file://`), load it via an external
script tag (inline `</script>` in the data breaks the page), then screenshot with headless
chromium. Look at the screenshot before shipping — "I iterated blind three times" is the mined
anti-pattern this exists to prevent.
