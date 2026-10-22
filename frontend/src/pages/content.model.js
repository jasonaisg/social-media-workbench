import { proxy_image_url } from "@/image-proxy.model.js";
import { task_status } from "./content_detail.model.js";
import { normalizeContentTags } from "./content-tags.model.js";

function number_or_default(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function first_non_empty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return "";
}

function normalize_filter_account(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const platform_id = first_non_empty(
    source.platform_id,
    source.platformId,
    source.PlatformID,
  );
  return {
    id: first_non_empty(source.id, source.ID),
    platform_id,
    external_id: first_non_empty(
      source.external_id,
      source.externalId,
      source.ExternalID,
    ),
    nickname: first_non_empty(
      source.nickname,
      source.Nickname,
      source.alias,
      source.Alias,
      source.external_id,
      source.ExternalID,
      source.id,
      source.ID,
      "未命名账号",
    ),
    avatar_url: proxy_image_url(
      platform_id,
      first_non_empty(source.avatar_url, source.avatarUrl, source.AvatarURL),
    ),
  };
}

function select_item(label, value, data = {}) {
  const item = new Timeless.vm.SelectItemCore({ label, value });
  Object.assign(item, data);
  return item;
}

function select_search(placeholder) {
  return new Timeless.vm.InputCore({
    defaultValue: "",
    placeholder,
    allowClear: true,
    autocomplete: false,
  });
}

function content_detail_href(content) {
  const id = String(first_non_empty(content && content.id, content && content.ID)).trim();
  return id ? `/content/detail?id=${encodeURIComponent(id)}` : "";
}

function content_identifier(content) {
  return String(first_non_empty(content && content.id, content && content.ID)).trim();
}

function normalize_content_list_response(data, fallbackPage, fallbackSize) {
  const source = data && typeof data === "object" ? data : {};
  const list = Array.isArray(source.list)
    ? source.list
    : Array.isArray(source.List)
      ? source.List
      : [];
  return {
    list,
    total: Math.max(
      0,
      number_or_default(
        typeof source.total !== "undefined" ? source.total : source.Total,
        list.length,
      ),
    ),
    page: Math.max(
      1,
      number_or_default(source.page || source.Page, fallbackPage),
    ),
    page_size: Math.max(
      1,
      number_or_default(
        source.page_size || source.pageSize || source.PageSize,
        fallbackSize,
      ),
    ),
  };
}

function normalize_content_account(raw, fallback_platform_id) {
  const source = raw && typeof raw === "object" ? raw : {};
  const platform_id = first_non_empty(
    source.platform_id,
    source.PlatformID,
    fallback_platform_id,
  );
  return {
    id: first_non_empty(source.id, source.ID),
    external_id: first_non_empty(source.external_id, source.ExternalID),
    alias: first_non_empty(source.alias, source.Alias),
    nickname: first_non_empty(
      source.nickname,
      source.Nickname,
      source.name,
      source.Name,
    ),
    avatar_url: proxy_image_url(
      platform_id,
      first_non_empty(source.avatar_url, source.AvatarURL),
    ),
    profile_url: first_non_empty(source.profile_url, source.ProfileURL),
  };
}

function normalize_content_item(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const platform_id = first_non_empty(source.platform_id, source.PlatformID);
  const accounts_source = Array.isArray(source.accounts)
    ? source.accounts
    : Array.isArray(source.Accounts)
      ? source.Accounts
      : [];
  const tasks = Array.isArray(source.download_tasks)
    ? source.download_tasks
    : Array.isArray(source.DownloadTasks)
      ? source.DownloadTasks
      : [];
  const file_count = Math.max(
    0,
    number_or_default(
      first_non_empty(source.file_count, source.fileCount, source.FileCount),
      0,
    ),
  );

  return {
    ...source,
    id: first_non_empty(source.id, source.ID),
    platform_id,
    platform_name: first_non_empty(source.platform_name, source.PlatformName),
    content_type: first_non_empty(
      source.content_type,
      source.ContentType,
      source.type,
      source.Type,
    ),
    content_subtype: first_non_empty(
      source.content_subtype,
      source.ContentSubtype,
      source.subtype,
      source.Subtype,
    ),
    title: first_non_empty(
      source.title,
      source.Title,
      source.description,
      source.Description,
    ),
    description: first_non_empty(source.description, source.Description),
    tags: normalizeContentTags(first_non_empty(source.tags, source.Tags, [])),
    url: first_non_empty(
      source.source_url,
      source.SourceURL,
      source.url,
      source.URL,
      source.content_url,
      source.ContentURL,
    ),
    cover_url: proxy_image_url(
      platform_id,
      first_non_empty(source.cover_url, source.CoverURL, source.coverUrl),
    ),
    publish_time: number_or_default(
      first_non_empty(source.publish_time, source.PublishTime),
      0,
    ),
    accounts: accounts_source.map((account) =>
      normalize_content_account(account, platform_id),
    ),
    download_tasks: tasks,
    file_count,
  };
}

