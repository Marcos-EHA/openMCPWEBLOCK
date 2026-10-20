# Workspace: validation checkpoint, 2026-10-15

Status: IN PROGRESS. End-to-end operation is NOT validated.

## User acceptance scope

The Web coordinator must receive its startup instructions and produce a verified response before workers proceed. Workers need equivalent preparation for their roles. Instance cards must continue reflecting actual activity after launch. Tools advertised to each model must match the available and enabled tools. Tests, failures, pending work, delegation and history must be documented and eventually visible in Workspace.

## Verified evidence

- Conversation access, coordinator and invariants: 40 passing tests, 0 failures, 130 assertions. Log: logs/workspace-coordinator-revalidation.txt.
- Corrected misplaced privacy assertions and coordinator tests to match the existing dedicated Web coordinator policy. Authenticated worker routing remains covered.
- ConversationAccess reserves browser resources within one process and rejects competing dispatches. This is not a cross-process lock and does not establish that browser generation stopped after a timeout.
- Changed response timeout handling: an increased assistant-message count at timeout no longer returns potentially incomplete text as a successful result. The error explicitly says completion is unconfirmed and the prompt must not be automatically resent.
- Project build after the timeout change completed. Log: logs/workspace-response-timeout-build.txt. This build preceded the subsequent adapter change; it does not validate that later change or live deployment.
- ChatGPT adapter now uses the observed data-local-conversation-final-assistant container alongside legacy assistant attributes, excluding nested legacy matches inside the current container.
- Adapter and provider validation: 42 passing tests, 0 failures, 122 assertions. Log: logs/workspace-chatgpt-adapter-validation.txt.
- Five of those tests used isolated headless Chrome with synthetic HTML: legacy messages, current containers, nested deduplication, latest response, and user-only content. They did NOT interact with live ChatGPT or launch Workspace workers.
- UTF-8 checks on WebRelayCoordinator.test.ts, WebRelayProvider.ts and orchestration/types.ts passed with no replacement characters. Accented sample text was correct on disk. The exact output-encoding failure point remains unidentified.

## Observed gaps

1. prepareSAAgentForWebRelay configures the extension and waits for MCP connectivity; it does not validate a startup model response.
2. waitForSAConnection accepts global connection/tool counts, without proving the specific newly launched instance is connected.
3. MultiAgentRunner can reach ready after non-blocking identity-stamp or MCP-health warnings. These conditions need distinct operational treatment.
4. Chrome-profile authentication failures can be recorded as warnings while preparation continues. A browser awaiting login must not be presented as task-ready.
5. agent:sa-preparation-status toggles sa_preparing/ready using a boolean; it carries no startup-response evidence.
6. The default provider prompt advertises a limited core tool subset, while coordinator instructions mention activity tools. Live catalog, enablement and prompt consistency remain to be checked.
7. The startup prompt instructs the model to stop after each call. Multiple emitted calls produced only first-call results in this conversation; parser/render/execution behavior for multiple calls has NOT been established.
8. Response completion detection still needs live verification, including streaming, tool-result continuation and cancellation. A timeout correction alone does not solve those cases.

## Pending work and acceptance evidence

