// Section 10 — packaged-boot port-conflict guard.
//
// The packaged app hosts the API on PORT (4040) + the channel listener on
// CHANNEL_PORT (8788). If a dev stack (`pnpm dev`) or a second app instance is
// already holding those ports, Hono's `serve()` throws EADDRINUSE during boot —
// which, before this guard, killed the main process silently (no window, no
// message). This module detects the conflict, names the offender, and can free
// the ports on explicit user action.
//
// Killing rules (mirrors the "verify cmdline before killing" project rule):
//   - NEVER kill anything named claude.exe (orchestrator / other CC sessions)
//     or the editor's TypeScript servers.
//   - Only kill processes whose command line carries a Caisson signature.
//   - Walk up to the dev-supervisor / dev-app coordinator and tree-kill THAT,
//     otherwise the supervisor respawns the server the instant we kill it.
//
// Windows-only owner lookup + kill (the only packaged target today). On other
// platforms we can still detect "port in use" but not identify/kill the owner.

import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CAISSON_SIG = /PC-PTY-Chat|dev-supervisor\.mjs|dev-app\.mjs/i;
const NEVER_KILL = /claude\.exe|tsserver|typingsInstaller/i;

export interface PortConflict {
  port: number;
  pid: number;
  name: string;
  commandLine: string;
  /** True when this owner is a recognizable Caisson process we may free. */
  isCaisson: boolean;
}

export interface FreeResult {
  killed: { pid: number; name: string; cmd: string }[];
  skipped: { pid: number; name: string; cmd: string; reason: string }[];
}

/** Is the port already bound on 127.0.0.1? Cross-platform; no owner info. */
export async function isPortInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', (err: NodeJS.ErrnoException) =>
      resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES'),
    );
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, host);
  });
}

async function runPwsh(script: string): Promise<string> {
  // Windows PowerShell 5.1 (always present) — not pwsh, which an end user may
  // not have installed. Get-NetTCPConnection + Get-CimInstance exist in 5.1.
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

/** Who (if anyone) is listening on each port. Identifies the owner on Windows. */
export async function findPortConflicts(ports: number[]): Promise<PortConflict[]> {
  if (process.platform !== 'win32') {
    const out: PortConflict[] = [];
    for (const port of ports) {
      if (await isPortInUse(port)) {
        out.push({ port, pid: 0, name: 'unknown', commandLine: '', isCaisson: false });
      }
    }
    return out;
  }

  const script = `
$ports = @(${ports.join(',')})
$result = foreach ($p in $ports) {
  $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
    [pscustomobject]@{ port = $p; ownerPid = [int]$conn.OwningProcess; name = "$($proc.Name)"; commandLine = "$($proc.CommandLine)" }
  }
}
if ($result) { $result | ConvertTo-Json -Compress -Depth 3 } else { '' }
`;

  let stdout = '';
  try {
    stdout = (await runPwsh(script)).trim();
  } catch {
    // Detection is best-effort; fall back to the bind test (no owner info).
    return fallbackDetect(ports);
  }
  if (!stdout) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fallbackDetect(ports);
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map((o: any) => {
    const commandLine = String(o.commandLine ?? '');
    const name = String(o.name ?? 'unknown');
    return {
      port: Number(o.port),
      pid: Number(o.ownerPid ?? 0),
      name,
      commandLine,
      isCaisson: CAISSON_SIG.test(commandLine) && !NEVER_KILL.test(name),
    };
  });
}

async function fallbackDetect(ports: number[]): Promise<PortConflict[]> {
  const out: PortConflict[] = [];
  for (const port of ports) {
    if (await isPortInUse(port)) {
      out.push({ port, pid: 0, name: 'unknown', commandLine: '', isCaisson: false });
    }
  }
  return out;
}

/**
 * Free the given ports by tree-killing the Caisson process holding each one —
 * walking up to the dev-supervisor / dev-app coordinator first so the kill
 * sticks instead of being respawned. Never touches claude.exe or TS servers.
 */
export async function freeCaissonPorts(ports: number[]): Promise<FreeResult> {
  if (process.platform !== 'win32') return { killed: [], skipped: [] };

  const script = `
$ports = @(${ports.join(',')})
$kill = @{}
$skip = @()
function Get-Proc($id) { Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue }
foreach ($p in $ports) {
  $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { continue }
  $owner = Get-Proc $conn.OwningProcess
  if (-not $owner) { continue }
  # Walk up to the respawning coordinator if there is one; else target the owner.
  $target = $owner
  $cur = $owner
  for ($i = 0; $i -lt 8 -and $cur; $i++) {
    if ("$($cur.CommandLine)" -match 'dev-supervisor\\.mjs|dev-app\\.mjs') { $target = $cur; break }
    $cur = Get-Proc $cur.ParentProcessId
  }
  $cmd = "$($target.CommandLine)"
  $nm = "$($target.Name)"
  if ($nm -match 'claude\\.exe' -or $cmd -match 'tsserver|typingsInstaller') {
    $skip += [pscustomobject]@{ pid = [int]$target.ProcessId; name = $nm; cmd = $cmd; reason = 'protected' }
  } elseif ($cmd -match 'PC-PTY-Chat|dev-supervisor\\.mjs|dev-app\\.mjs') {
    $kill[[string]$target.ProcessId] = [pscustomobject]@{ pid = [int]$target.ProcessId; name = $nm; cmd = $cmd }
  } else {
    $skip += [pscustomobject]@{ pid = [int]$target.ProcessId; name = $nm; cmd = $cmd; reason = 'not-recognized-as-caisson' }
  }
}
$killed = @()
foreach ($k in $kill.Values) {
  & taskkill /F /T /PID $k.pid *> $null
  $killed += $k
}
[pscustomobject]@{ killed = @($killed); skipped = @($skip) } | ConvertTo-Json -Compress -Depth 4
`;

  try {
    const stdout = (await runPwsh(script)).trim();
    if (!stdout) return { killed: [], skipped: [] };
    const parsed = JSON.parse(stdout);
    return {
      killed: Array.isArray(parsed.killed) ? parsed.killed : parsed.killed ? [parsed.killed] : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : parsed.skipped ? [parsed.skipped] : [],
    };
  } catch {
    return { killed: [], skipped: [] };
  }
}