function content_platform_name(content) {
  if (content.platform_name) {
    return content.platform_name;
  }
  return (
    window.PLATFORM_NAMES[content.platform_id] ||
    content.platform_id ||
    "未知平台"
  );
}

function content_type_label(value, subtypeValue) {
  const type = String(value || "")
    .trim()
    .toLowerCase();
  const subtype = String(subtypeValue || "")
    .trim()
    .toLowerCase();
  return (
    window.CONTENT_TYPE_NAMES[subtype] ||
    window.CONTENT_TYPE_NAMES[type] ||
    subtype ||
    type ||
    "内容"
  );
}

function content_statistics(content) {
  const source = content && typeof content === "object" ? content : {};
  const tasks = Array.isArray(source.download_tasks)
    ? source.download_tasks
    : [];
  const task_statuses = new Map();
  tasks.forEach((task) => {
    const status = task_status(task.status);
    const statistic = task_statuses.get(status.tone);
    if (statistic) {
      statistic.value += 1;
    } else {
      task_statuses.set(status.tone, {
        key: status.tone,
        label: `${status.label}任务`,
        value: 1,
      });
    }
  });
  return {
    task_statuses: Array.from(task_statuses.values()),
    files: Math.max(0, number_or_default(source.file_count, 0)),
  };
}

