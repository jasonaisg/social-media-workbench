const { mount, template } = await import(`../../public/channels-workbench.mjs?v=${encodeURIComponent(window.__d_config?.version || "dev")}`);
import DownloadV2Page from "./downloadv2.js";

export default function ChannelsPage(props) {
  let disposeSearch = null;
  let downloadModel = null;
  let downloadElement = null;
  return View({ class: "channels-page page" }, [
    View({
      class: "channels-workbench",
      attributes: { n: "channels-workbench" },
      onMounted(event) {
        const root = event.target.get$elm();
        // Trusted, authored template; remote titles/IDs use textContent in mount.
        root.innerHTML = template;
        disposeSearch = mount(root, {
          onDownloadStarted() {
            downloadElement?.scrollIntoView({ behavior: "smooth", block: "start" });
          },
          onTasksCreated() {
            // Reuse the very same model, store, WebSocket and actions as /download.
            return downloadModel?.methods.setStatusFilter("total");
          },
        });
      },
      onUnmounted() { disposeSearch?.(); },
    }),
    View({
      class: "channels-downloads",
      attributes: { n: "channels-downloads", "aria-label": "下载进度与任务管理" },
      onMounted(event) { downloadElement = event.target.get$elm(); },
      onUnmounted() { downloadElement = null; },
    }, [
      View({ class: "channels-downloads-heading" }, [
        View({ class: "channels-downloads-title" }, ["下载进度"]),
        View({ class: "channels-downloads-description" }, ["与「下载」页共用同一任务队列；可直接暂停、继续、重试和查看失败原因。"]),
      ]),
      DownloadV2Page({ ...props, onModel(model) { downloadModel = model; } }),
    ]),
  ]);
}
