# Two-browser DB-mode multiplayer smoke

Purpose: prove the room works with two real browser identities in DB mode without touching the operator's live daemon or the default ports.

## Safety contract

- Use a throwaway state dir, HOME, browser profiles, and DB/schema namespace.
- Never use ports `7878` or `7879`.
- Disable autonomous loops before boot: `OMP_SQUAD_AUTODISPATCH=0`, `OMP_SQUAD_AUTODRIVE=0`, `OMP_SQUAD_AUTOLAND=0`, `OMP_SQUAD_AUTOSUPERVISE=0`, `OMP_SQUAD_AUTO_SUPERVISE=0`, `OMP_SQUAD_LAND_CONFIRM=1`.
- Do not let the scratch daemon read the operator's Plane secrets: set `HOME` to an empty temp dir and unset `PLANE_API_KEY` / `PLANE_API_TOKEN`.
- Use fake users only. Do not reuse a real browser profile or real org.
- Teardown by the recorded scratch PID/port, never by `pkill -f`.

## Boot

```bash
export REPO=/absolute/path/to/omp-squad
export SCRATCH_ROOT=$(mktemp -d /tmp/glance-room-smoke-XXXXXX)
export OMP_SQUAD_STATE_DIR="$SCRATCH_ROOT/state"
export HOME="$SCRATCH_ROOT/home"
export SCRATCH_CWD="$SCRATCH_ROOT/cwd"
export PORT=18818
export OMP_SQUAD_WEBAPP=1
export OMP_SQUAD_AUTODISPATCH=0 OMP_SQUAD_AUTODRIVE=0 OMP_SQUAD_AUTOLAND=0
export OMP_SQUAD_AUTOSUPERVISE=0 OMP_SQUAD_AUTO_SUPERVISE=0 OMP_SQUAD_LAND_CONFIRM=1
unset PLANE_API_KEY PLANE_API_TOKEN
mkdir -p "$OMP_SQUAD_STATE_DIR" "$HOME" "$SCRATCH_CWD"
cd "$SCRATCH_CWD"
nohup bun "$REPO/src/index.ts" up --no-tui --port "$PORT" > "$OMP_SQUAD_STATE_DIR/daemon.log" 2>&1 &
echo $! > "$OMP_SQUAD_STATE_DIR/daemon.pid"
```

Probe:

```bash
curl -fsS "http://127.0.0.1:$PORT/api/health"
curl -fsS "http://127.0.0.1:$PORT/api/auth/mode"
TOKEN=$(cat "$OMP_SQUAD_STATE_DIR/access-token")
```

Expected: health returns JSON; auth mode is the intended scratch mode. If DB mode is required for the run, point `DATABASE_URL` at a throwaway database/schema before boot and create two fake sessions through the local auth test helper for `alex@example.test` and `blair@example.test`.

## Browser setup

Use two isolated agent-browser sessions/profiles. Keep content boundaries on so page text is never treated as instructions.

```bash
export AGENT_BROWSER_CONTENT_BOUNDARIES=1
agent-browser --session room-alex open "http://127.0.0.1:$PORT/#fleet?token=$TOKEN"
agent-browser --session room-blair open "http://127.0.0.1:$PORT/#fleet?token=$TOKEN"
agent-browser --session room-alex wait --text "Message #fleet"
agent-browser --session room-blair wait --text "Message #fleet"
```

For DB-mode fake users, load the pre-created session state instead of the bearer-token URL:

```bash
agent-browser --session room-alex state load "$SCRATCH_ROOT/alex-state.json"
agent-browser --session room-blair state load "$SCRATCH_ROOT/blair-state.json"
agent-browser --session room-alex open "http://127.0.0.1:$PORT/#fleet"
agent-browser --session room-blair open "http://127.0.0.1:$PORT/#fleet"
```

## Flow

1. Alex posts `hello from alex` in `#fleet`.
   ```bash
   agent-browser --session room-alex snapshot -i
   agent-browser --session room-alex fill @TEXTAREA_REF "hello from alex"
   agent-browser --session room-alex press Enter
   agent-browser --session room-blair wait --text "hello from alex"
   ```
2. Blair types `typing from blair` but does not send for at least one second.
   ```bash
   agent-browser --session room-blair fill @TEXTAREA_REF "typing from blair"
   agent-browser --session room-alex wait --text "Blair is typing"
   ```
3. Blair sends the message; Alex sees it, and the typing indicator disappears.
   ```bash
   agent-browser --session room-blair press Enter
   agent-browser --session room-alex wait --text "typing from blair"
   agent-browser --session room-alex wait --fn "!document.body.innerText.includes('Blair is typing')"
   ```
4. Unread badges: keep Alex on `#fleet`; create or switch Blair to `#ops`, post a message, then confirm Alex's rail shows a non-zero badge beside `#ops`. Open `#ops` in Alex, reload, and confirm the badge stays cleared.
5. Concurrent steer: create or select one scratch agent visible in the channel. Alex sends `@agent first steer`; Blair sends `@agent second steer` within 15 seconds. Confirm the later channel echo includes `follows db:<alex-user-id>'s steer` (or the fake display id used in file-mode smoke).
6. Persistence check: typing must not be durable.
   ```bash
   curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/channels/fleet/entries?since=0" \
     | jq -e '.entries | all(.event?.kind != "typing")'
   grep -R "typing from blair\|is typing" "$OMP_SQUAD_STATE_DIR" && exit 1 || true
   ```
7. Reload both browser sessions and confirm chat history and read-cursor badge state survive reload.

## Evidence to attach

Record:

- Scratch root path and port.
- Browser session names.
- `GET /api/channels` before and after opening the unread channel, showing `unreadCount` and `lastReadSeq` for the acting user.
- `GET /api/channels/fleet/entries?since=0` filtered to prove no typing event persisted.
- A screenshot or snapshot from each browser showing the other user's message, typing indicator, unread badge, and concurrent-steer echo.

## Teardown

```bash
kill "$(cat "$OMP_SQUAD_STATE_DIR/daemon.pid")"
agent-browser --session room-alex close
agent-browser --session room-blair close
rm -rf "$SCRATCH_ROOT"
```
