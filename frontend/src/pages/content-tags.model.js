export function normalizeContentTags(value) {
  let source = value;
  if (typeof source === "string") {
    const encoded = source.trim();
    if (!encoded) return [];
    try {
      source = JSON.parse(encoded);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];

  const tags = [];
  const seen = new Set();
  for (const value of source) {
    const tag = String(value ?? "").trim().replace(/^#+/, "");
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export function stripContentTags(value, tagsValue) {
  let text = String(value || "");
  const tags = normalizeContentTags(tagsValue).sort(
    (left, right) => right.length - left.length,
  );
  for (const tag of tags) {
    text = text.split(`#${tag}`).join(" ");
  }
  return text.replace(/\s+/g, " ").trim();
}
