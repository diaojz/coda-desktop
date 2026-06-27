"use strict";

// 小哒 Coda · 评价工作台窗口（回车键队扩展）
// 点击桌宠菜单「打开工作台」时弹出，展示三块：人设与行业 / 公共模块 / 项目评分。
// 窗口创建逻辑仿 dashboard.js，但精简掉 settings 锚定——评价窗口只需居中显示。
// 页面本体是 coda-eval.html，内部用 fetch 调评价 Agent 的本地 HTTP 服务（默认 8848）。

const { BrowserWindow, nativeTheme } = require("electron");
const path = require("path");
const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 760;
const MIN_WIDTH = 420;
const MIN_HEIGHT = 480;
const LIGHT_BACKGROUND = "#ece7de";  // 暖米底，对齐小哒物料视觉
const DARK_BACKGROUND = "#1c1c1f";

function getBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

module.exports = function initCodaEval(ctx) {
  let evalWindow = null;
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
    if (!evalWindow || evalWindow.isDestroyed()) return;
    const metrics = getScaledMetrics();
    applyZoomToWindow(evalWindow, getTextScale());
    if (typeof evalWindow.setMinimumSize === "function") {
      evalWindow.setMinimumSize(metrics.minWidth, metrics.minHeight);
    }
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
      title: typeof ctx.t === "function" ? ctx.t("codaEvalWindowTitle") : "小哒 Coda · 工作台",
      backgroundColor: getBackgroundColor(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    };
    if (ctx.iconPath) opts.icon = ctx.iconPath;

    evalWindow = new BrowserWindow(opts);
    evalWindow.setMenuBarVisibility(false);

    // 允许把初始目录 / 端口通过 query 传给页面（auto-scan）
    const query = {};
    if (options.root) query.root = options.root;
    if (options.port) query.port = String(options.port);
    evalWindow.loadFile(path.join(__dirname, "coda-eval.html"), { query });

    let moveTextScaleTimer = null;
    evalWindow.on("move", () => {
      if (moveTextScaleTimer) clearTimeout(moveTextScaleTimer);
      moveTextScaleTimer = scheduleLater(() => {
        moveTextScaleTimer = null;
        applyTextScaleToWindow();
      }, 350);
    });
    evalWindow.webContents.once("did-finish-load", () => {
      applyZoomToWindow(evalWindow, getTextScale());
    });
    evalWindow.once("ready-to-show", () => {
      if (!evalWindow || evalWindow.isDestroyed()) return;
      evalWindow.show();
      evalWindow.focus();
    });
    evalWindow.on("closed", () => {
      evalWindow = null;
    });
    return evalWindow;
  }

  function syncThemeBackground() {
    if (!evalWindow || evalWindow.isDestroyed()) return;
    evalWindow.setBackgroundColor(getBackgroundColor());
  }
  if (nativeTheme && typeof nativeTheme.on === "function") {
    nativeTheme.on("updated", syncThemeBackground);
  }

  function showCodaEval(options = {}) {
    if (evalWindow && !evalWindow.isDestroyed()) {
      if (evalWindow.isMinimized()) evalWindow.restore();
      evalWindow.show();
      evalWindow.focus();
      return evalWindow;
    }
    return createWindow(options);
  }

  return {
    showCodaEval,
    getWindow: () => evalWindow,
    applyTextScaleToWindow,
  };
};
