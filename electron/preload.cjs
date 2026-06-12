const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("harnessDesktop", {
  isDesktop: true,
  openFolder: () => ipcRenderer.invoke("harness:openFolder"),
  openFile: () => ipcRenderer.invoke("harness:openFile"),
});
