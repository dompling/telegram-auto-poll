// AI-authored templates are literal data, never executable code or regex.
export function readLiteralOption(line, rule) {
  const [prefix, suffix] = rule.options.marker.split("{label}");
  if (!line.startsWith(prefix)) return null;
  const end = line.indexOf(suffix, prefix.length);
  if (end === -1) return null;
  const label = line.slice(prefix.length, end).trim();
  if (!label) return null;
  let ordinal;
  if (rule.options.labelStyle === "number") {
    if (![...label].every(char => "0123456789".includes(char))) return null;
    ordinal = Number(label) - 1;
  } else if (rule.options.labelStyle === "letter") {
    if (label.length !== 1 || !"ABCDEFGHIJKLMNOPQRSTUVWXYZ".includes(label.toUpperCase())) return null;
    ordinal = label.toUpperCase().charCodeAt(0) - 65;
  } else ordinal = rule.options.labels.indexOf(label);
  const text = line.slice(end + suffix.length).trim();
  return text ? { ordinal, text } : null;
}
