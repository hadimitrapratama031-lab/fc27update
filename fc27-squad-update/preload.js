'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Hanya fungsi sempit yang diekspos ke renderer. Renderer tidak pernah
// mendapat akses filesystem, Node.js, atau ipcRenderer secara langsung.
contextBridge.exposeInMainWorld('fc27', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  checkDestination: () => ipcRenderer.invoke('dest:check'),
  openDestination: () => ipcRenderer.invoke('dest:open'),
  chooseFile: () => ipcRenderer.invoke('file:choose'),
  setFileFromDrop: (file) => {
    const filePath = webUtils.getPathForFile(file);
    return ipcRenderer.invoke('file:set', filePath);
  },
  fetchUpdate: () => ipcRenderer.invoke('update:fetch'),
  installUpdate: () => ipcRenderer.invoke('install:remote'),
  install: () => ipcRenderer.invoke('install:start'),
  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('install:progress', handler);
    return () => ipcRenderer.removeListener('install:progress', handler);
  },
});
