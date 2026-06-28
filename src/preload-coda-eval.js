"use strict";

// 小哒 Coda 工作台 preload —— 给页面暴露「选文件夹」能力（走主进程原生对话框）。
// 页面是 file:// 载入，本身没法弹系统选目录框，所以通过 IPC 委托主进程。

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codaEvalAPI", {
  // 弹原生选文件夹对话框，支持多选，返回选中的绝对路径数组（取消返回 []）
  pickFolder: () => ipcRenderer.invoke("coda-eval:pick-folder"),
  // 选一个父目录，返回它下面一层的子目录数组（每个当一个项目）
  listSubdirs: () => ipcRenderer.invoke("coda-eval:list-subdirs"),
});
