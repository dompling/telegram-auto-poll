import { parsePollText } from "./parse.mjs";
import { presetDocument, validateRuleDocument } from "./rules.mjs";
import { readLiteralOption } from "./learned-options.mjs";

export function createChoiceDetector(document = presetDocument) {
  const rules = validateRuleDocument(document);
  const patterns = Object.fromEntries(Object.entries(rules.patterns).map(([name, rule]) =>
    [name, new RegExp(rule.source, rule.flags)]));
  const { SELECTION, KNOWLEDGE, FREE_INPUT, WITHDRAWN, OPTION, LETTER_SECTION, NUMBER_SECTION } = patterns;

  function clean(text) {
    return text.replace(patterns.MARKDOWN_EMPHASIS, "").replace(patterns.MARKDOWN_HEADING, "").trim();
  }

  function visibleLines(content) {
    let fence;
    const lines = [];
    for (const raw of content.split(patterns.LINE_BREAK)) {
      const marker = patterns.CODE_FENCE.exec(raw)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        // Keep a boundary so a list cannot span a hidden example.
        lines.push("");
      } else if (fence || patterns.BLOCKQUOTE.test(raw)) lines.push("");
      else if (raw.trim()) lines.push(clean(raw.replace(patterns.INLINE_CODE, "$1")));
    }
    return lines;
  }

  function build(content, question, options, durationSeconds) {
    try {
      const parsed = parsePollText(`[POLL]\n${JSON.stringify({ question, options,
        anonymous: false, multi: patterns.MULTI_CHOICE.test(question), durationSeconds })}\n[/POLL]`);
      return { intro: content.trim(), poll: parsed.poll };
    } catch { return null; }
  }

  function optionLabel(text) {
    return clean(text).replace(patterns.OPTION_LETTER_PREFIX, "").replace(patterns.OPTION_TRAILING_PUNCTUATION, "").trim();
  }

  function isIllustration(line) {
    return patterns.ILLUSTRATION_HEADING.test(line)
      || patterns.ILLUSTRATION_STEPS.test(line)
      || patterns.ILLUSTRATION_TEMPLATE.test(line);
  }

  function inExample(lines, questionIndex) {
    if (isIllustration(lines[questionIndex])) return true;
    // A parenthetical example in a diagnostic bullet does not turn the final
    // question into a tutorial. Only nearby introductory headings establish one.
    return lines.slice(0, questionIndex)
      .filter(line => line && !OPTION.test(line) && !patterns.BULLET_PREFIX.test(line))
      .slice(-2).some(isIllustration);
  }

  function alternativeLabel(text) {
    return optionLabel(text.replace(patterns.QUESTION_TRAILING_MARK, "").replace(patterns.QUESTION_TRAILING_PARTICLE, "")
      .replace(patterns.ALTERNATIVE_LEADING_WANT, ""));
  }

  function questionInLine(line) {
    const tailIndex = Math.max(line.lastIndexOf("？"), line.lastIndexOf("?"));
    if (FREE_INPUT.test(line) || WITHDRAWN.test(line.slice(tailIndex + 1))) return undefined;
    const sentences = line.match(patterns.QUESTION_SENTENCES)?.map(text => text.trim()) ?? [];
    const tail = sentences.at(-1);
    // An alternative introduced with 还是 belongs to the immediately preceding
    // question, never to every earlier question in the paragraph.
    return patterns.ALTERNATIVE_CONTINUATION.test(tail ?? "") && sentences.length >= 2 ? sentences.at(-2) + tail : tail;
  }

  function finalQuestion(lines) {
    let index = lines.length - 1;
    let last = lines[index] ?? "";
    if (patterns.ALTERNATIVE_CONTINUATION.test(last) && patterns.QUESTION_END.test(lines[index - 1] ?? "")) {
      index--;
      last = `${lines[index]}${last}`;
    }
    if (inExample(lines, index)) return null;
    return questionInLine(last);
  }

  function selectionQuestion(line, definition) {
    if (!line || isIllustration(line)) return undefined;
    const question = questionInLine(line);
    if ((patterns.QUESTION_MARK.test(line) && !question) || KNOWLEDGE.test(question ?? line) || FREE_INPUT.test(line)) return undefined;
    if (!question && !patterns.COLON_END.test(line)
      && !(definition?.question.allowStatement || patterns.SELECTION_IMPERATIVE.test(line))) return undefined;
    const selected = definition
      ? definition.question.phrases.some(phrase => (question ?? line).toLowerCase().includes(phrase.toLowerCase()))
      : SELECTION.test(question ?? line);
    return selected ? question ?? line : undefined;
  }

  function sectionReferences(question, numeric = false) {
    if (numeric && !patterns.NUMBER_REFERENCE_INTENT.test(question)) return [];
    const pattern = numeric
      ? patterns.NUMBER_REFERENCES
      : patterns.LETTER_REFERENCES;
    const list = pattern.exec(question)?.[1];
    if (!list) return [];
    return list.replace(patterns.REFERENCE_PREFIX, "").split(patterns.REFERENCE_SEPARATOR)
      .map(label => numeric ? Number(label) - 1 : label.trim().toUpperCase().charCodeAt(0) - 65);
  }

  function sectionGroups(lines, numeric = false, parents = [], definition) {
    const query = line => selectionQuestion(line, definition);
    const groups = [];
    let group;
    for (let i = 0; i < lines.length; i++) {
      if (parents.some(parent => i >= parent.start && i <= parent.scopeEnd)) {
        if (group) group.boundary = i;
        group = undefined;
        continue;
      }
      const literal = definition && readLiteralOption(lines[i], definition);
      const match = definition ? literal : (numeric ? NUMBER_SECTION : LETTER_SECTION).exec(lines[i]);
      if (!match) {
        if (query(lines[i])) group = undefined;
        continue;
      }
      const label = definition ? "" : match[1] ?? match[2];
      const ordinal = definition ? literal.ordinal : numeric ? Number(label) - 1 : label.toUpperCase().charCodeAt(0) - 65;
      if (!group || ordinal === 0) {
        group = { start: i, end: i, options: [], valid: ordinal === 0, section: numeric ? "number" : "letter" };
        groups.push(group);
      }
      if (ordinal !== group.options.length) group.valid = false;
      group.options.push(optionLabel(definition ? literal.text : match[3]));
      group.end = i;
    }
    return groups.map((group, index) => {
      const limit = Math.min(group.boundary ?? lines.length, groups[index + 1]?.start ?? lines.length);
      const after = lines.findIndex((line, i) => i > group.end && i < limit && query(line));
      // A prompt introducing a new numbered/bullet list belongs to that list.
      const next = lines[after + 1] ?? "";
      const introducesList = after !== -1 && (OPTION.test(next) || LETTER_SECTION.test(next) || NUMBER_SECTION.test(next))
        && (patterns.COLON_END.test(lines[after]) || !(numeric ? NUMBER_SECTION : LETTER_SECTION).test(next));
      const questionIndex = query(lines[group.start - 1]) ? group.start - 1
        : after !== -1 && !introducesList ? after : undefined;
      return { ...group, questionIndex, scopeEnd: after === -1 ? limit - 1 : introducesList ? after - 1 : after };
    });
  }

  function questionPoll(content, question, durationSeconds) {
    const body = question.slice(0, -1).trim();
    if (KNOWLEDGE.test(body)) return null;
    let alternatives;
    if (body.includes("还是") && !patterns.ALTERNATIVE_LEADING_CONTINUATION.test(body)) {
      alternatives = body.replace(patterns.CHINESE_ALTERNATIVE_PREFIX, "")
        .split(patterns.CHINESE_ALTERNATIVE_SEPARATOR);
    } else if (patterns.ENGLISH_OR.test(body) && patterns.ENGLISH_ALTERNATIVE_INTENT.test(body)) {
      alternatives = body.replace(patterns.ENGLISH_ALTERNATIVE_PREFIX, "").split(patterns.ENGLISH_ALTERNATIVE_SEPARATOR);
    }
    if (alternatives) return alternatives.length === 2
      ? build(content, question, alternatives.map(alternativeLabel), durationSeconds) : null;
    if (patterns.SECTION_CONFIRMATION.test(body)) {
      return build(content, question, ["是", "否"], durationSeconds);
    }
    const confirmation = patterns.CONFIRMATION;
    return confirmation.test(body) ? build(content, question, ["是", "否"], durationSeconds) : null;
  }

  // Deliberately limited to explicit user choices. No guessing of omitted options,
  // external model requests, or truncation of option meaning.
  function detectBuiltin(content, { durationSeconds = 300 } = {}) {
    if (typeof content !== "string" || content.length > 20000 || content.includes("[POLL]")) return null;
    if (patterns.POLL_EXCLUSION.test(content)) return null;
    const lines = visibleLines(content);
    const question = finalQuestion(lines);
    if (question) {
      const direct = questionPoll(content, question, durationSeconds);
      const refersToSections = (sectionReferences(question).length >= 2 && lines.some(line => LETTER_SECTION.test(line)))
        || (sectionReferences(question, true).length >= 2 && lines.some(line => NUMBER_SECTION.test(line)));
      if (!refersToSections && (direct || patterns.ALTERNATIVE_JOINER.test(question))) return direct;
    }
    const numericParents = sectionGroups(lines, true).filter(group => group.valid && group.options.length >= 2
      && group.questionIndex !== undefined && !inExample(lines, group.start)
      && (group.questionIndex < group.start || sectionReferences(selectionQuestion(lines[group.questionIndex]), true).length >= 2
        || lines.slice(group.start + 1, group.end).some(line => LETTER_SECTION.test(line))));
    const letters = sectionGroups(lines, false, numericParents);
    const sections = [...letters, ...sectionGroups(lines, true, letters)];
    const groups = [];
    for (let i = 0; i < lines.length; i++) {
      if (!OPTION.test(lines[i])) continue;
      const start = i;
      const options = [];
      while (i < lines.length && OPTION.test(lines[i])) options.push(optionLabel(OPTION.exec(lines[i++])[1]));
      // Sections own their nested steps and explanations.
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
      const references = section ? sectionReferences(question, section === "number") : [];
      if (section && !references.length && sectionReferences(question, section !== "number").length) return null;
      if (references.length && (references.length < 2 || new Set(references).size !== references.length
        || references.some(index => index < 0 || index >= options.length))) return null;
      return build(content, question, references.length ? references.map(index => options[index]) : options, durationSeconds);
    }
    return null;
  }

  function detectLearned(content, { durationSeconds = 300 } = {}) {
    const lines = visibleLines(content);
    const matches = [];
    for (const definition of rules.learnedRules) {
      if (!definition.enabled) continue;
      const groups = sectionGroups(lines, false, [], definition).filter(group => group.questionIndex !== undefined);
      if (groups.length !== 1) continue;
      const { start, end, options, questionIndex, valid } = groups[0];
      if (!valid || options.length < 2 || inExample(lines, start) || inExample(lines, questionIndex)
        || FREE_INPUT.test(lines.slice(end + 1).join("\n"))
        || WITHDRAWN.test(lines.slice(questionIndex + 1).join("\n"))) continue;
      const question = selectionQuestion(lines[questionIndex], definition);
      const references = definition.options.labelStyle === "custom" ? []
        : sectionReferences(question, definition.options.labelStyle === "number");
      if (references.some(index => index < 0 || index >= options.length)
        || new Set(references).size !== references.length) continue;
      const parsed = build(content, question, references.length ? references.map(index => options[index]) : options, durationSeconds);
      if (parsed) matches.push(parsed);
    }
    const unique = new Map(matches.map(parsed => [JSON.stringify(parsed.poll), parsed]));
    return unique.size === 1 ? unique.values().next().value : null;
  }

  return (content, options) => {
    if (typeof content !== "string" || content.length > 20000 || content.includes("[POLL]")
      || patterns.POLL_EXCLUSION.test(content)) return null;
    return detectBuiltin(content, options) ?? detectLearned(content, options);
  };
}

export const detectChoicePoll = createChoiceDetector();
