import { useState, useRef, useEffect, useCallback } from "react";

const LANGUAGES = [
  "javascript", "typescript", "html", "css", "json", "python",
  "markdown", "xml", "yaml", "sql", "shell", "plaintext",
];

const INDENT_OPTIONS = [
  { label: "Spaces: 2", tabSize: 2, insertSpaces: true },
  { label: "Spaces: 4", tabSize: 4, insertSpaces: true },
  { label: "Tab: 4", tabSize: 4, insertSpaces: false },
  { label: "Tab: 2", tabSize: 2, insertSpaces: false },
];

const ENCODINGS = ["UTF-8", "UTF-16 LE", "UTF-16 BE", "ISO 8859-1"];

/** Map server-detected encoding to display label */
function encodingLabel(serverEnc: string): string {
  const m: Record<string, string> = {
    "utf8": "UTF-8", "utf8bom": "UTF-8 with BOM",
    "utf16le": "UTF-16 LE", "utf16be": "UTF-16 BE",
    "latin1": "ISO 8859-1",
  };
  return m[serverEnc] || serverEnc || "UTF-8";
}

/** Map display label back to server encoding param */
function encodingToServer(label: string): string {
  const m: Record<string, string> = {
    "UTF-8": "utf8", "UTF-8 with BOM": "utf8bom",
    "UTF-16 LE": "utf16le", "UTF-16 BE": "utf16be",
    "ISO 8859-1": "latin1",
  };
  return m[label] || "utf8";
}

const LINE_ENDINGS = [
  { label: "LF", value: "\n" },
  { label: "CRLF", value: "\r\n" },
];

interface Props {
  cursorLine: number;
  cursorColumn: number;
  language: string;
  encoding: string;
  fsBasePath: string;
  hasFsRoot: boolean;
  hasEditor: boolean;
  lspError?: string;
  onSelectLanguage: (lang: string) => void;
  onGoToLine?: (line: number) => void;
  onGoToBracket?: () => void;
  onIndentChange?: (opts: { tabSize: number; insertSpaces: boolean }) => void;
  onLineEndingChange?: (le: string) => void;
  onEncodingChange?: (enc: string) => void;
}

