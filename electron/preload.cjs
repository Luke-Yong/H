const { contextBridge, ipcRenderer } = require("electron");

const browserPreloadUrl = ipcRenderer.sendSync("harness:getBrowserPreloadUrl");

contextBridge.exposeInMainWorld("harnessDesktop", {
  isDesktop: true,
  browserPreloadUrl,
  openFolder: () => ipcRenderer.invoke("harness:openFolder"),
  openFile: () => ipcRenderer.invoke("harness:openFile"),
  onBrowserOpenUrl: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, url) => callback(url);
    ipcRenderer.on("harness:browserOpenUrl", listener);
    return () => ipcRenderer.removeListener("harness:browserOpenUrl", listener);
  },
  setSitePermissions: (origin, permissions) =>
    ipcRenderer.invoke("harness:setSitePermissions", { origin, permissions }),
  openResourceMonitor: () => ipcRenderer.send("harness:openResourceMonitor"),
  closeResourceMonitor: () => ipcRenderer.send("harness:closeResourceMonitor"),
});
