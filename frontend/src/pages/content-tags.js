import { Tag } from "../dmui.js";

export function ContentTopicTags(props = {}) {
  const tags = Array.isArray(props.tags) ? props.tags : [];
  if (tags.length === 0) return null;
  const name = props.name || "content-topic-tags";
  return View(
    {
      class: ["content-topic-tags", props.class || ""].filter(Boolean).join(" "),
      attributes: { n: name, "aria-label": "内容标签" },
    },
    tags.map((tag) =>
      Tag(
        {
          name: "content-topic-tag",
          class: "content-topic-tag",
          attributes: { title: `#${tag}` },
        },
        [`#${tag}`],
      ),
    ),
  );
}
