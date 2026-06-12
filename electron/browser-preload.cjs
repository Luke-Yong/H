const { contextBridge, ipcRenderer } = require("electron");

const GEO_ERROR = {
  PERMISSION_DENIED: 1,
  POSITION_UNAVAILABLE: 2,
  TIMEOUT: 3,
};

function reportHost(msg, data) {
  try {
    ipcRenderer.sendToHost("harness:browserPreloadDebug", {
      msg,
      data,
      ts: Date.now(),
    });
  } catch {}
}

function createPosition(result) {
  return {
    coords: {
      latitude: Number(result.latitude),
      longitude: Number(result.longitude),
      accuracy: Number(result.accuracy || 0),
      altitude: result.altitude ?? null,
      altitudeAccuracy: null,
      heading: result.heading ?? null,
      speed: result.speed ?? null,
    },
    timestamp: Number(result.timestamp || Date.now()),
  };
}

function createError(result) {
  return {
    code: typeof result?.code === "number" ? result.code : GEO_ERROR.POSITION_UNAVAILABLE,
    message: result?.message || "Failed to get native location.",
    PERMISSION_DENIED: GEO_ERROR.PERMISSION_DENIED,
    POSITION_UNAVAILABLE: GEO_ERROR.POSITION_UNAVAILABLE,
    TIMEOUT: GEO_ERROR.TIMEOUT,
  };
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

function patchMainWorldGeolocation() {
  if (typeof contextBridge.executeInMainWorld !== "function") {
    reportHost("executeInMainWorld unavailable", {});
    return;
  }

  try {
    contextBridge.executeInMainWorld({
      func: () => {
        const bridge = window.__harnessGeoBridge;
        if (!bridge || typeof bridge.getCurrentPosition !== "function") {
          return { ok: false, reason: "bridge-missing" };
        }

        const geo = {
          getCurrentPosition(success, error, options) {
            bridge.getCurrentPosition(options).then((result) => {
              if (result && result.ok) {
                success && success({
                  coords: {
                    latitude: Number(result.latitude),
                    longitude: Number(result.longitude),
                    accuracy: Number(result.accuracy || 0),
                    altitude: result.altitude ?? null,
                    altitudeAccuracy: null,
                    heading: result.heading ?? null,
                    speed: result.speed ?? null,
                  },
                  timestamp: Number(result.timestamp || Date.now()),
                });
              } else {
                error && error({
                  code: typeof result?.code === "number" ? result.code : 2,
                  message: result?.message || "Failed to get location.",
                  PERMISSION_DENIED: 1,
                  POSITION_UNAVAILABLE: 2,
                  TIMEOUT: 3,
                });
              }
            }).catch((err) => {
              error && error({
                code: 2,
                message: err?.message || "Failed to get location.",
                PERMISSION_DENIED: 1,
                POSITION_UNAVAILABLE: 2,
                TIMEOUT: 3,
              });
            });
          },
          watchPosition(success, error, options) {
            const id = Math.floor(Math.random() * 1e9);
            geo.getCurrentPosition(success, error, options);
            return id;
          },
          clearWatch() {},
        };

        try {
          if (window.Navigator && window.Navigator.prototype) {
            Object.defineProperty(window.Navigator.prototype, "geolocation", {
              configurable: true,
              enumerable: true,
              get() {
                return geo;
              },
            });
          }
        } catch {}

        Object.defineProperty(window.navigator, "geolocation", {
          configurable: true,
          enumerable: true,
          get() {
            return geo;
          },
        });
        return {
          ok: true,
          replaced: window.navigator.geolocation === geo,
        };
      },
    }).then((result) => {
      reportHost("executeInMainWorld patch result", result || {});
    }).catch((err) => {
      reportHost("executeInMainWorld patch failed", {
        message: err?.message,
      });
    });
  } catch (err) {
    reportHost("executeInMainWorld threw", {
      message: err?.message,
    });
  }
}

let watchSeq = 0;
const activeWatches = new Map();

const geolocation = {
  async getCurrentPosition(success, error, options) {
    reportHost("getCurrentPosition invoked", {
      hasSuccess: typeof success === "function",
      hasError: typeof error === "function",
    });
    try {
      const result = await fetchNativeLocation(options);
      if (result?.ok) {
        reportHost("getCurrentPosition success", {
          provider: result.provider,
          latitude: result.latitude,
          longitude: result.longitude,
        });
        success?.(createPosition(result));
      } else {
        reportHost("getCurrentPosition error result", {
          code: result?.code,
          message: result?.message,
        });
        error?.(createError(result));
      }
    } catch (err) {
      reportHost("getCurrentPosition threw", {
        message: err?.message,
      });
      error?.(createError({ code: GEO_ERROR.POSITION_UNAVAILABLE, message: err?.message }));
    }
  },
  watchPosition(success, error, options) {
    reportHost("watchPosition invoked", {
      options: options || {},
    });
    const watchId = ++watchSeq;
    const pollMs = Math.max(2000, Number(options?.maximumAge) || 5000);
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        const result = await fetchNativeLocation(options);
        if (cancelled) return;
        if (result?.ok) {
          success?.(createPosition(result));
        } else {
          error?.(createError(result));
        }
      } catch (err) {
        if (!cancelled) {
          error?.(createError({ code: GEO_ERROR.POSITION_UNAVAILABLE, message: err?.message }));
        }
      }
      if (!cancelled) {
        const timer = setTimeout(tick, pollMs);
        activeWatches.set(watchId, timer);
      }
    };

    void tick();
    return watchId;
  },
  clearWatch(watchId) {
    const timer = activeWatches.get(watchId);
    if (timer) {
      clearTimeout(timer);
      activeWatches.delete(watchId);
    }
  },
};

Object.defineProperty(window.navigator, "geolocation", {
  configurable: true,
  enumerable: true,
  value: geolocation,
});

try {
  contextBridge.exposeInMainWorld("__harnessGeoBridge", bridge);
  reportHost("contextBridge exposed", {
    key: "__harnessGeoBridge",
  });
  patchMainWorldGeolocation();
} catch (err) {
  reportHost("contextBridge expose failed", {
    message: err?.message,
  });
}

reportHost("browser preload initialized", {
  hasNavigator: !!window.navigator,
  replacedGeolocation: window.navigator.geolocation === geolocation,
  locationHref: window.location.href,
});
