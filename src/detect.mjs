import { parsePollText } from "./parse.mjs";

const SELECTION = /请选择|请选|(?:你|您).*(?:选一个|选哪个|选哪一个|选择哪|选什么|先做哪个|先做哪一个|选(?:择)?\s*(?:方案|选项)?\s*[A-L])|(?:你|您).*(?:倾向|喜欢|希望).*(?:哪个|哪一个|哪种|哪一种|哪项|哪一项|哪条|哪一条|哪套|哪一套)|(?:选|选择|采用|使用|用|走|要|先做|优先处理)(?:哪个|哪一个|哪种|哪一种|哪项|哪一项|哪条|哪一条|哪套|哪一套)|which\b.*\b(?:prefer|choose|pick|like)|\b(?:please\s+)?(?:choose|pick|select)\b/i;
const KNOWLEDGE = /为什么|怎么|如何|哪里|何时|谁|多少|知道|明白|理解/;
const FREE_INPUT = /自定义|自由输入|自己的方案|type your own|(?:回复|输入|告诉我|提出).*(?:其他|其它|别的|你自己的)|(?:其他|其它|别的)想法.*(?:直接说|告诉我|回复)|(?:suggest|enter|type|reply with).*(?:another|your own|custom)/i;
const WITHDRAWN = /不用了|(?:不用|不必|无需|不需要)(?:再)?(?:选择|选|确认|继续)|(?:任务|安装|操作)(?:已经|已)?(?:取消|结束|执行完成)|(?:已经|已)取消(?:安装|操作|任务)?/;
const OPTION = /^(?:[-*+]\s+|\d{1,2}[.、)）]\s*|[A-La-l][.、:：)）]\s*|[（(](?:\d{1,2}|[A-La-l])[)）]\s*)(.+)$/;
const SECTION_OPTION = /^(?:[-*+]\s+)?(?:方案\s*|选项\s*)?(?:([A-Za-z])[.、:：)）]\s*|[（(]([A-Za-z])[)）]\s*)(.+)$/;

