#!/usr/bin/env python3
"""Seed a scratch #fleet channel with a realistic mixed history.

Shapes mirror the daemon's own emitters (squad-manager projectionFace / needsYouFace /
tokenBurnFace / landCardView) so the render path sees what production will produce once the
needs-you worthiness rule is in place. This doubles as the love-gate (concern 23) seed rig.
"""
import json, sys, uuid, time

state = sys.argv[1]
t0 = int(time.time() * 1000) - 3 * 3600 * 1000
rows, seq = [], 0

def row(mins, text, kind="system", event=None, author="manager", display=None, fmt="stage"):
    global seq
    seq += 1
    e = {"id": str(uuid.uuid4()), "seq": seq, "channelId": "fleet", "authorActor": author,
         "kind": kind, "text": text, "ts": t0 + mins * 60000, "status": "ok", "format": fmt}
    if display: e["authorDisplayName"] = display
    if event: e["event"] = {"kind": event[0], "issuer": "manager", "payload": event[1]}
    rows.append(e)

def face(**kw): return kw

U = "room-18-membership-mrz51t7z"
row(0, "morning — what landed overnight?", kind="user", author="web:admin", display="Lars", fmt="markdown")
row(2, "plan card · the-room concern 18", event=("plan-card", {
    "refs": {"unitId": U, "planId": "the-room-18"}, "doorSurface": "plan",
    "face": face(unitId=U, unitName="room-18-membership", eventKind="plan-card",
                 title="Plan revised · membership + per-channel fan-out",
                 body="6 steps, 2 with leak tests. Awaiting your review before the unit starts.",
                 status="proposed", tone="info", pinned={"plan": "the-room/18", "steps": 6, "agent": "room-18-membership"})}))
row(31, "gate verdict · pass · agreement 0.92 · confidence 0.88", event=("gate-verdict", {
    "refs": {"unitId": U}, "doorSurface": "gate-verdict",
    "face": face(unitId=U, unitName="room-18-membership", eventKind="gate-verdict",
                 title="Gate verdict · pass", status="pass", tone="success",
                 validation={"verdict": "pass", "agreement": 0.92, "confidence": 0.88, "ranAt": t0 + 31 * 60000,
                             "rationale": "Leak tests cover non-member WS, HTTP and search paths.",
                             "perCriterion": [{"criterion": "tests cover the claim", "verdict": "pass"},
                                              {"criterion": "no bare broadcast( in channel paths", "verdict": "pass"},
                                              {"criterion": "revocation is positive-evidence", "verdict": "pass"}]},
                 pinned={"agreement": "0.92", "confidence": "0.88", "agent": "room-18-membership"})}))
row(44, "needs you · GATE: land membership to main?", event=("needs-you", {
    "refs": {"unitId": U}, "doorSurface": "intervence",
    "face": face(unitId=U, unitName="room-18-membership", eventKind="needs-you",
                 pendingId="gate_land_1", pendingStatus="pending",
                 title="Needs you · GATE: land membership to main?",
                 body="Tenancy path — cross-lineage review is green, merge is yours.",
                 detail="Click to step into the agent.", tone="warning",
                 pinned={"agent": "room-18-membership", "age": "4m"})}))
row(46, "on it", kind="user", author="web:admin", display="Lars", fmt="markdown")
row(52, "land attempt · squad/room-18-membership → main", event=("land-attempt", {
    "refs": {"unitId": U, "landId": "att-91"}, "doorSurface": "land",
    "face": face(unitId=U, unitName="room-18-membership", eventKind="land-attempt",
                 title="Land attempt · squad/room-18-membership", status="attempting", tone="info",
                 branch="squad/room-18-membership", target="main", sha="c3f463d")}))
row(53, "land assessment · low risk · recommend land", event=("land-assessment", {
    "refs": {"unitId": U, "landId": "att-91"}, "doorSurface": "land",
    "face": face(unitId=U, unitName="room-18-membership", eventKind="land-assessment",
                 title="Land assessment · low risk", status="assessed", tone="info",
                 risk="low", recommendation="land", branch="squad/room-18-membership", target="main")}))
row(55, "land merge · PR #248 merged", event=("land-merge", {
    "refs": {"unitId": U, "landId": "att-91"}, "doorSurface": "land-merge",
    "face": face(unitId=U, unitName="room-18-membership", eventKind="land-merge",
                 title="Landed · PR #248 merged to main", status="merged", tone="success",
                 branch="squad/room-18-membership", target="main", sha="c3f463d",
                 prNumber=248, prUrl="https://github.com/lmvdz/omp-squad/pull/248",
                 doneProofVerified="verified")}))
row(58, "fleet token burn · 412k tokens · $8.41", event=("token-burn-snapshot", {
    "refs": {"reason": "daily-rollup"}, "doorSurface": "fleet-economics",
    "face": face(title="Fleet burn · today", body="412,038 tokens across 4 units · $8.41 of the $200 monthly plan.",
                 status="ok", tone="info", pinned={"tokens": "412,038", "cost": "$8.41", "units": 4})}))
row(60, "nice. what's the next blocker?", kind="user", author="web:admin", display="Lars", fmt="markdown")

with open(f"{state}/channels.jsonl", "w") as f:
    for r in rows: f.write(json.dumps(r) + "\n")
with open(f"{state}/channels.json", "w") as f:
    json.dump([{"id": "fleet", "name": "#fleet", "createdAt": t0, "kind": "default"}], f)
print(f"seeded {len(rows)} entries into {state}")
