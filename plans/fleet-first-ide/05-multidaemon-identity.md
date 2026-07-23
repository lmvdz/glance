# Epic M — Multi-daemon, identity, release

STATUS: done — epic merged (see 00-meta close-out); verified on main, 2026-07-21 reality audit
PRIORITY: p3
REPOS: glance-desktop
COMPLEXITY: architectural
BLOCKED_BY: epic C

## Charter (loop expands into a sub-plan when unblocked)

The cockpit connects to N daemons (local + over SSH — terax already merged native SSH PTY/SFTP, #276); the fleet view spans hosts. Product identity pass: full glance branding (brand.md, ember accent), installers/updater pipeline for the three OSes, and the decision point on hard divergence from upstream terax (per meta decision: acceptable once the fleet module is the primary surface). Web + push remain the away-from-desk surface.

Expansion trigger: Epic C merged and the suite in daily use; parallel to I/E if Lars wants an installable build earlier.
