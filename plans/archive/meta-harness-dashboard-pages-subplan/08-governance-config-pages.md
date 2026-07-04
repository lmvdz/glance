# Governance and Configuration Pages
STATUS: cancelled
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/views/SettingsView.tsx, webapp/src/components/views/TeamOperatorsView.tsx, webapp/src/components/views/FederationView.tsx, webapp/src/components/views/TriggersView.tsx, webapp/src/lib/dto.ts

## Goal
Add settings/configuration, team/operators, federation policy, triggers, rate limits, audit retention, routing, and UI preferences.

## Approach
- Settings hub sections: Intelligence Routing, Resource Governance, Federation, Audit & Compliance, UI Preferences.
- Team & Operators: table, selected operator detail, permissions, role inheritance, sessions/activity.
- Federation: upgrade current Network page into operator map + delegation policy + remote steering.
- Triggers: sources, mapping wizard, activity/rate-limit rail.
- All forms use labels, native controls, save states, and disabled states for unavailable daemon contracts.

## Cross-Repo Side Effects
Potential daemon config endpoints; do not write local-only config unless it already maps to daemon behavior.

## Verify
- Forms are keyboard accessible and labeled.
- Save buttons are backed by real API or disabled with reason.
- Federation current live data still appears.
