"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

// ── 内置配置常量（demo 级别，通过 spawn env 传给二进制，不回传渲染进程）──
const CODA_PORT = 8848;
const CODA_OPENAI_BASE_URL = "https://api.openai-next.com/v1";
const CODA_LLM_MODEL = "gpt-5.5";
const CODA_LLM_BACKEND = "openai";
const CODA_ACCESS_TOKEN = "coda-8618e57cb9f37501";

// 真实中转站 key 从【不入库】的本地文件读取（src/coda-backend-secret.local.js，已 .gitignore）。
// 这样仓库里没有明文 key；打包时 electron-builder 会把该文件打进 App。
// 读不到（比如别人克隆了仓库但没这文件）就用占位符，后端会走兜底、不会泄露。
const CODA_OPENAI_API_KEY = _loadSecretKey();

function _loadSecretKey() {
  try {
    // eslint-disable-next-line global-require
    const secret = require("./coda-backend-secret.local.js");
    if (secret && typeof secret.OPENAI_API_KEY === "string" && secret.OPENAI_API_KEY) {
      return secret.OPENAI_API_KEY;
    }
  } catch (e) {
    // 文件不存在（开发者克隆但没拿到 key）——静默用占位符
  }
  return "sk-REPLACE_ME";
}

const HEALTH_URL = `http://127.0.0.1:${CODA_PORT}/health`;
const HEALTH_POLL_INTERVAL_MS = 500;
// 冷启动较慢：未签名二进制首次运行时 macOS 要逐个校验 _internal 里的动态库，
// 这台机器实测可达 20~40 秒。给足 60 秒，避免误判失败。
const HEALTH_TIMEOUT_MS = 60000;

const BINARY_BASENAME = "coda-agent";
const SIDECAR_RESOURCE_ROOT = path.join("sidecars", "coda-agent");

function platformName(platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  return String(platform || "").trim() || "unknown";
}

function archName(arch) {
  return String(arch || "").trim() || "unknown";
}

function binaryName(platform) {
  // Windows 不打 PyInstaller 二进制（mac 上无法交叉编译）。后端是纯标准库零依赖，
  // 故 Windows 包焊「嵌入式 Python + 源码」：sidecar 目录里放 python.exe + server.py，
  // 启动入口就是 python.exe。其它平台仍是单一二进制 coda-agent。
  if (platform === "win32") return "python.exe";
  return BINARY_BASENAME;
}

// 启动命令与参数：Windows 用 python.exe 跑同目录 server.py；其它平台直接执行二进制。
function spawnSpec(platform, resolvedPath) {
  if (platform === "win32") {
    const serverPy = path.join(path.dirname(resolvedPath), "server.py");
    return { command: resolvedPath, args: [serverPy] };
  }
  return { command: resolvedPath, args: [] };
}

/**
 * 解析二进制路径，优先级：
 *   1. 显式路径（options.binaryPath）
 *   2. 环境变量 CODA_BACKEND_PATH
 *   3. 打包版 process.resourcesPath/sidecars/coda-agent/<platform>-<arch>/coda-agent
 *   4. 开发版 ./bin/coda-agent/<platform>-<arch>/coda-agent
 */
function resolveBinary(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const isPackaged = options.isPackaged !== undefined ? options.isPackaged : (process.type === "browser" ? require("electron").app.isPackaged : false);

  if (options.binaryPath) {
    return { path: options.binaryPath, source: "explicit" };
  }

  if (process.env.CODA_BACKEND_PATH) {
    return { path: process.env.CODA_BACKEND_PATH, source: "env" };
  }

  const platDir = `${platformName(platform)}-${archName(arch)}`;
  const bin = binaryName(platform);

  if (isPackaged) {
    const resourcesPath = options.resourcesPath || process.resourcesPath;
    return {
      path: path.join(resourcesPath, SIDECAR_RESOURCE_ROOT, platDir, bin),
      source: "packaged",
    };
  }

  return {
    path: path.join(__dirname, "..", "bin", "coda-agent", platDir, bin),
    source: "dev",
  };
}

/**
 * 轮询 /health 直到返回 200 或超时
 * 超时时 reject（调用方应 catch，不要让 App crash）
 */
function waitForHealth(timeoutMs, pollIntervalMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;

    function poll() {
      if (settled) return;
      if (Date.now() > deadline) {
        settled = true;
        reject(new Error(`coda-backend health check timed out after ${timeoutMs}ms`));
        return;
      }
      const req = http.get(HEALTH_URL, (res) => {
        if (!settled && res.statusCode === 200) {
          settled = true;
          resolve();
        } else if (!settled) {
          setTimeout(poll, pollIntervalMs);
        }
        // drain response body，防止 socket hang
        res.resume();
      });
      req.on("error", () => {
        if (!settled) setTimeout(poll, pollIntervalMs);
      });
      req.setTimeout(pollIntervalMs, () => {
        req.destroy();
        if (!settled) setTimeout(poll, pollIntervalMs);
      });
    }

    poll();
  });
}