function ContentViewModel(props) {
  const PAGE_SIZE_DEFAULT = 50;
  const contents_ = refarr([]);
  const total_ = ref(0);
  const page_ = ref(1);
  const page_size_ = ref(PAGE_SIZE_DEFAULT);
  const keyword_ = ref("");
  const content_type_ = ref("");
  const platform_id_ = ref("");
  const account_id_ = ref("");
  const scope_ = ref("downloaded");
  const initial_ = ref(true);
  const loading_ = ref(false);
  const error_ = ref("");
  const detail_id_ = ref("");
  const copied_content_id_ = ref("");
  const selected_content_ids_ = refarr([]);
  const deleting_contents_ = ref(false);
  let request_sequence = 0;
  let account_request_sequence = 0;
  let copy_feedback_timer = null;
  let refresh_timer = null;
  let started = false;

  const selected_content_count_ = computed(
    selected_content_ids_,
    (ids) => (ids || []).length,
  );
  const loaded_content_selection_ = combine(
    { contents: contents_, selected_ids: selected_content_ids_ },
    (state) => {
      const ids = (state.contents || [])
        .filter((content) => Number(content.file_count) > 0)
        .map(content_identifier)
        .filter(Boolean);
      const selected = ids.filter((id) =>
        (state.selected_ids || []).includes(id),
      ).length;
      return {
        total: ids.length,
        selected,
        checked: ids.length > 0 && selected === ids.length,
        indeterminate: selected > 0 && selected < ids.length,
      };
    },
  );

  const ui = {
    input_keyword$: new Timeless.vm.InputCore({
      defaultValue: keyword_.value,
      placeholder: "搜索标题或描述",
      type: "search",
      allowClear: true,
      onChange(value) {
        set_keyword(value);
      },
      onEnter() {
        return methods.search();
      },
    }),
    checkbox_all$: new Timeless.vm.CheckboxCore({
      checked: scope_.value === "all",
      onChange(value) {
        set_all_scope(value);
      },
    }),
    select_platform$: new Timeless.vm.SelectCore({
      defaultValue: "",
      placeholder: "全部平台",
      search: select_search("搜索平台"),
      position: "popper",
      options: [
        ["", "全部平台"],
        ...Object.entries(window.PLATFORM_NAMES || {}),
      ].map(([value, label]) => select_item(label, value)),
      onChange(value) {
        account_id_.as("");
        ui.select_account$.setValue("", { silence: true });
        platform_id_.as(String(value || ""));
        void load_accounts();
        return load(1);
      },
    }),
    select_account$: new Timeless.vm.SelectCore({
      defaultValue: "",
      placeholder: "全部账号",
      search: select_search("搜索账号"),
      position: "popper",
      options: [select_item("全部账号", "")],
      onChange(value) {
        account_id_.as(String(value || ""));
        return load(1);
      },
    }),
    select_content_type$: new Timeless.vm.SelectCore({
      defaultValue: "",
      placeholder: "全部类型",
      position: "item-aligned",
      options: [
        new Timeless.vm.SelectItemCore({ label: "全部类型", value: "" }),
        new Timeless.vm.SelectItemCore({ label: "视频", value: "video" }),
        new Timeless.vm.SelectItemCore({
          label: "短视频",
          value: "short_video",
        }),
        new Timeless.vm.SelectItemCore({ label: "图集", value: "image_set" }),
        new Timeless.vm.SelectItemCore({ label: "文章", value: "article" }),
        new Timeless.vm.SelectItemCore({ label: "小说", value: "novel" }),
        new Timeless.vm.SelectItemCore({ label: "音频", value: "audio" }),
        new Timeless.vm.SelectItemCore({ label: "直播", value: "live" }),
      ],
      onChange(value) {
        content_type_.as(String(value || ""));
        load(1);
      },
    }),
    btn_search$: new Timeless.vm.ButtonCore({
      disabled: loading_.value,
      variant: "primary",
    }),
    btn_refresh$: new Timeless.vm.ButtonCore({
      disabled: loading_.value,
      variant: "outline",
      onClick() {
        reset_filters();
        void load_accounts();
        return load(1);
      },
    }),
    btn_retry$: new Timeless.vm.ButtonCore({
      disabled: loading_.value,
      variant: "primary",
      onClick() {
        return load(page_.value);
      },
    }),
    btn_delete_selected$: new Timeless.vm.ButtonCore({
      disabled: false,
      variant: "danger",
      onClick() {
        return methods.requestDeleteSelected();
      },
    }),
    contentDetailDrawer$: new Timeless.vm.DialogCore({
      title: "内容详情",
      closeable: true,
      footer: false,
    }),
    deleteContentsDialog$: new Timeless.vm.DialogCore({
      closeable: true,
      onOk() {
        return methods.confirmDeleteSelected();
      },
    }),
  };

  keyword_.subscribe({
    onChange(value) {
      if (ui.input_keyword$.value !== value) {
        ui.input_keyword$.setValue(value, { silence: true });
      }
    },
  });
  scope_.subscribe({
    onChange(value) {
      const checked = value === "all";
      if (ui.checkbox_all$.checked !== checked) {
        ui.checkbox_all$.setValue(checked, { silence: true });
      }
    },
  });
  loading_.subscribe({
    onChange(loading) {
      [ui.btn_search$, ui.btn_refresh$, ui.btn_retry$].forEach((button) => {
        if (loading) {
          button.disable();
        } else {
          button.enable();
        }
      });
    },
  });
  deleting_contents_.subscribe({
    onChange(deleting) {
      if (deleting) {
        ui.btn_delete_selected$.disable();
      } else {
        ui.btn_delete_selected$.enable();
      }
    },
  });

  const list_request = new Timeless.kit.RequestCore(
    (params) => window.request.get("/api/content/list", params),
    {
      client: props.client,
      process(response) {
        if (response.error) {
          return Timeless.Result.Err(response.error);
        }
        return Timeless.Result.Ok(
          normalize_content_list_response(
            response.data,
            page_.value,
            page_size_.value,
          ),
        );
      },
    },
  );
  const account_list_request = new Timeless.kit.RequestCore(
    (params) => window.request.get("/api/account/list", params),
    { client: props.client },
  );
  const delete_downloads_request = new Timeless.kit.RequestCore(
    (body) => window.request.post("/api/content/delete_downloads", body),
    { client: props.client },
  );

  const page_count_ = combine(
    { total: total_, pageSize: page_size_ },
    (state) =>
      Math.max(1, Math.ceil(state.total / Math.max(1, state.pageSize))),
  );
  const range_text_ = combine(
    {
      total: total_,
      page: page_,
      pageSize: page_size_,
      count: computed(contents_, (contents) => contents.length),
    },
    (state) => {
      if (!state.total || !state.count) {
        return `共 ${state.total || 0} 条`;
      }
      const start = (state.page - 1) * state.pageSize + 1;
      return `第 ${start}-${start + state.count - 1} 条，共 ${state.total} 条`;
    },
  );
  const list_status_ = combine(
    {
      initial: initial_,
      error: error_,
      contents: contents_,
    },
    (state) => {
      if (state.initial) return "initial";
      if (state.error) return "error";
      return state.contents.length > 0 ? "normal" : "empty";
    },
  );

  async function load(targetPage = page_.value, options = {}) {
    const sequence = ++request_sequence;
    const requestedPage = Math.max(1, Number(targetPage) || 1);
    const silent = Boolean(options.silent);
    if (!silent) loading_.as(true);

    const params = {
      page: requestedPage,
      page_size: page_size_.value,
      scope: scope_.value,
    };
    const keyword = String(keyword_.value || "").trim();
    const contentType = String(content_type_.value || "").trim();
    const platform_id = String(platform_id_.value || "").trim();
    const account_id = String(account_id_.value || "").trim();
    if (keyword) {
      params.keyword = keyword;
    }
    if (contentType) {
      params.content_type = contentType;
    }
    if (platform_id) {
      params.platform_id = platform_id;
    }
    if (account_id) {
      params.account_id = account_id;
    }

    const result = await list_request.run(params);
    if (sequence !== request_sequence) {
      return result;
    }
    if (result.error) {
      if (silent) return result;
      error_.as(result.error.message || String(result.error));
      loading_.as(false);
      initial_.as(false);
      return result;
    }

    const data = result.data;
    error_.as("");
    contents_.as(data.list.map(normalize_content_item), { reset: true });
    const visible_ids = new Set(contents_.value.map(content_identifier));
    selected_content_ids_.as(
      (selected_content_ids_.value || []).filter((id) => visible_ids.has(id)),
    );
    total_.as(data.total);
    page_.as(data.page);
    page_size_.as(data.page_size);
    if (!silent) loading_.as(false);
    initial_.as(false);
    return result;
  }

  async function load_accounts() {
    const sequence = ++account_request_sequence;
    const selected_account_id = String(account_id_.value || "");
    const params = { page: 1, page_size: 200 };
    const platform_id = String(platform_id_.value || "").trim();
    if (platform_id) {
      params.platform_id = platform_id;
    }

    ui.select_account$.setLoading(true);
    const result = await account_list_request.run(params);
    if (sequence !== account_request_sequence) return result;

    const source = result.error ? {} : result.data || {};
    const list = Array.isArray(source.list)
      ? source.list
      : Array.isArray(source.List)
        ? source.List
        : [];
    const accounts = list.map(normalize_filter_account);
    const options = [
      select_item("全部账号", ""),
      ...accounts
        .filter((account) => account.id)
        .map((account) =>
          select_item(account.nickname, account.id, {
            account,
            search_text: [
              account.nickname,
              account.external_id,
              account.id,
            ].join(" "),
          }),
        ),
    ];
    const next_account_id = accounts.some(
      (account) => account.id === selected_account_id,
    )
      ? selected_account_id
      : "";
    account_id_.as(next_account_id);
    ui.select_account$.setOptions(options);
    ui.select_account$.setValue(next_account_id, { silence: true });
    ui.select_account$.setLoading(false);
    return result;
  }

  function set_keyword(value) {
    keyword_.as(String(value || ""));
  }

  function reset_filters() {
    set_keyword("");
    content_type_.as("");
    platform_id_.as("");
    account_id_.as("");
    ui.input_keyword$.setValue("", { silence: true });
    ui.select_content_type$.setValue("", { silence: true });
    ui.select_platform$.setValue("", { silence: true });
    ui.select_account$.setValue("", { silence: true });
  }

  function set_all_scope(value) {
    scope_.as(value ? "all" : "downloaded");
    selected_content_ids_.as([]);
    return load(1);
  }

  function set_loaded_contents_selected(selected) {
    const selectable_ids = (contents_.value || [])
      .filter((content) => Number(content.file_count) > 0)
      .map(content_identifier)
      .filter(Boolean);
    selected_content_ids_.as(selected ? selectable_ids : []);
  }

  function toggle_content_selected(content) {
    const id = content_identifier(content);
    if (!id || Number(content && content.file_count) <= 0) return;
    const ids = [...(selected_content_ids_.value || [])];
    selected_content_ids_.as(
      ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id],
    );
  }

  function content_selection_state(content) {
    const id = content_identifier(content);
    return computed(selected_content_ids_, (ids) => ({
      checked: Boolean(id) && (ids || []).includes(id),
      indeterminate: false,
    }));
  }

  function request_delete_selected() {
    if (!(selected_content_ids_.value || []).length) {
      DLUtils.warning({ msg: "请选择要删除的本地内容" });
      return;
    }
    ui.deleteContentsDialog$.show();
  }

  async function confirm_delete_selected() {
    if (deleting_contents_.value) return;
    const content_ids = [...(selected_content_ids_.value || [])];
    if (!content_ids.length) {
      ui.deleteContentsDialog$.hide();
      return;
    }
    deleting_contents_.as(true);
    try {
      const result = await delete_downloads_request.run({ content_ids });
      if (result.error) {
        DLUtils.error({
          msg: result.error.message || String(result.error),
        });
        return result;
      }
      const response = result.data || {};
      const failures = (response.results || []).filter((item) => !item.success);
      if (failures.length) {
        selected_content_ids_.as(failures.map((item) => item.content_id));
        DLUtils.error({
          msg: failures[0].error || `有 ${failures.length} 条内容删除失败`,
        });
      } else {
        selected_content_ids_.as([]);
        ui.deleteContentsDialog$.hide();
        DLUtils.toast(`已删除 ${Number(response.deleted) || content_ids.length} 条本地内容`);
      }
      await load(page_.value);
      if ((contents_.value || []).length === 0 && page_.value > 1) {
        await load(page_.value - 1);
      }
      return result;
    } catch (error) {
      DLUtils.error({
        msg: (error && error.message) || "删除本地内容失败",
      });
      return null;
    } finally {
      deleting_contents_.as(false);
    }
  }

  function start_live_refresh() {
    if (refresh_timer) return;
    refresh_timer = window.setInterval(() => {
      if (
        document.visibilityState !== "hidden" &&
        !loading_.value &&
        !deleting_contents_.value
      ) {
        void load(page_.value, { silent: true });
      }
    }, 5000);
  }

  function handle_visibility_change() {
    if (document.visibilityState !== "hidden" && !loading_.value) {
      void load(page_.value, { silent: true });
    }
  }

  function change_page(target_page) {
    const page = Math.min(
      page_count_.value,
      Math.max(1, Number(target_page) || 1),
    );
    if (page === page_.value || loading_.value) return null;
    return load(page);
  }

  const methods = {
    ready() {
      if (started) return load(page_.value, { silent: true });
      started = true;
      start_live_refresh();
      document.addEventListener("visibilitychange", handle_visibility_change);
      return Promise.all([load_accounts(), load(1)]);
    },
    clean() {
      if (refresh_timer) window.clearInterval(refresh_timer);
      refresh_timer = null;
      document.removeEventListener("visibilitychange", handle_visibility_change);
      clearTimeout(copy_feedback_timer);
    },
    refresh() {
      return load(1);
    },
    search() {
      return load(1);
    },
    setKeyword: set_keyword,
    changePage: change_page,
    previousPage() {
      return change_page(page_.value - 1);
    },
    nextPage() {
      return change_page(page_.value + 1);
    },
    setLoadedContentsSelected: set_loaded_contents_selected,
    toggleLoadedContentsSelected() {
      set_loaded_contents_selected(!loaded_content_selection_.value.checked);
    },
    contentSelectionState: content_selection_state,
    toggleContentSelected: toggle_content_selected,
    requestDeleteSelected: request_delete_selected,
    confirmDeleteSelected: confirm_delete_selected,
    copyId(content) {
      const result = props.app.copy(content.id);
      copied_content_id_.as(content.id);
      clearTimeout(copy_feedback_timer);
      copy_feedback_timer = setTimeout(() => copied_content_id_.as(""), 3000);
      return result;
    },
    openSource(content) {
      if (!content || !content.url) {
        return;
      }
      props.app.openWindow(content.url);
    },
    openDetail(content) {
      const id = String(
        first_non_empty(content && content.id, content && content.ID),
      ).trim();
      if (!id) return;
      detail_id_.as(id);
      ui.contentDetailDrawer$.show();
    },
    detailHref: content_detail_href,
    platformName: content_platform_name,
    typeLabel: content_type_label,
    statistics: content_statistics,
    formatTime: window.format_time,
  };

  const state = {
    contents: contents_,
    total: total_,
    page: page_,
    page_size: page_size_,
    page_count: page_count_,
    range_text: range_text_,
    scope: scope_,
    platform_id: platform_id_,
    account_id: account_id_,
    initial: initial_,
    status: list_status_,
    loading: loading_,
    error: error_,
    detail_id: detail_id_,
    copied_content_id: copied_content_id_,
    selected_content_ids: selected_content_ids_,
    selected_content_count: selected_content_count_,
    loaded_content_selection: loaded_content_selection_,
    deleting_contents: deleting_contents_,
  };

  return { state, ui, methods };
}

export { ContentViewModel, content_type_label, normalize_content_item, normalize_content_list_response };