function DropMenu({ open, items, onPick, onClose }: {
  open: boolean;
  items: { label: string; value?: unknown }[];
  onPick: (item: { label: string; value?: unknown }) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="status-dropdown" ref={ref}>
      {items.map((it) => (
        <button key={it.label} className="status-dropdown-item" onClick={() => onPick(it)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}

interface ProcessInfo { name: string; pid: number; ram: number; ramPercent: number; cpu: number; }
interface ProcCategory { category: string; processes: ProcessInfo[]; }
interface DiskComponent { component: string; size: number; }

interface SysStats {
  cpuPercent: number; cpuCores: number; cpuModel: string; cpuSpeed: number;
  memPercent: number; memUsed: number; memTotal: number;
  uptime: string; loadAvg: number[];
  hostname: string; platform: string; arch: string;
  perCore: number[];
  processesByCategory: ProcCategory[];
  disk: { total: number; free: number; used: number; percent: number; model: string; drive: string };
  diskBreakdown: DiskComponent[];
  network: { totalRx: number; totalTx: number; rxRate: number; txRate: number; ipAddresses: Array<{ name: string; address: string; mac: string }> };
  ourProcess: { pid: number; cpu: number; ram: number; ramPercent: number; heapTotal: number; heapUsed: number; uptime: number };
}

const TABS = ["Overview", "CPU & Memory", "Disk", "Network"] as const;

// ── Patching helpers ──
// On subsequent polls we mutate existing DOM elements in-place
// so CSS transitions (width on bars, color on values) animate smoothly.
function patchDom(root: HTMLElement, s: SysStats) {
  const setText = (key: string, val: string) => {
    const el = root.querySelector(`[data-key="${key}"]`) as HTMLElement | null;
    if (el) el.textContent = val;
  };
  const setWidth = (key: string, pct: number) => {
    const el = root.querySelector(`[data-key="${key}"]`) as HTMLElement | null;
    if (el) el.style.width = `${pct}%`;
  };

  // Bars
  setWidth("cpuPercent", s.cpuPercent);
  setWidth("cpuTotalBar", s.cpuPercent);
  setWidth("memPercent", s.memPercent);
  setWidth("memTotalBar", s.memPercent);
  setWidth("diskPercent", s.disk.percent);
  setWidth("diskTotalBar", s.disk.percent);

  // Percent labels
  setText("cpuTotalPct", `${s.cpuPercent}%`);
  setText("ovCpuPct", `${s.cpuPercent}%`);
  setText("ovMemPct", `${s.memPercent}%`);
  setText("memTotalPct", `${s.memPercent}%`);
  setText("ovDiskPct", `${s.disk.percent}%`);
  setText("diskTotalPct", `${s.disk.percent}%`);

  // Values
  setText("cpuSpeed", `${s.cpuSpeed} MHz`);
  setText("memUsed", formatBytes(s.memUsed));
  setText("memUsed2", formatBytes(s.memUsed));
  setText("memFree", formatBytes(s.memTotal - s.memUsed));
  setText("memTotal", formatBytes(s.memTotal));
  setText("memTotal2", formatBytes(s.memTotal));
  setText("diskUsed", formatBytes(s.disk.used));
  setText("diskFree", formatBytes(s.disk.free));
  setText("diskFree2", formatBytes(s.disk.free));
  setText("diskTotal", formatBytes(s.disk.total));
  setText("diskTotal2", formatBytes(s.disk.total));
  setText("netRx", `${formatBytes(s.network.rxRate)}/s`);
  setText("netTx", `${formatBytes(s.network.txRate)}/s`);
  setText("netTotalRx", formatBytes(s.network.totalRx));
  setText("netTotalTx", formatBytes(s.network.totalTx));
  setText("uptime", `Up ${s.uptime}`);

  // Load averages
  for (let i = 0; i < 3; i++) {
    setText(`loadAvg${i}`, (s.loadAvg[i] ?? 0).toFixed(2));
  }

  // Per-core bars + labels
  s.perCore.forEach((p, i) => {
    setText(`corePct${i}`, `${p}%`);
    const coreRow = root.querySelector(`.resource-core-row:nth-of-type(${i + 1}) .resource-fill`) as HTMLElement | null;
    if (coreRow) coreRow.style.width = `${p}%`;
  });

  // Process section (rebuild — too granular to patch individually)
  const procSection = root.querySelector("[data-process-root]") as HTMLElement | null;
  if (procSection && s.processesByCategory.length > 0) {
    procSection.innerHTML = renderProcessesStatic(s.processesByCategory, s.ourProcess);
  }

  // Heap info for our process
  if (s.ourProcess) {
    setText("procHeap", `Heap ${formatBytes(s.ourProcess.heapUsed)} / ${formatBytes(s.ourProcess.heapTotal)} · Up ${fmtProcUptime(s.ourProcess.uptime)}`);
  }
}

function fmtProcUptime(sec: number) { return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`; }

function barHtml(w: number, c: string, h: number, key: string) {
  return `<div style="height:${h}px;background:#3c3c3c;border-radius:${h/2}px;overflow:hidden"><div data-key="${key}" style="height:100%;width:${w}%;background:${c};border-radius:${h/2}px;transition:width .6s"></div></div>`;
}

function sectionHeader(key: string, label: string, count: string, collapsed: boolean) {
  return `<div class="resource-section-header" data-section="${key}">
    <span class="resource-section-toggle">${collapsed ? "▸" : "▾"}</span>
    <span class="resource-section-title">${label}</span>
    ${count ? `<span class="resource-section-count">${count}</span>` : ""}
  </div>`;
}

function renderProcessesStatic(cats: ProcCategory[], ourProcess: SysStats["ourProcess"]) {
  if (!cats.length) return "";
  let html = "";
  for (const cat of cats) {
    const items = cat.processes.map((p) => {
      const heap = p.pid === ourProcess?.pid
        ? `<div style="margin-top:1px;font-size:9px;color:#888;font-family:monospace" data-key="procHeap">Heap ${formatBytes(ourProcess!.heapUsed)} / ${formatBytes(ourProcess!.heapTotal)} · Up ${fmtProcUptime(ourProcess!.uptime)}</div>` : "";
      return `<div class="resource-proc-row">
        <span class="resource-proc-name" title="${p.name}">${p.name}</span>
        <span class="resource-proc-pid">PID ${p.pid}</span>
        <div class="resource-proc-metric">${barHtml(p.cpu, "#569cd6", 5, "")}<span>${p.cpu}%</span></div>
        <div class="resource-proc-metric">${barHtml(p.ramPercent, "#e2b714", 5, "")}<span>${formatBytes(p.ram)}</span></div>
      </div>${heap}`;
    }).join("");
    html += `<div class="resource-section">
      ${sectionHeader(`proc-${cat.category}`, cat.category, String(cat.processes.length), false)}
      <div class="resource-section-body">${items}</div>
    </div>`;
  }
  return html;
}

function ResourceMonitor() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string>("Overview");
  const [stats, setStats] = useState<SysStats | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const ref = useRef<HTMLDivElement>(null);
  const bodyScrollRef = useRef<number>(0);
  const needsFullRender = useRef(true);

  const toggle = (key: string) => { needsFullRender.current = true; setCollapsed((prev) => ({ ...prev, [key]: !prev[key] })); };
  const switchTab = (t: string) => { needsFullRender.current = true; setTab(t); };

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  useEffect(() => {
    if (!open) { setStats(null); return; }
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/system/stats");
        const data = await res.json();
        if (!active) return;
        setStats({
          cpuPercent: data.cpu.percent, cpuCores: data.cpu.cores,
          cpuModel: data.cpu.model, cpuSpeed: data.cpu.speed,
          memPercent: data.memory.percent, memUsed: data.memory.used, memTotal: data.memory.total,
          uptime: data.uptime, loadAvg: data.loadAvg || [],
          hostname: data.hostname, platform: data.platform, arch: data.arch,
          perCore: data.cpu.perCore || [],
          processesByCategory: data.processesByCategory || [],
          disk: data.disk || { total: 0, free: 0, used: 0, percent: 0, model: "", drive: "" },
          diskBreakdown: data.diskBreakdown || [],
          network: data.network || { totalRx: 0, totalTx: 0, rxRate: 0, txRate: 0, ipAddresses: [] },
          ourProcess: data.ourProcess || null,
        });
      } catch { /* */ }
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => { active = false; clearInterval(iv); };
  }, [open]);

  const buildInitialHtml = (s: SysStats): string => {
    const cores = s.perCore.map((p, i) =>
      `<div class="resource-core-row"><span class="resource-core-label">C${i}</span><div class="resource-core-bar"><div data-key="coreBar${i}" class="resource-fill" style="width:${p}%"></div></div><span class="resource-core-val" data-key="corePct${i}">${p}%</span></div>`
    ).join("");

    const ovDisk = s.disk.total > 0 ? `
      <div class="resource-card">
        ${sectionHeader("ov-disk", `Disk (${s.disk.drive || "C:"})`, `${s.disk.percent}%`, !!collapsed["ov-disk"])}
        <div class="resource-section-body"${collapsed["ov-disk"] ? ' style="display:none"' : ""}>
          <div class="resource-row">
            <span class="resource-row-label">Usage</span>
            ${barHtml(s.disk.percent, "#569cd6", 8, "diskPercent")}
            <span class="resource-row-val" data-key="ovDiskPct">${s.disk.percent}%</span>
          </div>
          <div class="resource-row"><span class="resource-row-label">Free</span><span class="resource-row-val" data-key="diskFree">${formatBytes(s.disk.free)}</span></div>
          <div class="resource-row"><span class="resource-row-label">Total</span><span class="resource-row-val" data-key="diskTotal">${formatBytes(s.disk.total)}</span></div>
          ${s.disk.model ? `<div class="resource-row"><span class="resource-row-label">Model</span><span class="resource-row-val" style="font-size:10px">${s.disk.model}</span></div>` : ""}
        </div>
      </div>` : "";

    const ipSection = s.network.ipAddresses.length ? `
      <div style="margin-top:4px;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.3px">IP Addresses</div>
      ${s.network.ipAddresses.map((ip) => `<div class="resource-row"><span class="resource-row-label">${ip.name}</span><span class="resource-row-val">${ip.address}</span></div>`).join("")}
    ` : "";

    const procCats = s.processesByCategory;
    const allCount = procCats.reduce((a, c) => a + c.processes.length, 0);

    const overviewBody = `
      <div class="resource-card">
        ${sectionHeader("ov-cpu", "CPU", `${s.cpuPercent}%`, !!collapsed["ov-cpu"])}
        <div class="resource-section-body"${collapsed["ov-cpu"] ? ' style="display:none"' : ""}>
          <div class="resource-row">
            <span class="resource-row-label">Usage</span>
            ${barHtml(s.cpuPercent, "#4ec94e", 8, "cpuPercent")}
            <span class="resource-row-val" data-key="ovCpuPct">${s.cpuPercent}%</span>
          </div>
          <div class="resource-row"><span class="resource-row-label">Speed</span><span class="resource-row-val" data-key="cpuSpeed">${s.cpuSpeed} MHz</span></div>
          <div class="resource-row"><span class="resource-row-label">Model</span><span class="resource-row-val" style="font-size:10px">${s.cpuModel}</span></div>
        </div>
      </div>
      <div class="resource-card">
        ${sectionHeader("ov-mem", "Memory", `${s.memPercent}%`, !!collapsed["ov-mem"])}
        <div class="resource-section-body"${collapsed["ov-mem"] ? ' style="display:none"' : ""}>
          <div class="resource-row">
            <span class="resource-row-label">Usage</span>
            ${barHtml(s.memPercent, "#e2b714", 8, "memPercent")}
            <span class="resource-row-val" data-key="ovMemPct">${s.memPercent}%</span>
          </div>
          <div class="resource-row"><span class="resource-row-label">Used</span><span class="resource-row-val" data-key="memUsed">${formatBytes(s.memUsed)}</span></div>
          <div class="resource-row"><span class="resource-row-label">Total</span><span class="resource-row-val" data-key="memTotal">${formatBytes(s.memTotal)}</span></div>
        </div>
      </div>
      ${ovDisk}
      <div class="resource-card">
        ${sectionHeader("ov-net", "Network", "", !!collapsed["ov-net"])}
        <div class="resource-section-body"${collapsed["ov-net"] ? ' style="display:none"' : ""}>
          <div class="resource-row"><span class="resource-row-label">↓ Download</span><span class="resource-row-val" data-key="netRx">${formatBytes(s.network.rxRate)}/s</span></div>
          <div class="resource-row"><span class="resource-row-label">↑ Upload</span><span class="resource-row-val" data-key="netTx">${formatBytes(s.network.txRate)}/s</span></div>
          ${ipSection}
        </div>
      </div>
      <div class="resource-card">
        ${sectionHeader("ov-proc", "Processes (by category)", String(allCount), !!collapsed["ov-proc"])}
        <div class="resource-section-body"${collapsed["ov-proc"] ? ' style="display:none"' : ""} data-process-root>${renderProcessesStatic(procCats, s.ourProcess)}</div>
      </div>`;

    const cpuMemBody = `
      <div class="resource-card">
        ${sectionHeader("cpu-total", "CPU Usage", `${s.cpuPercent}%`, !!collapsed["cpu-total"])}
        <div class="resource-section-body"${collapsed["cpu-total"] ? ' style="display:none"' : ""}>
          <div class="resource-row">
            ${barHtml(s.cpuPercent, "#4ec94e", 10, "cpuTotalBar")}
            <span class="resource-row-val" style="font-size:14px;font-weight:600" data-key="cpuTotalPct">${s.cpuPercent}%</span>
          </div>
        </div>
      </div>
      <div class="resource-card">
        ${sectionHeader("cpu-cores", `Per-Core (${s.cpuCores} cores)`, "", !!collapsed["cpu-cores"])}
        <div class="resource-section-body"${collapsed["cpu-cores"] ? ' style="display:none"' : ""}>${cores}</div>
      </div>
      <div class="resource-card">
        ${sectionHeader("cpu-info", "Processor Info", "", !!collapsed["cpu-info"])}
        <div class="resource-section-body"${collapsed["cpu-info"] ? ' style="display:none"' : ""}>
          <div class="resource-row"><span class="resource-row-label">Model</span><span class="resource-row-val" style="font-size:10px">${s.cpuModel}</span></div>
          <div class="resource-row"><span class="resource-row-label">Speed</span><span class="resource-row-val">${s.cpuSpeed} MHz</span></div>
          <div class="resource-row"><span class="resource-row-label">Cores</span><span class="resource-row-val">${s.cpuCores}</span></div>
        </div>
      </div>
      <div class="resource-card">
        ${sectionHeader("mem-detail", "Memory", `${s.memPercent}%`, !!collapsed["mem-detail"])}
        <div class="resource-section-body"${collapsed["mem-detail"] ? ' style="display:none"' : ""}>
          <div class="resource-row">${barHtml(s.memPercent, "#e2b714", 10, "memTotalBar")}<span class="resource-row-val" style="font-size:14px;font-weight:600" data-key="memTotalPct">${s.memPercent}%</span></div>
          <div class="resource-row"><span class="resource-row-label">Used</span><span class="resource-row-val" data-key="memUsed2">${formatBytes(s.memUsed)}</span></div>
          <div class="resource-row"><span class="resource-row-label">Free</span><span class="resource-row-val" data-key="memFree">${formatBytes(s.memTotal - s.memUsed)}</span></div>
          <div class="resource-row"><span class="resource-row-label">Total</span><span class="resource-row-val" data-key="memTotal2">${formatBytes(s.memTotal)}</span></div>
        </div>
      </div>
      <div class="resource-card">
        ${sectionHeader("load-detail", "Load Average", "", !!collapsed["load-detail"])}
        <div class="resource-section-body"${collapsed["load-detail"] ? ' style="display:none"' : ""}>
          <div class="resource-load-grid">
            ${["1m","5m","15m"].map((l, i) => `<div class="resource-load-item"><span class="resource-load-label">${l}</span><span class="resource-load-value" data-key="loadAvg${i}">${(s.loadAvg[i] ?? 0).toFixed(2)}</span></div>`).join("")}
          </div>
        </div>
      </div>
      <div class="resource-card">
        ${sectionHeader("proc-cpu", "Processes", String(allCount), !!collapsed["proc-cpu"])}
        <div class="resource-section-body"${collapsed["proc-cpu"] ? ' style="display:none"' : ""} data-process-root>${renderProcessesStatic(procCats, s.ourProcess)}</div>
      </div>`;

    const diskItems = s.diskBreakdown.map((d) =>
      `<div class="resource-row"><span class="resource-row-label">${d.component}/</span><span class="resource-row-val">${formatBytes(d.size)}</span></div>`
    ).join("");

    const diskBody = `
      ${s.disk.total > 0 ? `
      <div class="resource-card">
        ${sectionHeader("disk-os", `Drive ${s.disk.drive || "C:"}`, `${s.disk.percent}%`, !!collapsed["disk-os"])}
        <div class="resource-section-body"${collapsed["disk-os"] ? ' style="display:none"' : ""}>
          <div class="resource-row">${barHtml(s.disk.percent, "#569cd6", 10, "diskTotalBar")}<span class="resource-row-val" style="font-size:14px;font-weight:600" data-key="diskTotalPct">${s.disk.percent}%</span></div>
          <div class="resource-row"><span class="resource-row-label">Used</span><span class="resource-row-val" data-key="diskUsed">${formatBytes(s.disk.used)}</span></div>
          <div class="resource-row"><span class="resource-row-label">Free</span><span class="resource-row-val" data-key="diskFree2">${formatBytes(s.disk.free)}</span></div>
          <div class="resource-row"><span class="resource-row-label">Total</span><span class="resource-row-val" data-key="diskTotal2">${formatBytes(s.disk.total)}</span></div>
          ${s.disk.model ? `<div class="resource-row"><span class="resource-row-label">Model</span><span class="resource-row-val" style="font-size:10px">${s.disk.model}</span></div>` : ""}
        </div>
      </div>` : ""}
      <div class="resource-card">
        ${sectionHeader("disk-harness", "Harness Components", "", !!collapsed["disk-harness"])}
        <div class="resource-section-body"${collapsed["disk-harness"] ? ' style="display:none"' : ""}>
          ${diskItems || '<div class="resource-empty">No data</div>'}
        </div>
      </div>`;

    const netBody = `
      <div class="resource-card">
        ${sectionHeader("net-speed", "Transfer Rates", "", !!collapsed["net-speed"])}
        <div class="resource-section-body"${collapsed["net-speed"] ? ' style="display:none"' : ""}>
          <div class="resource-net-row">
            <div class="resource-net-dir"><span class="resource-net-icon">↓</span><span class="resource-net-label">Download</span></div>
            <span class="resource-net-value" data-key="netRx">${formatBytes(s.network.rxRate)}/s</span>
          </div>
          <div class="resource-net-row">
            <div class="resource-net-dir"><span class="resource-net-icon">↑</span><span class="resource-net-label">Upload</span></div>
            <span class="resource-net-value" data-key="netTx">${formatBytes(s.network.txRate)}/s</span>
          </div>
        </div>
      </div>
      <div class="resource-card">
        ${sectionHeader("net-total", "Total Transferred", "", !!collapsed["net-total"])}
        <div class="resource-section-body"${collapsed["net-total"] ? ' style="display:none"' : ""}>
          <div class="resource-row"><span class="resource-row-label">Received</span><span class="resource-row-val" data-key="netTotalRx">${formatBytes(s.network.totalRx)}</span></div>
          <div class="resource-row"><span class="resource-row-label">Sent</span><span class="resource-row-val" data-key="netTotalTx">${formatBytes(s.network.totalTx)}</span></div>
        </div>
      </div>
      ${s.network.ipAddresses.length ? `
      <div class="resource-card">
        ${sectionHeader("net-ip", "IP Addresses", "", !!collapsed["net-ip"])}
        <div class="resource-section-body"${collapsed["net-ip"] ? ' style="display:none"' : ""}>
          ${s.network.ipAddresses.map((ip) => `<div class="resource-row">
            <span class="resource-row-label">${ip.name}</span>
            <div style="flex:1;display:flex;align-items:center;gap:16px">
              <span class="resource-row-val">${ip.address}</span>
              ${ip.mac ? `<span style="font-size:10px;color:#666;font-family:monospace">${ip.mac}</span>` : ""}
            </div>
          </div>`).join("")}
        </div>
      </div>` : ""}`;

    const bodyMap: Record<string, string> = {
      "Overview": overviewBody,
      "CPU & Memory": cpuMemBody,
      "Disk": diskBody,
      "Network": netBody,
    };

    return `
      <div class="resources-header">
        <span class="resources-host">${s.hostname}</span>
        <span class="resources-os">${s.platform} ${s.arch}</span>
        <span class="resources-uptime" data-key="uptime">Up ${s.uptime}</span>
      </div>
      <div class="resources-tabs">
        ${TABS.map((t) => `<button class="resources-tab${tab === t ? " active" : ""}" data-tab="${t}">${t}</button>`).join("")}
      </div>
      <div class="resources-body">${bodyMap[tab] || overviewBody}</div>`;
  };

  const popupRef = useRef<HTMLDivElement>(null);
  const hasRenderedRef = useRef(false);

  useEffect(() => {
    if (!open || !popupRef.current || !stats) return;
    const root = popupRef.current;

    if (needsFullRender.current || !hasRenderedRef.current) {
      // Full render needed (tab switch, collapse toggle, or first load)
      const prevBody = root.querySelector(".resources-body");
      const savedScroll = prevBody ? prevBody.scrollTop : bodyScrollRef.current;

      root.innerHTML = buildInitialHtml(stats);
      hasRenderedRef.current = true;
      needsFullRender.current = false;

      // Restore scroll
      const newBody = root.querySelector(".resources-body");
      if (newBody) {
        (newBody as HTMLElement).scrollTop = savedScroll;
        const onScroll = () => { bodyScrollRef.current = (newBody as HTMLElement).scrollTop; };
        newBody.addEventListener("scroll", onScroll, { passive: true } as AddEventListenerOptions);
      }
    } else {
      // Lightweight patch — update only values/widths in place
      patchDom(root, stats);
    }

    // Delegate clicks for tabs, collapsible sections
    const handler = (e: Event) => {
      const target = e.target as HTMLElement;
      const tabBtn = target.closest("[data-tab]");
      if (tabBtn) { switchTab(tabBtn.getAttribute("data-tab")!); return; }
      const secHeader = target.closest("[data-section]");
      if (secHeader) { toggle(secHeader.getAttribute("data-section")!); }
    };
    root.addEventListener("click", handler);
    return () => root.removeEventListener("click", handler);
  }, [open, stats, collapsed, tab]);

  useEffect(() => {
    if (!open) { hasRenderedRef.current = false; needsFullRender.current = true; }
  }, [open]);

  return (
    <div className="status-item status-resources" ref={ref} style={{ padding: 0 }}>
      <button className="status-btn" onClick={() => setOpen((v) => !v)} title="System Resources">
        ⚡ {stats ? `${stats.cpuPercent}%` : ""}
      </button>
      {open && (
        <div className="status-resources-popup" ref={popupRef}>
          {!stats && <div className="resource-placeholder">Loading system stats...</div>}
        </div>
      )}
    </div>
  );
}

export default function StatusBar({
  cursorLine, cursorColumn, language, encoding, fsBasePath, hasFsRoot, hasEditor, lspError,
  onSelectLanguage, onGoToLine, onGoToBracket, onIndentChange, onLineEndingChange, onEncodingChange,
}: Props) {
  const [langOpen, setLangOpen] = useState(false);
  const [indentIdx, setIndentIdx] = useState(0);
  const [lineEndIdx, setLineEndIdx] = useState(0);
  const [indentOpen, setIndentOpen] = useState(false);
  const [encOpen, setEncOpen] = useState(false);
  const [leOpen, setLeOpen] = useState(false);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoVal, setGotoVal] = useState("");
  const gotoRef = useRef<HTMLInputElement>(null);
  const gotoPopupRef = useRef<HTMLDivElement>(null);
  const langRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) {
        setLangOpen(false);
      }
      if (gotoPopupRef.current && !gotoPopupRef.current.contains(e.target as Node)) {
        setGotoOpen(false);
      }
    };
    if (langOpen || gotoOpen) document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [langOpen, gotoOpen]);

  useEffect(() => {
    if (gotoOpen) {
      setTimeout(() => gotoRef.current?.focus(), 0);
    }
  }, [gotoOpen]);

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <ResourceMonitor />
        {hasFsRoot && (
          <span className="status-item" title="Source Control: main">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4 }}>
              <circle cx="5" cy="5" r="1.5" fill="currentColor"/>
              <circle cx="11" cy="11" r="1.5" fill="currentColor"/>
              <circle cx="11" cy="5" r="1.5" fill="currentColor"/>
              <path d="M5 6.5V9.5M6.5 8H9.5" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
            main
          </span>
        )}
        {lspError && (
          <span className="status-item" title={lspError} style={{ color: "#e2b714", cursor: "help" }}>
            ⚠ LSP: {lspError.length > 40 ? lspError.slice(0, 40) + "..." : lspError}
          </span>
        )}
      </div>
      <div className="status-bar-right">
        {hasEditor && (
          <div className="status-item status-popup-host">
            <span className="status-item" title="Go to Line" onClick={() => { setGotoOpen((v) => !v); setGotoVal(""); }} style={{ padding: 0, cursor: "pointer" }}>
              Ln {cursorLine}, Col {cursorColumn}
            </span>
            {gotoOpen && (
              <div ref={gotoPopupRef} className="status-goto-popup">
                <div className="status-goto-label">Go to Line (1–99999)</div>
                <input
                  ref={gotoRef}
                  className="status-goto-input"
                  type="number"
                  min={1}
                  value={gotoVal}
                  placeholder="Line number"
                  onChange={(e) => setGotoVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      const ln = parseInt(gotoVal, 10);
                      if (!isNaN(ln) && ln > 0) onGoToLine?.(ln);
                      setGotoOpen(false);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setGotoOpen(false);
                    }
                  }}
                />
              </div>
            )}
          </div>
        )}
        {hasEditor && (
          <div className="status-item status-popup-host">
            <button className="status-btn" onClick={() => setIndentOpen((v) => !v)} title="Select Indentation">
              {INDENT_OPTIONS[indentIdx].label}
            </button>
            <DropMenu
              open={indentOpen}
              items={INDENT_OPTIONS}
              onPick={(item) => {
                const idx = INDENT_OPTIONS.findIndex((o) => o.label === item.label);
                setIndentIdx(idx >= 0 ? idx : 0);
                setIndentOpen(false);
                onIndentChange?.(item.value as { tabSize: number; insertSpaces: boolean });
              }}
              onClose={() => setIndentOpen(false)}
            />
          </div>
        )}
        {hasEditor && (
          <div className="status-item status-popup-host">
            <button className="status-btn" onClick={() => setEncOpen((v) => !v)} title="Select Encoding">
              {encodingLabel(encoding)}
            </button>
            <DropMenu
              open={encOpen}
              items={ENCODINGS.map((e) => ({ label: e }))}
              onPick={(item) => {
                setEncOpen(false);
                onEncodingChange?.(encodingToServer(item.label));
              }}
              onClose={() => setEncOpen(false)}
            />
          </div>
        )}
        {hasEditor && (
          <div className="status-item status-popup-host">
            <button className="status-btn" onClick={() => setLeOpen((v) => !v)} title="Select End of Line Sequence">
              {LINE_ENDINGS[lineEndIdx].label}
            </button>
            <DropMenu
              open={leOpen}
              items={LINE_ENDINGS}
              onPick={(item) => {
                const idx = LINE_ENDINGS.findIndex((o) => o.label === item.label);
                setLineEndIdx(idx >= 0 ? idx : 0);
                setLeOpen(false);
                onLineEndingChange?.(item.label);
              }}
              onClose={() => setLeOpen(false)}
            />
          </div>
        )}
        {hasEditor && (
        <div className="status-item status-popup-host" ref={langRef} title="Select Language Mode">
          <button className="status-btn" onClick={() => setLangOpen((v) => !v)}>
            {language}
          </button>
          {langOpen && (
            <div className="status-lang-menu">
              {LANGUAGES.map((l) => (
                <button
                  key={l}
                  className={`status-lang-item${language === l ? " active" : ""}`}
                  onClick={() => { onSelectLanguage(l); setLangOpen(false); }}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
        )}
        {hasEditor && (
          <span className="status-item" title="Go to Bracket" onClick={() => {
            if (onGoToBracket) onGoToBracket();
          }}>
            {"{}"}
          </span>
        )}
      </div>
    </div>
  );
}