- [ ] Add explicit per-instance startup validation: role, fresh correlated response, failures and timeout outcome. Verify coordinator before workers. Do not treat an acknowledgement as proof of tool execution.
- [ ] Verify actual available/enabled tools and generate a consistent role-specific catalog without discarding required schema details.
- [ ] Run an authorized harmless tool round-trip per relevant role and correlate its real result with the originating instance.
- [ ] Verify the updated ChatGPT adapter against the live page; confirm generation detection and final response extraction.
- [ ] Preserve browser ownership while an outcome remains uncertain; review shared relay response correlation and cleanup of competing waits.
- [ ] Ensure authentication failures cannot enter the task-ready pool; preserve manual sign-in workflows.
- [ ] Build after the adapter changes and verify which running process/bundle is active.
- [ ] Run a visible end-to-end coordinator/worker task and document prompts, expected outcomes, observed results and remaining failures. Protect credentials and unrelated conversation content.
- [ ] Keep instance cards useful after launch: current task, model wait, local tool execution, elapsed time, confirmed completion, failure and unknown outcome. A timer is not progress evidence.
- [ ] Distinguish no textual output, background execution and redirected output using actual execution status and handles.
- [ ] Persist pending tasks and delegation history, then expose this evidence in Workspace. This Markdown file alone does not implement that UI integration.
- [ ] Check result formatting and truncation: readable cards for users, complete structured results for the model, retrievable full output where needed.
- [ ] Locate and fix the output-encoding boundary without rewriting valid source files.
- [ ] Deferred UX issue: dragging the compact MCP icon can attach its image to ChatGPT.

## Test reporting rule

Keep unit tests, synthetic browser tests, builds and live end-to-end checks separate. Never report an instance operational solely because Chrome opened, a timer expired, or a test suite passed. Record unresolved outcomes without automatically resending effectful work.
\nCheckpoint 17:00 America/Lima: startup acknowledgement integrated into automatic launch and restart; startup_verifying lifecycle and labels added to both Workspace views. Lifecycle suite: 29 pass, 94 assertions. Handshake and launch suites: 35 pass, 159 assertions. Build exit 0. Logs: workspace-startup-lifecycle-final.txt, workspace-startup-launch-final.txt, workspace-startup-phase-build.txt in logs/. Suites ran in separate processes because launch mocks replace RelayBus and interfere with its tests when combined. Live startup, tool round-trip and persisted acknowledgement evidence remain pending.

## Checkpoint 2026-10-16: bounded diagnostics and recoverable launch UI

Confirmed storage incident: 17,119 diagnostic entries consumed 9,258,826 bytes of the 10 MiB extension quota. Archived to logs/execution-diagnostics-backup-1792129484237.json; SHA-256 6fb350bd2069cfe530adad5095d883c621d0bbbbcb43c70c7afb4e632206dd84. Removed only entries matching that verified backup. Execution records, result blobs and configuration were not removed.
Diagnostic writes now use at most 256 shared sample slots, a 4096-byte event ceiling and a 2 MiB headroom check. This is lossy technical sampling, not task history. Existing legacy entries are not automatically deleted. Registry quota recovery compacts copies rather than live responses and no longer drops unfinished records. Both extension packages passed type checks and builds; 5 diagnostic tests and 16 registry tests passed. After user reload, live storage showed bounded slots and approximately 1.30 MiB usage.
Workspace LaunchOperations persists requests before dispatch in .openmcp/workspace-launches under the server working directory. Same request ID and settings are not dispatched twice. Restarted running records become unknown and block new asynchronous launches. GET /api/launch-operations is same-origin protected; POST /api/launch?async=1 returns an operation. The existing synchronous API remains compatible.
Launch dialog stores pending identity before sending, polls operation history, shows elapsed time and outcomes, survives closing/reopening, and recovers a missing acknowledgement using the original request ID. Connection errors block new launches. Tests: LaunchOperations 7 pass; existing WebUIServer 16 pass; isolated Chrome dialog tests 4 pass. Project build passed.
Live Workspace restarted only after verifying zero agents and tasks. New process PID 13448. Health and protected launch-history endpoint returned HTTP 200. Dialog loaded 12 platforms, showed empty history and enabled launch with no error. No real agent was launched by this validation.
Pending: reproduce and repair the real coordinator compact-control readiness failure; correlate MCP readiness per instance; verify actual tool execution and complete task flow. Unknown launch outcomes currently remain blocked for inspection; an explicit evidence-based reconciliation UI is still needed. Legacy HTTP/WebSocket launch entrypoints have not been migrated to the durable async registry. Other workspace operations and service startup still need recoverable operation handling. Diagnostic slot bounds do not constitute an atomic global storage reservation.
