// Feed Augmenter dashboard. Vanilla JS: state lives in `config`, edits mutate it
// in place, and structural changes re-render the editor.

let config = { feeds: [] };
let savedSnapshot = "";
let selectedId = null;
let serverStatus = { addresses: ["localhost"], port: location.port, feeds: {} };
let lastFocusedTemplate = null;
let preview = { raw: null, output: null, error: null };
let previewTimer = null;

const RULE_TYPES = {
  static: { label: "Static field", help: "Adds a fixed value to every row." },
  template: { label: "Template field", help: "Builds text from feed values: {field} or {field|fallback}." },
  conditional: { label: "Conditional field", help: "First matching case wins; otherwise uses the fallback." },
  override: { label: "Override source field", help: "Replaces a field from the feed (templates allowed)." },
  rename: { label: "Rename source field", help: "Moves a feed field to a new name." },
  remove: { label: "Remove source field", help: "Deletes a field from the feed output." },
};

const OPS = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  not_contains: "does not contain",
  empty: "is empty",
  not_empty: "is not empty",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function toast(message, isError) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast${isError ? " error" : ""}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2500);
}

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function slugify(value) {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function currentFeed() {
  return config.feeds.find((f) => f.id === selectedId);
}

function markChanged({ rerender = false, refreshPreview = true } = {}) {
  const dirty = JSON.stringify(config) !== savedSnapshot;
  document.getElementById("dirty").hidden = !dirty;
  document.getElementById("save").disabled = !dirty;
  renderFeedList();
  if (rerender) renderEditor();
  if (refreshPreview) schedulePreview();
}

function copy(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast(`Copied ${text}`),
    () => prompt("Copy this:", text),
  );
}

// Inputs bound directly to an object property.
function bound(obj, key, attrs = {}, after) {
  return h("input", {
    type: "text",
    value: obj[key] ?? "",
    ...attrs,
    oninput: (e) => {
      obj[key] = attrs.type === "number" ? Number(e.target.value) : e.target.value;
      after?.(e);
      markChanged();
    },
  });
}

