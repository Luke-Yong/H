// bootstrap-packaged.cjs
//
// Loaded via --require BEFORE the compiled Express server entry (index.js) in
// packaged Electron builds. It registers the two possible node_modules roots
// (unpacked for native .node files, asar virtual dir for pure-JS packages) in
// Node's CJS module search paths BEFORE any require() call inside index.js runs.
//
// Without this bootstrap, require("dotenv/config") (line 1 of compiled index.js)
// crashes in packaged builds because the child's CWD is D:\H\resources, and
// the standard CJS walk-up misses the app.asar virtual and app.asar.unpacked
// sibling directories entirely.
//
// This file is copied to dist/server/ by desktop:build-server step below and is
// also included in asarUnpack so it lives on real NTFS (the entry path passed
// to child_process.spawn must be a real file in ELECTRON_RUN_AS_NODE mode).

"use strict";

const Module = require("module");
const path = require("path");
const fs = require("fs");

function addGlobalNodeModuleDir(p) {
  if (p && typeof p === "string" && fs.existsSync(p)) {
    try {
      if (!Module.globalPaths.includes(p)) Module.globalPaths.push(p);
      // Also seed require.cache-aware Module._nodeModulePaths fallback
      const currentPaths = Module.globalPaths;
      if (!currentPaths.includes(p)) currentPaths.push(p);
    } catch {}
  }
}

// Candidate resource roots: in packaged layout __dirname is
// <install>/resources/app.asar.unpacked/dist/server — but also accept
// process.resourcesPath if set (authoritative when available).
const candidateRoots = [];
if (process.resourcesPath) candidateRoots.push(process.resourcesPath);
candidateRoots.push(path.resolve(__dirname, "..", "..", "..")); // up 3: dist/server/<here> -> app.asar.unpacked parent = resources/
candidateRoots.push(path.resolve(__dirname, "..", ".."));      // up 2: app.asar.unpacked itself (resources/app.asar.unpacked)

for (const root of candidateRoots) {
  if (!root) continue;
  addGlobalNodeModuleDir(path.join(root, "app.asar.unpacked", "node_modules"));
  addGlobalNodeModuleDir(path.join(root, "app.asar", "node_modules"));
  // If the app.asar.unpacked itself contains a top-level node_modules (legacy)
  addGlobalNodeModuleDir(path.join(root, "node_modules"));
}

// Refresh Node's cached computed paths so they include the freshly-pushed entries.
// This also re-reads any NODE_PATH env var inherited from parent.
try {
  if (typeof Module._initPaths === "function") {
    Module._initPaths();
  }
} catch {}

// Now require("dotenv/config") (index.js line 1) resolves from either
// resources/app.asar/node_modules/dotenv or the unpacked twin correctly.
