"use strict";

// 小哒 Coda · 知识图谱窗口（回车键队扩展）
// 点击桌宠菜单「打开知识图谱」时弹出，App 内嵌窗口展示跨项目知识图谱。
// 窗口逻辑仿 coda-eval.js，但页面本体在 coda（Node）服务里（graph.html + /kg/graph），
// 所以用 loadURL 加载 http://localhost:<port>/graph.html，而不是 loadFile。
// 端口默认 8849（避开 App 自带 Python 后端 agent/，它占 8848 且无 /kg/graph）。

const { BrowserWindow, nativeTheme } = require("electron");
const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");

const DEFAULT_WIDTH = 960;   // 图谱要更大画布
const DEFAULT_HEIGHT = 720;
const MIN_WIDTH = 520;
const MIN_HEIGHT = 420;
const LIGHT_BACKGROUND = "#ece7de";  // 暖米底，对齐小哒物料视觉
const DARK_BACKGROUND = "#1c1c1f";
const DEFAULT_PORT = 8849;

function getBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

module.exports = function initKnowledgeGraph(ctx) {
  let graphWindow = null;
  const scheduleLater = typeof ctx.setTimeout === "function" ? ctx.setTimeout : setTimeout;

  function getTextScale() {
    return clampTextScale(typeof ctx.getTextScale === "function" ? ctx.getTextScale() : 1);
  }

  function getScaledMetrics() {
    const scale = getTextScale();
    return {
      defaultWidth: scaleWidth(DEFAULT_WIDTH, scale),
      defaultHeight: scaleHeight(DEFAULT_HEIGHT, scale),
      minWidth: scaleWidth(MIN_WIDTH, scale),
      minHeight: scaleHeight(MIN_HEIGHT, scale),
    };
  }

  function computeInitialBounds() {
    const petBounds = typeof ctx.getPetWindowBounds === "function"
      ? ctx.getPetWindowBounds()
      : null;
    const cx = petBounds ? petBounds.x + petBounds.width / 2 : 0;
    const cy = petBounds ? petBounds.y + petBounds.height / 2 : 0;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    const metrics = getScaledMetrics();
    const width = Math.min(metrics.defaultWidth, Math.max(metrics.minWidth, workArea.width));
    const height = Math.min(metrics.defaultHeight, Math.max(metrics.minHeight, workArea.height));
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }

  function applyTextScaleToWindow() {
    if (!graphWindow || graphWindow.isDestroyed()) return;
    const metrics = getScaledMetrics();
    applyZoomToWindow(graphWindow, getTextScale());
    if (typeof graphWindow.setMinimumSize === "function") {
      graphWindow.setMinimumSize(metrics.minWidth, metrics.minHeight);
    }
  }

  function graphUrl(options = {}) {
    const port = options.port || ctx.knowledgeGraphPort || DEFAULT_PORT;
    // graph.html 支持 ?port= 显式指定后端端口；这里把窗口端口透传，确保数据接口一致。
    return `http://localhost:${port}/graph.html?port=${port}`;
  }

  function createWindow(options = {}) {
    const bounds = computeInitialBounds();
    const metrics = getScaledMetrics();
    const opts = {
      ...bounds,
      minWidth: metrics.minWidth,
      minHeight: metrics.minHeight,
      show: false,
      frame: true,
      transparent: false,
      resizable: true,
      minimizable: true,
      maximizable: true,
      skipTaskbar: false,
      alwaysOnTop: false,
      title: typeof ctx.t === "function" ? ctx.t("knowledgeGraphWindowTitle") : "小哒 Coda · 知识图谱",
      backgroundColor: getBackgroundColor(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    };
    if (ctx.iconPath) opts.icon = ctx.iconPath;

    graphWindow = new BrowserWindow(opts);
    graphWindow.setMenuBarVisibility(false);
    graphWindow.loadURL(graphUrl(options));

    // 后端没起来时 loadURL 会失败，给个可读提示页，引导先起 coda Node 服务。
    graphWindow.webContents.on("did-fail-load", (_e, errorCode, errorDesc) => {
      if (!graphWindow || graphWindow.isDestroyed()) return;
      const port = options.port || ctx.knowledgeGraphPort || DEFAULT_PORT;
      const html = `<!doctype html><meta charset="utf-8">`
        + `<body style="font-family:-apple-system,'PingFang SC',sans-serif;background:${getBackgroundColor()};`
        + `color:#6b6258;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px">`
        + `<div style="font-size:42px;margin-bottom:14px">🕸️</div>`
        + `<div style="font-size:16px;color:#2b2723;margin-bottom:8px">连不上知识图谱后端</div>`
        + `<div style="font-size:13px;line-height:1.7">请先在本机起 coda（Node）服务（提供 /kg/graph）：<br>`
        + `<code style="background:#f0eadf;padding:2px 7px;border-radius:4px;display:inline-block;margin-top:6px">cd coda &amp;&amp; CODA_PORT=${port} node server.js</code></div>`
        + `<div style="font-size:11px;color:#9a9088;margin-top:16px">(${errorDesc} · ${errorCode})</div>`
        + `</body>`;
      graphWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    });

    let moveTextScaleTimer = null;
    graphWindow.on("move", () => {
      if (moveTextScaleTimer) clearTimeout(moveTextScaleTimer);
      moveTextScaleTimer = scheduleLater(() => {
        moveTextScaleTimer = null;
        applyTextScaleToWindow();
      }, 350);
    });
    graphWindow.webContents.once("did-finish-load", () => {
      applyZoomToWindow(graphWindow, getTextScale());
    });
    graphWindow.once("ready-to-show", () => {
      if (!graphWindow || graphWindow.isDestroyed()) return;
      graphWindow.show();
      graphWindow.focus();
    });
    graphWindow.on("closed", () => {
      graphWindow = null;
    });
    return graphWindow;
  }

  function syncThemeBackground() {
    if (!graphWindow || graphWindow.isDestroyed()) return;
    graphWindow.setBackgroundColor(getBackgroundColor());
  }
  if (nativeTheme && typeof nativeTheme.on === "function") {
    nativeTheme.on("updated", syncThemeBackground);
  }

  function showKnowledgeGraph(options = {}) {
    if (graphWindow && !graphWindow.isDestroyed()) {
      if (graphWindow.isMinimized()) graphWindow.restore();
      graphWindow.show();
      graphWindow.focus();
      return graphWindow;
    }
    return createWindow(options);
  }

  return {
    showKnowledgeGraph,
    getWindow: () => graphWindow,
    applyTextScaleToWindow,
  };
};