function templateInput(obj, key, placeholder) {
  return bound(obj, key, {
    placeholder,
    class: "template",
    onfocus: (e) => (lastFocusedTemplate = { el: e.target, obj, key }),
  });
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function renderFeedList() {
  const list = document.getElementById("feed-list");
  list.replaceChildren(
    ...config.feeds.map((feed) => {
      const s = serverStatus.feeds[feed.slug];
      const state = !s ? "idle" : s.stale || (s.lastErrorAt && s.lastErrorAt === s.lastRequest) ? "bad" : "ok";
      return h(
        "li",
        { class: feed.id === selectedId ? "active" : "", onclick: () => select(feed.id) },
        h("span", { class: `dot ${state}`, title: describeStatus(s) }),
        h("div", {}, h("div", {}, feed.name || "(unnamed)"), h("div", { class: "muted small" }, `/feed/${feed.slug}`)),
      );
    }),
  );

  const info = document.getElementById("server-info");
  info.replaceChildren(
    h("div", {}, "Reachable at:"),
    ...serverStatus.addresses.map((a) => h("div", { class: "mono" }, `${a}:${serverStatus.port}`)),
  );
}

function describeStatus(s) {
  if (!s) return "No requests yet";
  let text = `${s.requests} requests. Last: ${new Date(s.lastRequest).toLocaleTimeString()}`;
  if (s.stale) text += " — serving cached data (remote failing)";
  if (s.lastError) text += `\nLast error: ${s.lastError} at ${new Date(s.lastErrorAt).toLocaleTimeString()}`;
  return text;
}

function select(id) {
  selectedId = id;
  preview = { raw: null, output: null, error: null };
  renderFeedList();
  renderEditor();
  runPreview();
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function renderEditor() {
  const main = document.getElementById("editor");
  const feed = currentFeed();
  if (!feed) {
    main.replaceChildren(h("p", { class: "muted" }, "Select or add a feed."));
    return;
  }

  main.replaceChildren(
    h(
      "section",
      {},
      h("div", { class: "section-head" }, h("h2", {}, "Source"),
        h("button", { class: "danger", onclick: () => deleteFeed(feed) }, "Delete feed")),
      h("div", { class: "grid" },
        h("label", {}, "Name", bound(feed, "name", {}, () => {
          if (feed.slugTouched || savedSlugs().has(feed.slug)) return;
          feed.slug = slugify(feed.name);
          document.getElementById("slug-input").value = feed.slug;
          refreshUrls(feed);
        })),
        h("label", {}, "Slug (URL path)", bound(feed, "slug", { id: "slug-input" }, (e) => {
          feed.slugTouched = true;
          feed.slug = e.target.value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
          if (e.target.value !== feed.slug) e.target.value = feed.slug;
          refreshUrls(feed);
        })),
        h("label", { class: "wide" }, "Source JSON URL", bound(feed, "url", { placeholder: "https://…/feed.json" })),
        h("label", {}, "Cache (seconds)", bound(feed, "cacheSeconds", { type: "number", min: 0, step: 0.5 })),
      ),
      renderUrls(feed),
    ),

    h(
      "section",
      {},
      h("h2", {}, "Output shape"),
      h("div", { class: "row" },
        h("label", { class: "inline" },
          h("input", { type: "radio", name: "output", checked: feed.output === "flat",
            onchange: () => { feed.output = "flat"; markChanged({ rerender: true }); } }),
          "Flat — added fields at top level"),
        h("label", { class: "inline" },
          h("input", { type: "radio", name: "output", checked: feed.output !== "flat",
            onchange: () => { feed.output = "nested"; markChanged({ rerender: true }); } }),
          "Nested under key"),
        feed.output !== "flat" ? bound(feed, "nestKey", { class: "short" }) : null,
      ),
    ),

    h(
      "section",
      {},
      h("div", { class: "section-head" }, h("h2", {}, "Rules"),
        h("select", { onchange: (e) => { addRule(feed, e.target.value); e.target.value = ""; } },
          h("option", { value: "" }, "+ Add rule…"),
          ...Object.entries(RULE_TYPES).map(([type, t]) => h("option", { value: type }, t.label)))),
      h("p", { class: "muted small" }, "Rules run top to bottom. Later rules can use fields created by earlier ones."),
      feed.rules.length ? null : h("p", { class: "muted" }, "No rules yet — output matches the source."),
      ...feed.rules.map((rule, i) => renderRule(feed, rule, i)),
    ),

    h("section", {}, h("h2", {}, "Available fields"),
      h("p", { class: "muted small" }, "Click to insert into the last template box you focused."),
      h("div", { id: "fields", class: "chips" })),

    h(
      "section",
      {},
      h("div", { class: "section-head" }, h("h2", {}, "Preview (first row)"),
        h("button", { onclick: () => runPreview(true) }, "Refresh from source")),
      h("div", { id: "preview-error", class: "error-text" }),
      h("div", { class: "preview" },
        h("div", {}, h("h3", {}, "Source"), h("pre", { id: "preview-raw" })),
        h("div", {}, h("h3", {}, "Output"), h("pre", { id: "preview-out" }))),
    ),
  );
  renderPreview();
}

function savedSlugs() {
  try {
    return new Set(JSON.parse(savedSnapshot).feeds.map((f) => f.slug));
  } catch {
    return new Set();
  }
}

function renderUrls(feed) {
  const saved = savedSlugs().has(feed.slug);
  const urls = serverStatus.addresses.map((a) => `http://${a}:${serverStatus.port}/feed/${feed.slug}`);
  return h("div", { class: "urls", id: "urls" },
    h("div", { class: "muted small" }, saved ? "Use in vMix (click to copy):" : "Save to activate these URLs:"),
    ...urls.map((url) => h("div", { class: "url-row" },
      h("code", { onclick: () => copy(url), title: "Copy" }, url),
      h("a", { href: url, target: "_blank" }, "open"),
      h("a", { href: `${url}/raw`, target: "_blank" }, "raw"))),
  );
}

function refreshUrls(feed) {
  document.getElementById("urls")?.replaceWith(renderUrls(feed));
}

function renderRule(feed, rule, index) {
  const meta = RULE_TYPES[rule.type] || { label: rule.type, help: "" };
  const move = (delta) => {
    const j = index + delta;
    if (j < 0 || j >= feed.rules.length) return;
    [feed.rules[index], feed.rules[j]] = [feed.rules[j], feed.rules[index]];
    markChanged({ rerender: true });
  };

  return h(
    "div",
    { class: `rule${rule.enabled === false ? " disabled" : ""}` },
    h("div", { class: "rule-head" },
      h("label", { class: "inline", title: "Enabled" },
        h("input", { type: "checkbox", checked: rule.enabled !== false,
          onchange: (e) => { rule.enabled = e.target.checked; markChanged({ rerender: true }); } }),
        h("strong", {}, meta.label)),
      h("span", { class: "muted small grow" }, meta.help),
      h("button", { class: "icon", title: "Move up", onclick: () => move(-1) }, "↑"),
      h("button", { class: "icon", title: "Move down", onclick: () => move(1) }, "↓"),
      h("button", { class: "icon danger", title: "Remove rule",
        onclick: () => { feed.rules.splice(index, 1); markChanged({ rerender: true }); } }, "✕")),
    h("div", { class: "rule-body" }, ...ruleFields(rule)),
  );
}

function ruleFields(rule) {
  const fieldInput = (label = "Field name") => h("label", {}, label, bound(rule, "field", { placeholder: "e.g. next_session_text" }));
  const tidyBox = () => h("label", { class: "inline small", title: "Collapse spaces and strip dangling · | - separators left by empty values" },
    h("input", { type: "checkbox", checked: !!rule.tidy, onchange: (e) => { rule.tidy = e.target.checked; markChanged(); } }),
    "Tidy separators");

  switch (rule.type) {
    case "static":
      return [fieldInput(), h("label", { class: "wide" }, "Value", bound(rule, "value"))];
    case "template":
      return [fieldInput(), h("label", { class: "wide" }, "Template", templateInput(rule, "template", "{next_time} GST · {track}")), tidyBox()];
    case "override":
      return [fieldInput("Source field"), h("label", { class: "wide" }, "New value (templates allowed)", templateInput(rule, "value", "{title|TBA}")), tidyBox()];
    case "rename":
      return [h("label", {}, "From", bound(rule, "from")), h("label", {}, "To", bound(rule, "to"))];
    case "remove":
      return [fieldInput("Source field")];
    case "conditional":
      rule.cases ||= [];
      return [
        fieldInput(),
        h("div", { class: "cases wide" },
          ...rule.cases.map((c, i) => h("div", { class: "case" },
            h("span", { class: "muted" }, i === 0 ? "If" : "Else if"),
            bound(c, "field", { placeholder: "field", class: "short" }),
            h("select", { onchange: (e) => { c.op = e.target.value; markChanged({ rerender: true }); } },
              ...Object.entries(OPS).map(([op, label]) => h("option", { value: op, selected: (c.op || "equals") === op }, label))),
            c.op === "empty" || c.op === "not_empty" ? h("span", { class: "short" }) : bound(c, "value", { placeholder: "value", class: "short" }),
            h("span", { class: "muted" }, "→"),
            templateInput(c, "then", "LIVE NOW"),
            h("button", { class: "icon danger", onclick: () => { rule.cases.splice(i, 1); markChanged({ rerender: true }); } }, "✕"))),
          h("div", { class: "case" },
            h("button", { onclick: () => { rule.cases.push({ field: "", op: "equals", value: "", then: "" }); markChanged({ rerender: true }); } }, "+ Case")),
          h("div", { class: "case" },
            h("span", { class: "muted" }, "Otherwise →"),
            templateInput(rule, "otherwise", "{starts_in}"))),
        tidyBox(),
      ];
    default:
      return [h("span", { class: "muted" }, "Unknown rule type")];
  }
}

function addRule(feed, type) {
  if (!type) return;
  const defaults = {
    static: { field: "", value: "" },
    template: { field: "", template: "", tidy: true },
    conditional: { field: "", cases: [{ field: "state", op: "equals", value: "live", then: "LIVE NOW" }], otherwise: "{starts_in}", tidy: true },
    override: { field: "", value: "", tidy: false },
    rename: { from: "", to: "" },
    remove: { field: "" },
  };
  feed.rules.push({ type, enabled: true, ...defaults[type] });
  markChanged({ rerender: true });
}

function addFeed() {
  const id = Date.now().toString(36);
  let n = config.feeds.length + 1;
  while (config.feeds.some((f) => f.slug === `feed${n}`)) n++;
  config.feeds.push({ id, name: `Feed ${n}`, slug: `feed${n}`, url: "", output: "flat", nestKey: "custom", cacheSeconds: 1, rules: [] });
  selectedId = id;
  markChanged({ rerender: true, refreshPreview: false });
}

function deleteFeed(feed) {
  if (!confirm(`Delete "${feed.name}"? (Takes effect when you save.)`)) return;
  config.feeds = config.feeds.filter((f) => f !== feed);
  selectedId = config.feeds[0]?.id ?? null;
  markChanged({ rerender: true });
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => runPreview(false), 350);
}

async function runPreview(fresh) {
  const feed = currentFeed();
  if (!feed) return;
  if (!feed.url) {
    preview = { raw: null, output: null, error: "Enter a source URL to preview." };
    renderPreview();
    return;
  }
  try {
    const data = await api("POST", "/api/preview", { ...feed, fresh });
    preview = { raw: data.raw, output: data.output, error: data.stale ? `Remote failing (${data.error}); showing cached data.` : null };
  } catch (error) {
    preview = { raw: null, output: null, error: error.message };
  }
  if (feed === currentFeed()) renderPreview();
}

function renderPreview() {
  const rawEl = document.getElementById("preview-raw");
  if (!rawEl) return;
  const rows = (x) => (Array.isArray(x) ? x : []);
  const fmt = (x) => {
    const r = rows(x);
    if (!r.length) return x ? "(empty array)" : "";
    return JSON.stringify(r[0], null, 2) + (r.length > 1 ? `\n\n… and ${r.length - 1} more row(s)` : "");
  };
  rawEl.textContent = fmt(preview.raw);
  document.getElementById("preview-out").textContent = fmt(preview.output);
  document.getElementById("preview-error").textContent = preview.error || "";

  // Field chips: source fields plus added fields (templates see both by bare name).
  const feed = currentFeed();
  const out = rows(preview.output)[0];
  const sample = {};
  if (out && typeof out === "object") {
    const nestKey = feed?.output !== "flat" ? feed?.nestKey : null;
    for (const [k, v] of Object.entries(out)) if (k !== nestKey) sample[k] = v;
    if (nestKey && out[nestKey] && typeof out[nestKey] === "object") Object.assign(sample, out[nestKey]);
  }
  document.getElementById("fields").replaceChildren(
    ...Object.keys(sample).map((k) => h("button", { class: "chip", title: String(sample[k] ?? ""), onclick: () => insertField(k) }, k)),
  );
}

function insertField(key) {
  const target = lastFocusedTemplate;
  if (!target || !document.body.contains(target.el)) {
    copy(`{${key}}`);
    return;
  }
  const { el, obj, key: prop } = target;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const token = `{${key}}`;
  el.value = el.value.slice(0, start) + token + el.value.slice(end);
  obj[prop] = el.value;
  el.focus();
  el.setSelectionRange(start + token.length, start + token.length);
  markChanged();
}

// ---------------------------------------------------------------------------
// Save / load
// ---------------------------------------------------------------------------

async function save() {
  try {
    const clean = { ...config, feeds: config.feeds.map(({ slugTouched, ...f }) => f) };
    config = await api("PUT", "/api/config", clean);
    savedSnapshot = JSON.stringify(config);
    if (!currentFeed()) selectedId = config.feeds[0]?.id ?? null;
    markChanged({ rerender: true, refreshPreview: false });
    toast("Saved");
  } catch (error) {
    toast(error.message, true);
  }
}

async function refreshStatus() {
  try {
    serverStatus = await api("GET", "/api/status");
    renderFeedList();
  } catch {
    /* server restarting */
  }
}

async function init() {
  config = await api("GET", "/api/config");
  savedSnapshot = JSON.stringify(config);
  await refreshStatus();
  document.getElementById("save").addEventListener("click", save);
  document.getElementById("add-feed").addEventListener("click", addFeed);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      save();
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (JSON.stringify(config) !== savedSnapshot) e.preventDefault();
  });
  setInterval(refreshStatus, 3000);
  if (config.feeds[0]) select(config.feeds[0].id);
}

init().catch((error) => toast(error.message, true));
