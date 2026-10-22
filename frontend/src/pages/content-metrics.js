import { readMetrics, metricsNote } from "../../public/channels-metrics.mjs";
import { stripContentTags } from "./content-tags.model.js";

export function distinctDescription(content) {
  const description = String(content.description || "").trim();
  const normalize = value => String(value || "").replace(/\s+/g, "").trim();
  const descriptionWithoutTags = stripContentTags(description, content.tags);
  return normalize(descriptionWithoutTags) === normalize(content.title)
    ? ""
    : description;
}

export function ContentMetrics({ content }) {
  if (content.platform_id !== "wxchannels") return null;
  const metrics = content.interaction_metrics || readMetrics(content.metadata || content.content?.metadata);
  const counts = metrics?.counts || {};
  return View({ class: "content-interaction", style: { width: "100%", "min-width": "0" } }, [
    View({ style: { display: "grid", "grid-template-columns": "repeat(3,minmax(0,1fr))", gap: "8px", "padding-top": "10px", "border-top": "1px solid var(--dm-content-border)" } },
      [["favCount", "点赞"], ["forwardCount", "转发"], ["likeCount", "推荐"]].map(([key, label]) => View({ style: { "min-width": "0" }, attributes: { title: label === "推荐" ? "推荐（爱心），不是收藏" : label } }, [
        View({ style: { "font-size": "11px", color: "var(--dm-content-muted)" } }, [label]),
        View({ style: { "font-size": "14px", "line-height": "24px", "font-variant-numeric": "tabular-nums" } }, [Number.isSafeInteger(counts[key]) && counts[key] >= 0 ? counts[key].toLocaleString("zh-CN") : "未获取"]),
      ]))),
    View({ style: { "font-size": "10px", "line-height": "18px", color: "var(--dm-content-muted)", "overflow-wrap": "anywhere" } }, [metricsNote(metrics)]),
  ]);
}
