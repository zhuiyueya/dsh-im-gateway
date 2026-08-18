/**
 * dsh-im-gateway — browser half.
 *
 * 设置面板「IM 网关」：点选渠道 → 扫码 / 填凭据 → 立即连接，无需重启。
 *  - 微信/WhatsApp：点「连接」直接弹出二维码扫描
 *  - 飞书/Telegram/QQ 等：展开表单填凭据 → 保存并连接
 *  - WebChat：一键开启，给出访问地址
 *
 * Plain JavaScript, no JSX — build elements with React.createElement.
 */

window.__ModuleLoader__.load({
  id: "dsh-im-gateway",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const { useState, useEffect, useCallback, useRef } = React;

    const inject = ["slots"];

    const API_BASE = "/dsh-im-gateway/api";
    const QR_API = (data) =>
      `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=${encodeURIComponent(data)}`;

    // ── 样式 ──────────────────────────────────────────────────────────────
    const CSS = `
.imgw-panel { font-size: 13px; line-height: 1.6; }
.imgw-head { display:flex; align-items:center; gap:10px; margin-bottom:4px; }
.imgw-head h2 { margin:0; font-size:16px; }
.imgw-sub { color:var(--dsh-text-muted, #8b949e); margin:0 0 14px; }
.imgw-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:10px; }
.imgw-card { border:1px solid var(--dsh-border, #30363d); border-radius:10px; padding:12px 14px; background:var(--dsh-bg-card, rgba(255,255,255,.02)); display:flex; flex-direction:column; gap:8px; }
.imgw-card-row { display:flex; align-items:center; gap:10px; }
.imgw-emoji { font-size:22px; }
.imgw-icon-wrap { position:relative; width:22px; height:22px; display:inline-block; flex:none; }
.imgw-icon-img { width:22px; height:22px; border-radius:5px; object-fit:contain; background:rgba(255,255,255,.85); padding:1px; }
.imgw-icon-wrap .imgw-emoji { position:absolute; inset:0; display:none; }
.imgw-name { font-weight:600; font-size:14px; }
.imgw-hint { color:var(--dsh-text-muted, #8b949e); font-size:12px; flex:1; }
.imgw-docs { font-size:11px; color:#58a6ff; text-decoration:none; }
.imgw-docs:hover { text-decoration:underline; }
.imgw-badge { font-size:11px; padding:2px 8px; border-radius:20px; white-space:nowrap; }
.imgw-badge.on { background:rgba(46,160,67,.15); color:#3fb950; }
.imgw-badge.off { background:rgba(139,148,158,.12); color:#8b949e; }
.imgw-badge.wait { background:rgba(210,153,34,.15); color:#d29922; }
.imgw-badge.err { background:rgba(248,81,73,.15); color:#f85149; }
.imgw-btn { border:0; border-radius:8px; padding:6px 14px; font-size:12px; cursor:pointer; color:#fff; background:#238636; }
.imgw-btn:hover { filter:brightness(1.1); }
.imgw-btn.danger { background:#da3633; }
.imgw-btn.ghost { background:transparent; border:1px solid var(--dsh-border, #30363d); color:var(--dsh-text, #e6edf3); }
.imgw-btn:disabled { opacity:.5; cursor:not-allowed; }
.imgw-btn.stub { background:#6e7681; cursor:not-allowed; }
.imgw-qr { text-align:center; padding:8px; }
.imgw-qr img { border-radius:8px; background:#fff; padding:6px; max-width:260px; width:100%; }
.imgw-qr-tip { color:var(--dsh-text-muted, #8b949e); font-size:12px; margin-top:6px; }
.imgw-form { display:flex; flex-direction:column; gap:8px; padding:8px 0 2px; }
.imgw-form label { font-size:12px; color:var(--dsh-text-muted, #8b949e); }
.imgw-form input { padding:7px 10px; border-radius:8px; border:1px solid var(--dsh-border, #30363d); background:var(--dsh-bg-input, #161b22); color:var(--dsh-text, #e6edf3); font-size:13px; width:100%; box-sizing:border-box; }
.imgw-form input:focus { outline:2px solid rgba(56,139,253,.4); border-color:#388bfd; }
.imgw-form-row { display:flex; justify-content:flex-end; gap:8px; margin-top:2px; }
.imgw-ok { color:#3fb950; font-size:12px; }
.imgw-loading { color:var(--dsh-text-muted, #8b949e); padding:20px 0; text-align:center; }
.imgw-error { color:#f85149; font-size:12px; }
.imgw-saved-tags { display:flex; gap:4px; flex-wrap:wrap; }
.imgw-tag { font-size:10px; padding:1px 7px; border-radius:10px; background:rgba(56,139,253,.12); color:#58a6ff; }
`;

    let styleEl = null;
    const ensureStyle = () => {
      if (styleEl && styleEl.isConnected) return;
      styleEl = document.createElement("style");
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
    };

    // ── API ───────────────────────────────────────────────────────────────
    const api = (path, opts) =>
      fetch(API_BASE + path, opts).then((r) => r.json());

    const badgeFor = (ch) => {
      if (ch.status === "已连接") return { cls: "on", text: "已连接" };
      if (ch.status === "连接中") return { cls: "wait", text: "连接中" };
      if (ch.status === "异常") return { cls: "err", text: "异常" };
      return { cls: "off", text: "未连接" };
    };

    // ── 渠道卡片 ──────────────────────────────────────────────────────────
    function ChannelCard({ ch, busy, expanded, onToggleExpand, onAction }) {
      const [draft, setDraft] = useState({});
      const badge = badgeFor(ch);
      const isBusy = busy[ch.id];
      const showForm = expanded[ch.id] && ch.kind === "credentials";
      const provisioning = ch.provisioningStatus && !["已连接", "已取消", "扫码失败", "扫码启动失败", "连接失败", "二维码已过期"].includes(ch.provisioningStatus);

      const h = React.createElement;
      const children = [];

      // 头部行：真实品牌图标（项目内 assets/icons 经本地 API 提供，无外网依赖；加载失败回退 emoji）
      const iconUrl = ch.icon ? `${API_BASE}/icon/${encodeURIComponent(ch.id)}` : null;
      children.push(
        h("div", { key: "row", className: "imgw-card-row" },
          iconUrl
            ? h("span", { className: "imgw-icon-wrap" },
                h("img", { className: "imgw-icon-img", src: iconUrl, alt: ch.label, width: 22, height: 22,
                  onError: (e) => {
                    e.target.style.display = "none";
                    const fb = e.target.parentElement && e.target.parentElement.querySelector(".imgw-emoji");
                    if (fb) fb.style.display = "inline";
                  } }),
                h("span", { className: "imgw-emoji" }, ch.emoji))
            : h("span", { className: "imgw-emoji" }, ch.emoji),
          h("span", { className: "imgw-name" }, ch.label),
          h("span", { className: `imgw-badge ${badge.cls}` }, badge.text),
        ),
      );

      // 官方文档是固定入口，不随渠道连接状态变化
      if (ch.docs) {
        children.push(
          h("div", { key: "docs", className: "imgw-card-row" },
            h("a", { className: "imgw-docs", href: ch.docs, target: "_blank", rel: "noreferrer" }, "🔗 获取凭据 / 官方文档"),
          ),
        );
      }

      if (ch.provisioningError && !provisioning) {
        children.push(h("div", { key: "provisioning-error", className: "imgw-error" }, `${ch.provisioningStatus || "扫码失败"}：${ch.provisioningError}`));
      }

      // 官方扫码创建/绑定机器人：二维码由 Host 本地生成，不依赖第三方 QR 服务
      if (provisioning) {
        children.push(
          h("div", { key: "provisioning-hint", className: "imgw-hint" }, `${ch.label}：${ch.provisioningStatus}`),
        );
        if (ch.provisioningQrDataUrl) {
          children.push(
            h("div", { key: "provisioning-qr", className: "imgw-qr" },
              h("img", { src: ch.provisioningQrDataUrl, alt: `${ch.label} 扫码二维码` }),
              h("div", { className: "imgw-qr-tip" }, ch.id === "wecom"
                ? "仅可使用企业微信 App 内的扫一扫（不能用普通微信/系统相机）；官方二维码有效期约 5 分钟"
                : "请使用对应平台手机 App 扫码并确认创建机器人"),
            ),
          );
        }
        children.push(
          h("div", { key: "provisioning-actions", className: "imgw-card-row" },
            h("button", { className: "imgw-btn ghost", disabled: isBusy, onClick: () => onAction(ch.id, "cancel-provision") }, "取消扫码"),
          ),
        );
      }

      // 已连接：断开/删除按钮
      if (ch.running) {
        children.push(
          h("div", { key: "actions", className: "imgw-card-row" },
            ch.loginUrl &&
              h("button", { key: "refresh", className: "imgw-btn ghost", disabled: isBusy, onClick: () => onAction(ch.id, "refresh") }, "刷新二维码"),
            h("button", { key: "disconnect", className: "imgw-btn ghost", disabled: isBusy, onClick: () => onAction(ch.id, "disconnect") }, "暂时断开"),
            h("button", {
              key: "remove",
              className: "imgw-btn danger",
              disabled: isBusy,
              onClick: () => {
                if (confirm(`删除 ${ch.label} 的配置？重启后将不再自动连接。`)) onAction(ch.id, "remove");
              },
            }, "删除配置"),
          ),
        );
        if (ch.loginUrl) {
          children.push(
            h("div", { key: "qr", className: "imgw-qr" },
              h("img", { src: QR_API(ch.loginUrl), alt: "微信登录二维码", title: ch.loginUrl }),
              h("div", { className: "imgw-qr-tip" }, "用手机微信扫一扫，确认登录后自动连接"),
            ),
          );
        }
        return h("div", { className: "imgw-card" }, ...children);
      }

      // 未连接：按 kind 渲染
      if (ch.kind === "stub") {
        children.push(
          h("button", { key: "btn", className: "imgw-btn stub", disabled: true }, "即将支持"),
        );
        return h("div", { className: "imgw-card" }, ...children);
      }

      if (ch.kind === "qr") {
        children.push(
          h("div", { key: "actions", className: "imgw-card-row" },
            h("button", { key: "connect", className: "imgw-btn", disabled: isBusy, onClick: () => onAction(ch.id, "connect") },
              isBusy ? "连接中…" : "连接（扫码）"),
          ),
        );
      } else if (ch.kind === "simple") {
        children.push(
          h("div", { key: "actions", className: "imgw-card-row" },
            h("button", { key: "connect", className: "imgw-btn", disabled: isBusy, onClick: () => onAction(ch.id, "connect") },
              isBusy ? "开启中…" : "一键开启"),
          ),
        );
      } else {
        // credentials：已有配置可直接重连；表单仍可覆盖凭据
        const hasSavedConfig = ch.configuredKeys.length > 0;
        children.push(
          h("div", { key: "actions", className: "imgw-card-row" },
            hasSavedConfig &&
              h("button", { key: "reconnect", className: "imgw-btn", disabled: isBusy, onClick: () => onAction(ch.id, "connect") },
                isBusy ? "连接中…" : "使用已有配置连接"),
            ch.qrProvisioning &&
              h("button", { key: "provision", className: hasSavedConfig ? "imgw-btn ghost" : "imgw-btn", disabled: isBusy || provisioning, onClick: () => onAction(ch.id, "provision") },
                provisioning ? "扫码处理中…" : hasSavedConfig ? "重新扫码接入" : "扫码接入机器人"),
            hasSavedConfig &&
              h("span", { key: "saved", className: "imgw-saved-tags" },
                ...ch.configuredKeys.map((k) => h("span", { key: k, className: "imgw-tag" }, `${k} ✓`))),
            h("button", { key: "toggle", className: "imgw-btn ghost", disabled: isBusy, onClick: () => onToggleExpand(ch.id) },
              showForm ? "收起" : hasSavedConfig ? "修改凭据" : "手动填写凭据"),
            hasSavedConfig &&
              h("button", {
                key: "remove",
                className: "imgw-btn danger",
                disabled: isBusy,
                onClick: () => {
                  if (confirm(`删除 ${ch.label} 的配置？重启后将不再自动连接。`)) onAction(ch.id, "remove");
                },
              }, "删除配置"),
          ),
        );
        if (showForm) {
          const fields = ch.fields.map((f) =>
            h("label", { key: f.key },
              f.label,
              h("input", {
                type: f.secret ? "password" : "text",
                value: draft[f.key] ?? "",
                placeholder: f.label,
                onChange: (e) => setDraft({ ...draft, [f.key]: e.target.value }),
              }),
            ),
          );
          children.push(
            h("div", { key: "form", className: "imgw-form" },
              ...fields,
              h("div", { key: "row", className: "imgw-form-row" },
                h("button", { key: "save", className: "imgw-btn", disabled: isBusy, onClick: () => onAction(ch.id, "connect", { config: draft }) },
                  isBusy ? "连接中…" : "保存并连接"),
              ),
            ),
          );
        }
      }
      return h("div", { className: "imgw-card" }, ...children);
    }

    // ── 主面板 ────────────────────────────────────────────────────────────
    function ChannelPanel() {
      const [channels, setChannels] = useState(null);
      const [pending, setPending] = useState([]);
      const [busy, setBusy] = useState({});
      const [expanded, setExpanded] = useState({});
      const [error, setError] = useState("");
      const timerRef = useRef(null);
      const busyRef = useRef({});

      const refresh = useCallback(() => {
        api("/channels")
          .then((d) => {
            if (d.ok) {
              setChannels(d.channels);
              setPending(d.pending || []);
            }
          })
          .catch(() => setError("无法连接网关 API"));
      }, []);

      useEffect(() => {
        ensureStyle();
        refresh();
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
      }, [refresh]);

      // 等待扫码/连接中/有待授权时轮询状态（2.5s）
      useEffect(() => {
        if (timerRef.current) clearInterval(timerRef.current);
        const anyWaiting = (channels || []).some((c) =>
          c.running && (c.loginUrl || c.status === "等待扫码" || c.status === "登录中") || c.provisioningStatus && !["已连接", "已取消", "扫码失败", "扫码启动失败"].includes(c.provisioningStatus) || busyRef.current[c.id],
        ) || (pending || []).length > 0;
        if (anyWaiting) {
          timerRef.current = setInterval(refresh, 2500);
        }
      }, [channels, pending, refresh]);

      const onDecide = (channelId, userId, action) => {
        busyRef.current = { ...busyRef.current, [`decide:${channelId}:${userId}`]: true };
        setBusy({ ...busyRef.current });
        api(`/channels/${channelId}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId }),
        })
          .then(() => refresh())
          .catch(() => setError("请求失败"))
          .finally(() => {
            busyRef.current = { ...busyRef.current, [`decide:${channelId}:${userId}`]: false };
            setBusy({ ...busyRef.current });
          });
      };

      const onAction = (id, action, body) => {
        busyRef.current = { ...busyRef.current, [id]: true };
        setBusy({ ...busyRef.current });
        api(`/channels/${id}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        })
          .then((d) => {
            if (!d.ok && d.error) setError(d.error);
            else setError("");
            refresh();
          })
          .catch(() => setError("请求失败"))
          .finally(() => {
            busyRef.current = { ...busyRef.current, [id]: false };
            setBusy({ ...busyRef.current });
          });
      };

      const onToggleExpand = (id) => setExpanded({ ...expanded, [id]: !expanded[id] });

      const h = React.createElement;
      let body;
      if (channels === null) {
        body = h("div", { className: "imgw-loading" }, "加载渠道列表…");
      } else {
        // 待授权横幅（跨渠道聚合）
        const pendingBlock = (pending || []).length > 0
          ? h("div", { className: "imgw-pending" },
              h("div", { className: "imgw-pending-title" }, "🔔 有用户请求访问"),
              ...pending.map((p) => {
                const meta = (channels || []).find((c) => c.id === p.channelId);
                const key = `${p.channelId}:${p.userId}`;
                const deciding = busy[`decide:${key}`];
                return h("div", { key, className: "imgw-pending-row" },
                  h("div", { className: "imgw-pending-info" },
                    `${meta ? meta.emoji + " " + meta.label : p.channelId} · ${p.username || "未知用户"}`,
                    h("div", { className: "imgw-pending-id" }, p.userId),
                  ),
                  h("button", { className: "imgw-btn small", disabled: deciding, onClick: () => onDecide(p.channelId, p.userId, "approve") },
                    deciding ? "处理中…" : "允许"),
                  h("button", { className: "imgw-btn small danger", disabled: deciding, onClick: () => onDecide(p.channelId, p.userId, "deny") }, "拒绝"),
                );
              }),
            )
          : null;
        body = h("div", null,
          pendingBlock,
          h("div", { className: "imgw-grid" },
            ...channels.map((ch) =>
              h(ChannelCard, {
                key: ch.id, ch, busy, expanded,
                onToggleExpand, onAction,
              }),
            ),
          ),
        );
      }

      return h("div", { className: "imgw-panel" },
        h("div", { className: "imgw-head" }, h("h2", null, "🐋 IM 网关"), h("span", { className: "imgw-hint" }, "把 dsh agent 接入你的聊天软件")),
        error && h("div", { className: "imgw-error" }, `⚠️ ${error}`),
        body,
      );
    }

    // ── 挂载到设置面板 ────────────────────────────────────────────────────
    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject("settings.section", () => {
        const dispose = ctx.slots.register(
          { name: "settings.section", id: "im-gateway", order: 40, label: "🐋 IM 网关" },
          ChannelPanel,
        );
        return () => dispose();
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
