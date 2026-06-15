const { contextBridge, ipcRenderer } = require("electron");

function reportHost(msg, data) {
  try {
    ipcRenderer.sendToHost("harness:browserPreloadDebug", {
      msg,
      data,
      ts: Date.now(),
    });
  } catch {}
}

async function fetchNativeLocation(options) {
  reportHost("fetchNativeLocation called", {
    options: options || {},
  });
  return ipcRenderer.invoke("harness:getNativeLocation", {
    options: options || {},
  });
}

const bridge = {
  getCurrentPosition: async (options) => {
    reportHost("bridge.getCurrentPosition invoked", {
      options: options || {},
    });
    return fetchNativeLocation(options);
  },
};

try {
  contextBridge.exposeInMainWorld("__harnessGeoBridge", bridge);
  reportHost("contextBridge exposed", {
    key: "__harnessGeoBridge",
  });
} catch (err) {
  reportHost("contextBridge expose failed", {
    message: err?.message,
  });
}

reportHost("browser preload initialized", {
  hasNavigator: !!window.navigator,
  locationHref: window.location.href,
});
