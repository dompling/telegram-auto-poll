import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parsePollText, fallbackText } from "./src/parse.mjs";
import { createChoiceDetector, detectChoicePoll } from "./src/detect.mjs";
import { RuleStore, presetDocument } from "./src/rules.mjs";
import { SampleStore } from "./src/samples.mjs";
import { createLearningTool, isLearningCandidate, learningPrompt } from "./src/learning.mjs";
import { pollGuidance } from "./src/guidance.mjs";
import { PollJournal } from "./src/state.mjs";
import { DefiniteDeliveryError, sendPollViaCli, sendTextViaCli } from "./src/send.mjs";

const TAG = "投票编号";
const TOKEN_RE = /\[投票编号:([a-f0-9]{16})\]/;
const FALLBACK_HEADER = "【投票文字模式】";
function safeFallbackText(parsed) {
  // The visible header survives a CLI re-entry and keeps the detector from
  // turning our own text-only fallback into another poll.
  return `${FALLBACK_HEADER}\n${fallbackText(parsed)}`;
}
function isFallbackText(content) { return content.startsWith(`${FALLBACK_HEADER}\n`); }
function makeAnchor(intro, token, poll) {
  const body = intro || "📊 请查看接下来的投票。";
  // Telegram delivery is two-phase: keep readable options in the first message
  // even when the subsequent poll CLI is missing, times out, or fails.
  const alreadyReadable = intro && intro.includes(poll.question) && poll.options.every(option => intro.includes(option));
  const readable = alreadyReadable ? body : fallbackText({ intro: body, poll });
  return `${readable}\n[${TAG}:${token}]`;
}
function legacyAnchor(intro, token) {
  // Accept an anchor already sent by the previous version during an upgrade.
  return intro ? `${intro}\n\n[${TAG}:${token}]` : `📊 请查看接下来的投票。\n[${TAG}:${token}]`;
}

function stringOrEmpty(x) { return typeof x === "string" ? x.trim() : ""; }
function getChannel(event, ctx) { return ctx?.channelId ?? event?.channelId ?? event?.metadata?.channel; }
function getAccount(event, ctx) { return stringOrEmpty(ctx?.accountId ?? event?.accountId ?? event?.metadata?.accountId); }
function stableOrigin(event, ctx) {
  // A run can send multiple messages with the same choices but different text.
  // Include the complete outgoing content to avoid dropping distinct messages.
  const id = ctx?.messageId ?? event?.messageId ?? ctx?.runId;
  if (!id) return undefined;
  const raw = JSON.stringify([ctx?.sessionKey ?? "", String(id), event.to,
    event.threadId ?? ctx?.threadId ?? event.metadata?.threadId ?? "", event.content]);
  return createHash("sha256").update(raw).digest("hex");
}

