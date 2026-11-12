// renderer/toast-preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastAPI', {
    close: () => { ipcRenderer.send('toast:close'); },
    open: () => { ipcRenderer.send('toast:open'); },
});