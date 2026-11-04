# Learnable poll rules implementation plan

**Goal:** Seed the validated detection rules in a file, collect missed candidate messages in hooks, and let the current OpenClaw agent automatically propose reusable rules through a validated plugin tool.

**Architecture:** A versioned JSON document holds preset regex patterns and declarative learned rules. The detector keeps its existing structural/intent boundaries and executes literal learned templates without evaluating code or AI-generated regex. A local rule store seeds the presets, reloads changes and retains the last valid document on errors. A bounded per-chat sample journal captures unmatched candidates after successful delivery. The prompt hook offers pending samples as untrusted data and an agent tool validates/activates a proposed rule or dismisses a non-choice sample. Existing explicit POLL output remains highest priority. No extra model requests or background schedules are introduced; queued samples are learned on the next eligible agent turn.

**Behavior lock and cleanup scope:** Keep the current 161 regression tests, including unfinished numeric section work, passing. Extract matching expressions from detect.mjs into presets.json, reuse section parsing for learned templates, and keep storage, extraction and tool validation separate. Remove duplicated literal matching expressions where the preset already supplies them. No new dependencies, production configuration edits, or live Telegram messages.

**Files and interfaces:**
- rules/presets.json: version 1, patterns map, learnedRules array and documented preset families.
- src/rules.mjs: presetDocument, validateLearnedRule(rule), validateRuleDocument(document), RuleStore(path,{logger}).load()/append(rule,validateCandidate).
- src/samples.mjs: SampleStore(path).capture(fields)/pending({to,accountId,limit})/resolve(id,status)/get(id); bounded/expiring atomic local journal.
- src/detect.mjs: createChoiceDetector(document) returns the existing synchronous (content,options) => parsed|null interface; detectChoicePoll uses shipped presets.
- src/learning.mjs: bounded candidate capture predicate and plugin learning tool; proposal must demonstrate the stored source sample's literal expected question/options and pass permanent positive/negative corpus before activation.
- index.mjs: seed stores from state directory, hot reload detector by document identity, register tool, inject pending samples and capture only confirmed unmatched delivery candidates.
- tests: rule loading/reloading/recovery, literal template extraction, corpus validation, per-chat sample isolation and agent tool lifecycle. Preserve all legacy tests.

**Tasks:**
1. [ ] Add/red-test versioned rule and sample stores; implement atomic persistence, validation, bounds, dedupe and recovery.
2. [ ] Extract preset expressions, refactor detector around compiled rule documents, add/red-test declarative learned heading/question forms and ambiguity guards.
3. [ ] Add/red-test learning tool and hook lifecycle: capture missed candidates only after delivery, per-turn pending sample context, reject/validate/dedupe/activate, hot reload and preserve explicit POLL precedence.
4. [ ] Review mixed nesting, scope/authorization and failure behavior. Run full tests, JavaScript syntax/static checks and isolated OpenClaw runtime loader including tool registration. Update version/docs and publish verified changes.

**Review focus:** A learned rule cannot execute arbitrary code or regex; it cannot learn from another chat's samples, override hard exclusions, mutate preset patterns, claim a failed delivery, bypass negative cases, or silently replace conflicting rules. Store errors leave normal delivery working. Learning adds no extra model call; first misses may stay text until the next turn.
