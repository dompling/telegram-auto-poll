# Automatic Telegram choices implementation plan

Goal: Make explicit requests for user decisions produce native Telegram polls even when the agent forgets the POLL marker, and allow public answers to reach the agent through OpenClaw's existing Telegram routing.

Design: Keep the two-stage message delivery and durable journal. Inject static Telegram-only instructions on every prompt build. Add deterministic fallback recognition for explicit option lists, inline alternatives and yes/no confirmations; leave descriptions, tutorials, quoted/code examples and open questions alone. Preserve the original text as context for inferred polls. Explicit blocks keep priority and validation. Default new conversational polls to public so OpenClaw 2026.10.5 can route answers. Do not run a second Telegram updates consumer or interpret votes as privileged approvals.

Constraints: No new third-party dependencies. No external model calls. No guarantee of semantic recognition for arbitrary wording. Keep ordinary channels unaffected, retain scope/rate limits and conservative no-retry behavior. This unpacked directory has no Git repository; back up the original and edit here. Installation on the user's Mac is authorized by the requested outcome; do not send unsolicited Telegram test messages.

Approaches: Reminder alone preserves the reported failure. A separate model for every outgoing reply increases cost/latency and needs credentials. Per-turn guidance plus explicit-pattern fallback uses existing OpenClaw hooks and works without another service, so it is the chosen implementation.

## Tasks

- [x] Add failing behavior tests for missing-marker detection, option/question boundaries, false positives, formatting, limits and opt-out.
- [x] Implement src/detect.mjs and integrate it into message_sending; add autoDetect/default duration config. Verify the full suite.
- [x] Add failing tests for Telegram-only prompt guidance and host context field differences. Implement before_prompt_build without dynamic user input and make conversational polls public by default. Verify the full suite.
- [x] Verify public-poll answer routing against installed OpenClaw; surface routing warnings from successful CLI sends instead of silently discarding them. Test actual local child-process JSON parsing and error handling.
- [x] Verify runtime registration through the real OpenClaw loader in isolated temporary state. Correct README commands (validate targets tool/feature authoring metadata, not hook-only entries). Document private/group limitations.
- [x] Package v0.2.0, back up local OpenClaw config, install/enable/allow the plugin on this Mac and inspect runtime. Preserve unrelated config, disable only Telegram preview streaming as required. Verify gateway health and report that real Telegram interaction still requires user testing.
- [x] Perform fresh independent code review, address important findings with regression tests, run the full suite and syntax/static checks, and record evidence.

Review focus: explanatory lists misclassified as choices; code/quoted text; original content loss; cross-channel/account/topic routing; public answer routing unavailable or CLI timeout; failed/cancelled anchors; partial streaming finalization.

## Progress

- Baseline: v0.1.1, 17 tests previously passed. Original source backed up beside the project.
- Host research: installed OpenClaw already records public CLI polls and routes poll_answer back into normal conversation processing. Anonymous polls cannot route. Group routing needs bot administrator membership verification.
- Independent review found inline code values being lost, knowledge questions split as choices, examples spanning lines, contradictory yes/no labels for negative actions and missing common confirmations. All five addressed with RED→GREEN regression tests; full suite 31/31 green.
- Ruling: Reuse host-native public answer routing instead of adding another update consumer. Requires same OpenClaw config/state and supported host version; anonymous votes cannot reach agents.
- Ruling: Set channels.telegram.streaming.mode=off because host default preview final edits skip message_sending. Costs incremental text streaming in Telegram; full replies still arrive.
- Ruling: Respect user opt-out through prompt guidance and outgoing-text detection. No cross-turn suppression store was added; if the model ignores an opt-out and emits a recognizable choice, fallback can still convert it. Documented limitation.
- Installation: ~/.openclaw/extensions/telegram-auto-poll; runtime loaded v0.2.0, hooks 3, diagnostics empty, generation 5, no restart required. Source and installed executable modules match.
- Runtime configuration: public defaults, 3600-second inferred/guided polls, 100/chat/account/hour, 12000ms CLI timeout, both Hook permissions enabled.
- Verification: npm test 31/31; all .mjs syntax checks; JSON metadata; npm run check:host real isolated loader; live config schema valid; Telegram channel credential probe OK, running/connected, no status issues.
- Remaining host warning: plugins doctor reports provenance-invalid for unrelated multimodal-embeddings; pluginErrors empty, telegram-auto-poll diagnostics empty. No changes made to that plugin.
- Not tested: actual Telegram poll creation/click-through. No unsolicited messages sent. Full behavior awaits the user's normal Telegram interaction.
