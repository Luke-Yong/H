const { execFile } = require("child_process");

const POWERSHELL_SCRIPT = String.raw`
try {
  Add-Type -AssemblyName System.Device
  $watcher = New-Object System.Device.Location.GeoCoordinateWatcher

  # Use Start() + poll instead of TryStart - more reliable on some machines
  $watcher.Start()
  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  $gotFix = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($watcher.Status -eq [System.Device.Location.GeoPositionStatus]::Ready) {
      $gotFix = $true
      break
    }
    if ($watcher.Permission -eq [System.Device.Location.GeoPositionPermission]::Denied) {
      [Console]::Out.Write('{"ok":false,"code":1,"message":"Windows location access denied. Open Settings > Privacy > Location and enable access for this app."}')
      exit 0
    }
    Start-Sleep -Milliseconds 250
  }

  if (-not $gotFix) {
    [Console]::Out.Write('{"ok":false,"code":3,"message":"Timed out waiting for Windows location. Ensure Location services are on in Windows Settings and a positioning source (Wi-Fi, GPS) is available."}')
    exit 0
  }

  $loc = $watcher.Position.Location
  if ($null -eq $loc -or $loc.IsUnknown) {
    [Console]::Out.Write('{"ok":false,"code":2,"message":"Windows location is unavailable. No position source found."}')
    exit 0
  }

  @{
    ok = $true
    provider = "windows"
    latitude = $loc.Latitude
    longitude = $loc.Longitude
    accuracy = $loc.HorizontalAccuracy
    altitude = $loc.Altitude
    heading = $null
    speed = $null
    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } | ConvertTo-Json -Compress
} catch {
  @{
    ok = $false
    code = 2
    provider = "windows"
    message = $_.Exception.Message
  } | ConvertTo-Json -Compress
}
`;

function parseJsonSafe(raw) {
  try {
    return JSON.parse(String(raw || "").trim());
  } catch {
    return null;
  }
}

function getNativeWindowsLocation(timeoutMs = 35000) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve({
        ok: false,
        code: 2,
        provider: "windows",
        message: "Native Windows location is only available on Windows.",
      });
      return;
    }

    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        POWERSHELL_SCRIPT,
      ],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const parsed = parseJsonSafe(stdout);
        if (parsed) {
          resolve(parsed);
          return;
        }

        if (error && error.killed) {
          resolve({
            ok: false,
            code: 3,
            provider: "windows",
            message: "Timed out waiting for Windows location.",
          });
          return;
        }

        resolve({
          ok: false,
          code: 2,
          provider: "windows",
          message: String(stderr || error?.message || "Failed to get native Windows location.").trim(),
        });
      }
    );
  });
}

// getBestAvailableLocation is now windows-only
const getBestAvailableLocation = getNativeWindowsLocation;

module.exports = {
  getNativeWindowsLocation,
  getBestAvailableLocation,
};