function clean(text) {
  return text.replace(/\*\*|__/g, "").replace(/^#{1,6}\s+/, "").trim();
}

function visibleLines(content) {
  let fence;
  const lines = [];
  for (const raw of content.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      // Keep a boundary so a list cannot span a hidden example.
      lines.push("");
    } else if (fence || /^\s*>/.test(raw)) lines.push("");
    else if (raw.trim()) lines.push(clean(raw.replace(/`([^`]*)`/g, "$1")));
  }
  return lines;
}

function build(content, question, options, durationSeconds) {
  try {
    const parsed = parsePollText(`[POLL]\n${JSON.stringify({ question, options,
      anonymous: false, multi: /多选|多个|multiple|all that apply/i.test(question), durationSeconds })}\n[/POLL]`);
    return { intro: content.trim(), poll: parsed.poll };
  } catch { return null; }
}

function optionLabel(text) {
  return clean(text).replace(/^(?:选项\s*)?[A-La-l][：:]\s*/, "").replace(/[，,。；;]+$/, "").trim();
}

function isIllustration(line) {
  return /^(?:示例|教程|例如|比如|example|tutorial)|^(?:以下|下面|这里|这是|举个).*(?:示例|例子|教程|example|tutorial)/i.test(line)
    || /操作步骤|以下步骤|依次执行|然后.*(?:执行|操作)/.test(line)
    || /(?:这是|只是|仅供|仅是).*(?:示例|例子|模板)|(?:生成|展示)(?:以下|下列)(?:问题|问句|文本|字符串)/.test(line);
}

function inExample(lines, questionIndex) {
  if (isIllustration(lines[questionIndex])) return true;
  // A parenthetical example in a diagnostic bullet does not turn the final
  // question into a tutorial. Only nearby introductory headings establish one.
  return lines.slice(0, questionIndex)
    .filter(line => line && !OPTION.test(line) && !/^•\s*/.test(line))
    .slice(-2).some(isIllustration);
}

function alternativeLabel(text) {
  return optionLabel(text.replace(/[？?]+$/, "").replace(/[吗呢]$/, "")
    .replace(/^要(?=我|我们|你|您)/, ""));
}

function questionInLine(line) {
  const tailIndex = Math.max(line.lastIndexOf("？"), line.lastIndexOf("?"));
  if (FREE_INPUT.test(line) || WITHDRAWN.test(line.slice(tailIndex + 1))) return undefined;
  const sentences = line.match(/[^。！!？?]+[？?]/g)?.map(text => text.trim()) ?? [];
  const tail = sentences.at(-1);
  // An alternative introduced with 还是 belongs to the immediately preceding
  // question, never to every earlier question in the paragraph.
  return /^还是/.test(tail ?? "") && sentences.length >= 2 ? sentences.at(-2) + tail : tail;
}

function finalQuestion(lines) {
  let index = lines.length - 1;
  let last = lines[index] ?? "";
  if (/^还是/.test(last) && /[？?]$/.test(lines[index - 1] ?? "")) {
    index--;
    last = `${lines[index]}${last}`;
  }
  if (inExample(lines, index)) return null;
  return questionInLine(last);
}

function selectionQuestion(line) {
  if (!line || isIllustration(line)) return undefined;
  const question = questionInLine(line);
  if ((/[？?]/.test(line) && !question) || KNOWLEDGE.test(question ?? line) || FREE_INPUT.test(line)) return undefined;
  if (!question && !/[：:]$/.test(line)
    && !/^(?:请选择|请选|(?:你|您).*选一个|(?:please\s+)?(?:choose|pick|select)\b)/i.test(line)) return undefined;
  return SELECTION.test(question ?? line) ? question ?? line : undefined;
}

function sectionReferences(question) {
  const list = /(?:^|[^A-Za-z])((?:(?:方案|选项|option|plan)\s*)?[A-Z](?:\s*(?:[、,，/]|还是|或者?|或|和|与|or|and)\s*(?:(?:方案|选项|option|plan)\s*)?[A-Z])+)(?![A-Za-z])/i.exec(question)?.[1];
  if (!list) return [];
  return list.replace(/方案|选项|option|plan/gi, "").split(/\s*(?:[、,，/]|还是|或者?|或|和|与|or|and)\s*/i)
    .map(label => label.trim().toUpperCase().charCodeAt(0) - 65);
}

function sectionGroups(lines) {
  const groups = [];
  let group;
  for (let i = 0; i < lines.length; i++) {
    const match = SECTION_OPTION.exec(lines[i]);
    if (!match) {
      if (selectionQuestion(lines[i])) group = undefined;
      continue;
    }
    const ordinal = (match[1] ?? match[2]).toUpperCase().charCodeAt(0) - 65;
    if (!group || ordinal === 0) {
      group = { start: i, end: i, options: [], valid: ordinal === 0, section: true };
      groups.push(group);
    }
    if (ordinal !== group.options.length) group.valid = false;
    group.options.push(optionLabel(match[3]));
    group.end = i;
  }
  return groups.map((group, index) => {
    const limit = groups[index + 1]?.start ?? lines.length;
    const after = lines.findIndex((line, i) => i > group.end && i < limit && selectionQuestion(line));
    // A prompt introducing a new numbered/bullet list belongs to that list.
    const introducesList = after !== -1 && OPTION.test(lines[after + 1] ?? "")
      && !SECTION_OPTION.test(lines[after + 1] ?? "");
    const questionIndex = selectionQuestion(lines[group.start - 1]) ? group.start - 1
      : after !== -1 && !introducesList ? after : undefined;
    return { ...group, questionIndex, scopeEnd: after === -1 ? limit - 1 : introducesList ? after - 1 : after };
  });
}

function questionPoll(content, question, durationSeconds) {
  const body = question.slice(0, -1).trim();
  if (KNOWLEDGE.test(body)) return null;
  let alternatives;
  if (body.includes("还是") && !/^(?:你|您|我|我们)?还是/.test(body)) {
    alternatives = body.replace(/^(?:请问[，,\s]*)?(?:(?:你|您)(?:是)?(?:想|要|希望|更喜欢(?:哪个|哪一个)?|更倾向于(?:哪个|哪一个)?)|(?:你|您)(?:选|选择)|请选择)[：:\s]*/, "")
      .split(/[，,]?\s*还是\s*/);
  } else if (/\bor\b/i.test(body) && /^(?:which|would you|do you|should we|please choose)/i.test(body)) {
    alternatives = body.replace(/^(?:which\b.*?:\s*|(?:would|do) you (?:prefer|want)\s+|should we\s+|please choose:?\s*)/i, "").split(/\s+or\s+/i);
  }
  if (alternatives) return alternatives.length === 2
    ? build(content, question, alternatives.map(alternativeLabel), durationSeconds) : null;
  if (/^(?:你|您)(?:选|选择|采用|使用)\s*(?:方案|选项)?\s*[A-Z]\s*[吗么]$/i.test(body)) {
    return build(content, question, ["是", "否"], durationSeconds);
  }
  const confirmation = /^(?:请问[，,\s]*)?(?:(?:你|您)?(?:是否|要不要|需不需要|能不能|可不可以|愿不愿意)|(?:你|您)?(?:还是)?(?:想|希望|需要|要|可以|方便|愿意).*[吗么]$)|^(?:do you want|would you like|shall we|should (?:I|we))\b/i;
  return confirmation.test(body) ? build(content, question, ["是", "否"], durationSeconds) : null;
}

// Deliberately limited to explicit user choices. No guessing of omitted options,
// external model requests, or truncation of option meaning.
export function detectChoicePoll(content, { durationSeconds = 300 } = {}) {
  if (typeof content !== "string" || content.length > 20000 || content.includes("[POLL]")) return null;
  if (/(?:不要|不用|无需|不需要)(?:再)?(?:发起|发送|使用)?投票|(?:do not|don't)\s+(?:use\s+)?poll/i.test(content)) return null;
  const lines = visibleLines(content);
  const question = finalQuestion(lines);
  if (question) {
    const direct = questionPoll(content, question, durationSeconds);
    const refersToSections = sectionReferences(question).length >= 2 && lines.some(line => SECTION_OPTION.test(line));
    if (!refersToSections && (direct || /还是|\bor\b/i.test(question))) return direct;
  }
  const sections = sectionGroups(lines);
  const groups = [];
  for (let i = 0; i < lines.length; i++) {
    if (!OPTION.test(lines[i])) continue;
    const start = i;
    const options = [];
    while (i < lines.length && OPTION.test(lines[i])) options.push(optionLabel(OPTION.exec(lines[i++])[1]));
    // Lettered sections own their nested numbered steps and explanations.
    if (!sections.some(section => start <= section.scopeEnd && i - 1 >= section.start)) {
      groups.push({ start, end: i - 1, options });
    }
    i--;
  }
  // Explanatory lists are context, not candidate ballots. They must not hide a
  // separate decision at the end of a diagnostic or status report.
  const choices = [...groups.map(group => ({
    ...group,
    questionIndex: [group.start - 1, group.end + 1].find(index => selectionQuestion(lines[index])),
  })), ...sections].filter(group => group.options.length >= 2 && group.questionIndex !== undefined
    && (!group.section || !inExample(lines, group.start)));
  if (choices.length > 1) return null;
  if (choices.length === 1) {
    const { start, end, options, questionIndex, section, valid } = choices[0];
    const question = selectionQuestion(lines[questionIndex]);
    if ((section && (!valid || inExample(lines, start))) || inExample(lines, questionIndex)
      || FREE_INPUT.test(lines.slice(end + 1).join("\n"))
      || WITHDRAWN.test(lines.slice(questionIndex + 1).join("\n"))) return null;
    const references = section ? sectionReferences(question) : [];
    if (references.length && (references.length < 2 || new Set(references).size !== references.length
      || references.some(index => index >= options.length))) return null;
    return build(content, question, references.length ? references.map(index => options[index]) : options, durationSeconds);
  }
  return null;
}
