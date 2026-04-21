# Fixtures

## subagent-details-verify.json

Hand-authored reference matching pi-ai's `ToolCall` / `ToolResultMessage` /
`AssistantMessage` shape inside the pi-subagents `SubagentDetails` envelope.
Used by dispatcher and integration tests to exercise the `tool_result` hook
without spawning a real subagent process.

### Regenerating from a live pi-subagents run

1. In a scratch branch, add a one-off listener that dumps the raw event payload:
   ```ts
   pi.on("tool_result", (e) => {
     if ((e as { toolName?: string }).toolName === "subagent") {
       writeFileSync("dump.json", JSON.stringify(e, null, 2));
     }
   });
   ```
2. Run `/tff verify` on a slice whose `VERIFICATION.md` passes audit.
3. Copy the dumped payload into this fixture (preserve the top-level
   `{ toolName, details }` shape). Flip `_meta.source` to `"live-capture"`.
4. Update `_meta.piAiVersion` from
   `node_modules/@mariozechner/pi-ai/package.json`:
   ```sh
   node -e "console.log(JSON.parse(require('fs').readFileSync('node_modules/@mariozechner/pi-ai/package.json','utf-8')).version)"
   ```
5. Update `_meta.piSubagentsVersion` from
   `node_modules/pi-subagents/package.json` the same way.
6. Run `bun run test tests/unit/common/fixture-version.spec.ts` to confirm the
   version-lock assertions still pass.

### Version-lock policy

`tests/unit/common/fixture-version.spec.ts` asserts that
`_meta.piAiVersion` and `_meta.piSubagentsVersion` match the versions
installed in `node_modules/`. A mismatch fails the test, signalling that a
re-capture is required before merging the dependency bump.
