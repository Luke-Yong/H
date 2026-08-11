# Debug Session: agent-stuck-waiting

**Status:** [OPEN]
**Started:** 2026-06-30
**Session ID:** agent-stuck-waiting

## Symptoms
- Agent state stuck at "Wait a moment..." in the Harness IDE agent console
- No more updates after running `python app.py`
- Terminal output is "very long" (user report)

## Reproduction Steps
1. Run `npm run dev:server` (or equivalent) to start the server
2. Open the H IDE client
3. Send agent message: "run python app.py"
4. Observe agent console state stuck at "Wait a moment..."

## Hypotheses

### H1: Permission prompt hidden or not rendered
The `permission_required` SSE event creates the Allow/Deny UI, but it might not be visible to the user, making it appear stuck.
- **Observation point:** Check if `permission_required` event is emitted and if the frontend message has `permissionPrompt` set.

### H2: SSE stream interrupted mid-delivery
The `tool_start` event is received (setting waiting state) but `permission_required` is lost due to SSE connection issues.
- **Observation point:** Log all SSE events sent and received.

### H3: Non-streaming agentLoop hanging on runCommand
If the non-streaming endpoint is used, `runFsTool` -> `runCommand` might hang (e.g., 2s idle timeout not triggering).
- **Observation point:** Log timing of `runCommand` execution, entry/exit.

### H4: DeepSeek API call hanging
The DeepSeek API streaming call might be hanging (timeout, network issue), never returning tool calls.
- **Observation point:** Log API call start/end times and chunk counts.

### H5: run_command handled by non-streaming loop (not streaming)
The frontend might call `/api/chat/agent` (non-streaming) instead of `/api/chat/agent/stream`, and the `run_command` tool executes server-side with `runCommand` which could hang if `python app.py` is a long-running server.
- **Observation point:** Log which endpoint is hit and whether `runCommand` returns.

## Plan
1. Add instrumentation logs to key points in `server/agent.ts` and `server/index.ts`
2. Reproduce the issue
3. Collect and analyze logs
4. Fix based on evidence