class CodaBackendSidecar {
  constructor(options = {}) {
    this.log = typeof options.log === "function" ? options.log : (level, msg, data) => {
      const prefix = `[coda-backend] [${level}]`;
      if (data) console.log(prefix, msg, data);
      else console.log(prefix, msg);
    };
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.isPackaged = options.isPackaged;
    this.resourcesPath = options.resourcesPath;
    this.binaryPath = options.binaryPath;

    const resolved = resolveBinary({
      binaryPath: this.binaryPath,
      platform: this.platform,
      arch: this.arch,
      isPackaged: this.isPackaged,
      resourcesPath: this.resourcesPath,
    });
    this._resolvedBinaryPath = resolved.path;
    this._resolvedSource = resolved.source;
    this._child = null;
    this._started = false;
  }

  /**
   * 启动 coda-agent 子进程，并等待 /health 就绪
   * 若二进制不存在只 log 警告，不 throw（桌宠没后端也能开）
   * 若 health 超时只 log 警告，不 crash
   */
  async start() {
    if (this._started) return;

    // 二进制存在性检查
    if (!this._resolvedBinaryPath || !fs.existsSync(this._resolvedBinaryPath)) {
      this.log("warn", "coda-agent binary not found, skipping sidecar start", {
        path: this._resolvedBinaryPath,
        source: this._resolvedSource,
      });
      return;
    }

    this._started = true;
    this.log("info", "starting coda-agent sidecar", {
      path: this._resolvedBinaryPath,
      source: this._resolvedSource,
      port: CODA_PORT,
    });

    try {
      // 端口走 env PORT，不传 argv。Windows 下 command=python.exe、args=[server.py]；
      // 其它平台 command=二进制、args=[]。
      const spec = spawnSpec(this.platform, this._resolvedBinaryPath);
      this._child = childProcess.spawn(
        spec.command,
        spec.args,
        {
          env: this._buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }
      );
    } catch (err) {
      this._started = false;
      this.log("warn", "coda-agent spawn failed", { error: err && err.message });
      return;
    }

    const child = this._child;

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        const text = String(chunk || "").trim();
        if (text) this.log("debug", "coda-agent stdout", { text });
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        const text = String(chunk || "").trim();
        if (text) this.log("debug", "coda-agent stderr", { text });
      });
    }
    child.on("error", (err) => {
      this.log("warn", "coda-agent process error", { error: err && err.message });
    });
    child.on("exit", (code, signal) => {
      if (this._child === child) this._child = null;
      this.log("info", "coda-agent exited", { code, signal });
    });

    // 等待 /health 200 才算就绪；超时只 log，不 crash
    try {
      await waitForHealth(HEALTH_TIMEOUT_MS, HEALTH_POLL_INTERVAL_MS);
      this.log("info", "coda-agent is healthy and ready", { port: CODA_PORT });
    } catch (err) {
      this.log("warn", "coda-agent health check failed (sidecar may still start later)", {
        error: err && err.message,
      });
    }
  }

  /**
   * 停止子进程（App 退出时调用）
   */
  stop() {
    const child = this._child;
    this._child = null;
    this._started = false;
    if (!child || child.killed) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // 忽略进程退出竞态
    }
    this.log("info", "coda-agent sidecar stopped");
  }

  /**
   * 组装传给子进程的 env：
   * 仅透传必要系统变量 + 注入后端所需密钥
   * 绝不把这些 key 回传渲染进程
   */
  _buildEnv() {
    const base = process.env;
    const posixAllowlist = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TMPDIR"];
    const winAllowlist = [
      "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
      "TEMP", "TMP", "PATH", "PATHEXT", "COMSPEC",
    ];
    const allowlist = this.platform === "win32" ? winAllowlist : posixAllowlist;
    const env = {};
    for (const key of allowlist) {
      if (base[key] != null && base[key] !== "") env[key] = String(base[key]);
    }
    // 注入后端配置
    env.PORT = String(CODA_PORT);
    env.OPENAI_BASE_URL = CODA_OPENAI_BASE_URL;
    env.OPENAI_API_KEY = CODA_OPENAI_API_KEY;
    env.CODA_LLM_MODEL = CODA_LLM_MODEL;
    env.CODA_LLM_BACKEND = CODA_LLM_BACKEND;
    env.CODA_ACCESS_TOKEN = CODA_ACCESS_TOKEN;
    return env;
  }
}

function createCodaBackendSidecar(options = {}) {
  return new CodaBackendSidecar(options);
}

module.exports = {
  CodaBackendSidecar,
  createCodaBackendSidecar,
  resolveBinary,
};