export function createPlugin({
  sendPoll = sendPollViaCli,
  sendText = sendTextViaCli,
  makeJournal = path => new PollJournal(path),
} = {}) {
  return {
    id: "telegram-auto-poll",
    name: "Telegram Auto Poll",
    description: "Turn Telegram decisions into native polls with per-turn guidance and choice detection",
    register(api) {
      const config = api.pluginConfig ?? {};
      if (config.enabled === false) return;
      const logger = api.logger ?? { info() {}, warn() {} };
      const cliPath = stringOrEmpty(config.cliPath) || "openclaw";
      const timeoutMs = Number.isInteger(config.timeoutMs)
        ? Math.max(1000, Math.min(12000, config.timeoutMs)) : 9000;
      const statePath = stringOrEmpty(config.statePath) || join(homedir(), ".openclaw", "telegram-auto-poll-state.json");
      const allowedChatIds = Array.isArray(config.allowedChatIds) ? config.allowedChatIds.map(String) : [];
      const perChatHourlyLimit = Number.isInteger(config.maxPerChatPerHour)
        ? Math.max(1, Math.min(100, config.maxPerChatPerHour)) : 10;
      let journal;
      try { journal = makeJournal(statePath); }
      catch (e) {
        logger.warn(`telegram-auto-poll: cannot initialize journal; plugin disabled: ${e.message}`);
        return;
      }
      const command = { cliPath, timeoutMs };
      const durationSeconds = Number.isInteger(config.defaultDurationSeconds)
        ? Math.max(5, Math.min(604800, config.defaultDurationSeconds)) : 300;
      const learningEnabled = config.learningEnabled !== false && config.autoDetect !== false
        && typeof api.registerTool === "function";
      const dataDirectory = join(dirname(statePath), "telegram-auto-poll");
      const rulesPath = stringOrEmpty(config.rulesPath) || join(dataDirectory, "rules.json");
      let ruleStore, sampleStore, document = presetDocument, detect = detectChoicePoll;
      if (config.autoDetect !== false) {
        try {
          ruleStore = new RuleStore(rulesPath, { logger });
          document = ruleStore.load();
          detect = createChoiceDetector(document);
        } catch (error) { logger.warn(`telegram-auto-poll: using preset rules: ${error.message}`); }
      }
      if (learningEnabled && ruleStore) {
        try { sampleStore = new SampleStore(join(dirname(rulesPath), "samples.json")); }
        catch (error) { logger.warn(`telegram-auto-poll: sample learning disabled: ${error.message}`); }
      }
      if (sampleStore) api.registerTool((ctx = {}) => {
        if ((ctx.messageChannel ?? ctx.deliveryContext?.channel) !== "telegram") return null;
        const to = stringOrEmpty(ctx.nativeChannelId ?? ctx.deliveryContext?.to);
        const accountId = stringOrEmpty(ctx.agentAccountId ?? ctx.deliveryContext?.accountId);
        if (!to || (allowedChatIds.length && !allowedChatIds.includes(to))) return null;
        return createLearningTool({ ruleStore, sampleStore, scope: { to, accountId },
          assertCurrent: () => ctx.assertInvocationCurrent?.() });
      }, { name: "telegram_auto_poll_learn" });

      const stagedMisses = new Map();
      function missKey(to, accountId, content) {
        return createHash("sha256").update(JSON.stringify([to, accountId, content])).digest("hex");
      }
      function pruneMisses() {
        const cutoff = Date.now() - 300000;
        for (const [key, value] of stagedMisses) if (value.createdAt < cutoff) stagedMisses.delete(key);
        while (stagedMisses.size >= 100) stagedMisses.delete(stagedMisses.keys().next().value);
      }

      if (config.promptGuidance !== false || sampleStore) api.on("before_prompt_build", (_event, ctx) => {
        // Agent contexts use channel/messageProvider; channelId can be a chat ID.
        if ((ctx?.channel ?? ctx?.messageProvider ?? ctx?.channelId) !== "telegram") return;
        const chatId = stringOrEmpty(ctx?.chatId ?? ctx?.channelId);
        if (allowedChatIds.length && (!chatId || !allowedChatIds.includes(chatId))) return;
        let learning = {};
        if (sampleStore && chatId) {
          const accountId = stringOrEmpty(ctx?.accountId);
          learning = learningPrompt(sampleStore.pending({ to: chatId, accountId, limit: 1 }));
        }
        const guidance = config.promptGuidance !== false ? pollGuidance(durationSeconds) : "";
        return { ...learning, appendSystemContext: [guidance, learning.appendSystemContext].filter(Boolean).join("\n\n") };
      });

      // No network side effects here. Later hooks can still rewrite or cancel
      // delivery. Only a matching, successful message_sent sends the poll.
      api.on("message_sending", (event, ctx) => {
        if (getChannel(event, ctx) !== "telegram") return;
        if (typeof event?.content !== "string") return;
        if (isFallbackText(event.content)) return;
        const marker = TOKEN_RE.exec(event.content)?.[1];
        const recorded = marker && journal.getByToken(marker);
        if (recorded && (event.content === makeAnchor(recorded.intro, recorded.token, recorded.poll)
          || event.content === legacyAnchor(recorded.intro, recorded.token))) return;
        let parsed;
        try {
          parsed = parsePollText(event.content);
          if (!parsed && config.autoDetect !== false) {
            const next = ruleStore?.load() ?? document;
            if (next !== document) { detect = createChoiceDetector(next); document = next; }
            parsed = detect(event.content, { durationSeconds });
          }
        }
        catch (e) { logger.warn(`telegram-auto-poll: invalid poll: ${e.message}`); return; }
        if (!parsed) {
          const to = stringOrEmpty(event.to), accountId = getAccount(event, ctx);
          if (sampleStore && to && (!allowedChatIds.length || allowedChatIds.includes(to)) && isLearningCandidate(event.content)) {
            pruneMisses();
            stagedMisses.set(missKey(to, accountId, event.content), {
              to, accountId, content: event.content, createdAt: Date.now(),
            });
          }
          return;
        }
        const to = stringOrEmpty(event.to);
        if (!to) return { content: safeFallbackText(parsed) };
        if (allowedChatIds.length && !allowedChatIds.includes(to)) return { content: safeFallbackText(parsed) };
        const accountId = getAccount(event, ctx);
        const originKey = stableOrigin(event, ctx);
        const earlier = journal.getByOrigin(originKey);
        if (earlier) {
          logger.info("telegram-auto-poll: duplicate origin downgraded to text");
          return { content: safeFallbackText(parsed) };
        }
        if (journal.countRecent(to, accountId, Date.now() - 3600000) >= perChatHourlyLimit) {
          logger.warn("telegram-auto-poll: hourly limit reached; falling back to choices");
          return { content: safeFallbackText(parsed) };
        }
        const threadId = event.threadId ?? ctx?.threadId ?? event.metadata?.threadId;
        try {
          const record = journal.create({ to, accountId, threadId, intro: parsed.intro, poll: parsed.poll, originKey });
          return { content: makeAnchor(record.intro, record.token, record.poll) };
        } catch (e) {
          logger.warn(`telegram-auto-poll: journal write failed; text fallback: ${e.message}`);
          return { content: safeFallbackText(parsed) };
        }
      });

      api.on("message_sent", async (event, ctx) => {
        if (getChannel(event, ctx) !== "telegram" || typeof event?.content !== "string") return;
        if (isFallbackText(event.content)) return;
        if (sampleStore) {
          pruneMisses();
          const key = missKey(stringOrEmpty(event.to), getAccount(event, ctx), event.content);
          const staged = stagedMisses.get(key);
          stagedMisses.delete(key);
          if (staged && event.success === true) {
            try { sampleStore.capture({ to: staged.to, accountId: staged.accountId, content: staged.content }); }
            catch (error) { logger.warn(`telegram-auto-poll: cannot collect choice sample: ${error.message}`); }
          }
        }
        let token = TOKEN_RE.exec(event.content)?.[1];
        let record;
        if (!token) {
          // Stream previews can bypass message_sending. Only their successful
          // final delivery receipt is eligible; never infer completion by timer.
          if (event.success !== true) return;
          const to = stringOrEmpty(event.to), accountId = getAccount(event, ctx);
          const messageId = event.messageId ?? ctx?.messageId;
          if (!to || messageId == null || String(messageId).trim() === "") return;
          if (allowedChatIds.length && !allowedChatIds.includes(to)) return;
          const threadId = event.threadId ?? ctx?.threadId ?? event.metadata?.threadId;
          const originKey = createHash("sha256").update(JSON.stringify([
            "delivered", to, accountId, String(messageId), threadId ?? "",
          ])).digest("hex");
          if (journal.getByOrigin(originKey)) return;
          let parsed;
          try {
            parsed = parsePollText(event.content);
            if (!parsed && config.autoDetect !== false) {
              const next = ruleStore?.load() ?? document;
              if (next !== document) { detect = createChoiceDetector(next); document = next; }
              parsed = detect(event.content, { durationSeconds });
            }
            if (!parsed) return;
            if (journal.countRecent(to, accountId, Date.now() - 3600000) >= perChatHourlyLimit) return;
            record = journal.create({ to, accountId, threadId, intro: parsed.intro, poll: parsed.poll, originKey });
            token = record.token;
          } catch (error) {
            logger.warn(`telegram-auto-poll: cannot prepare delivered text poll: ${error.message}`);
            return;
          }
        } else {
          record = journal.getByToken(token);
          // Do not act on a stale/rewritten message that happens to contain a token.
          if (record && event.content !== makeAnchor(record.intro, record.token, record.poll)
            && event.content !== legacyAnchor(record.intro, record.token)) return;
        }
        if (!record || record.status !== "pending") return;
        if (stringOrEmpty(event.to) !== record.to) return;
        const accountId = getAccount(event, ctx);
        if (accountId && record.accountId && accountId !== record.accountId) return;
        if (event.success !== true) {
          // Even an unsuccessful logical send may be partially visible.
          try { journal.setStatus(token, "anchor_failed"); }
          catch (e) { logger.warn(`telegram-auto-poll: journal failure: ${e.message}`); }
          return;
        }
        try { journal.setStatus(token, "sending"); }
        catch (e) { logger.warn(`telegram-auto-poll: cannot safely record send attempt: ${e.message}`); return; }
        try {
          const result = await sendPoll({ ...command, to: record.to, threadId: record.threadId,
            accountId: record.accountId, poll: record.poll });
          journal.setStatus(token, "sent");
          const delivery = result?.payload ?? result;
          if (delivery?.warning) logger.warn(`telegram-auto-poll: ${delivery.warning}`);
          logger.info("telegram-auto-poll: poll sent after anchor delivery");
        } catch (e) {
          const definite = e instanceof DefiniteDeliveryError;
          try { journal.setStatus(token, definite ? "failed" : "uncertain"); }
          catch (saveError) { logger.warn(`telegram-auto-poll: journal failure: ${saveError.message}`); }
          if (!definite) {
            logger.warn(`telegram-auto-poll: delivery unknown, refusing automatic retry: ${e.message}`);
            return;
          }
          logger.warn(`telegram-auto-poll: no CLI execution; sending readable fallback: ${e.message}`);
          // A definite local spawn failure means the poll command did not run.
          try { await sendText({ ...command, to: record.to, threadId: record.threadId,
              accountId: record.accountId, message: safeFallbackText({ intro: "", poll: record.poll }) }); }
          catch (fallbackError) { logger.warn(`telegram-auto-poll: fallback failed: ${fallbackError.message}`); }
        }
      });
    },
  };
}

export default createPlugin();
