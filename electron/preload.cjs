const { contextBridge, ipcRenderer } = require("electron");

const browserPreloadUrl = ipcRenderer.sendSync("h:getBrowserPreloadUrl");

contextBridge.exposeInMainWorld("hDesktop", {
  isDesktop: true,
  browserPreloadUrl,
  openFolder: () => ipcRenderer.invoke("h:openFolder"),
  openFile: () => ipcRenderer.invoke("h:openFile"),
  onBrowserOpenUrl: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, url) => callback(url);
    ipcRenderer.on("h:browserOpenUrl", listener);
    return () => ipcRenderer.removeListener("h:browserOpenUrl", listener);
  },
  setSitePermissions: (origin, permissions) =>
    ipcRenderer.invoke("h:setSitePermissions", { origin, permissions }),
  openResourceMonitor: () => ipcRenderer.send("h:openResourceMonitor"),
  closeResourceMonitor: () => ipcRenderer.send("h:closeResourceMonitor"),
  openSettings: () => ipcRenderer.send("h:openSettings"),
  closeSettings: () => ipcRenderer.send("h:closeSettings"),
  minimize: () => ipcRenderer.send("h:minimize"),
  maximize: () => ipcRenderer.send("h:maximize"),
  close: () => ipcRenderer.send("h:close"),
  isMaximized: () => ipcRenderer.invoke("h:isMaximized"),
  newWindow: () => ipcRenderer.send("h:newWindow"),
});
