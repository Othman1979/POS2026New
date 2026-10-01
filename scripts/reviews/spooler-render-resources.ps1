param([Parameter(Mandatory)][string]$OutputPrefix, [int]$Rounds = 20, [switch]$CompiledOnly, [switch]$ReceiptTransport, [switch]$NoDelay)
$ErrorActionPreference = 'Stop'
if ([IntPtr]::Size -ne 8) { throw 'Run this benchmark in 64-bit PowerShell.' }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
# A Windows job accounts for CPU from exited Typst children as well as living
# ones. The benchmark waits until assignment, so no compiler escapes accounting.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RenderJob {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a, string n);
 [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
 [DllImport("kernel32.dll")] public static extern bool QueryInformationJobObject(IntPtr j, int c, IntPtr b, uint l, IntPtr r);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] public static extern bool TerminateJobObject(IntPtr h, uint code);
 public static long[] Read(IntPtr j) {
  IntPtr b=Marshal.AllocHGlobal(65536);
  try {
   if(!QueryInformationJobObject(j,1,b,48,IntPtr.Zero)) throw new Exception("Job CPU query failed");
   long cpu=Marshal.ReadInt64(b,0)+Marshal.ReadInt64(b,8);
   long count=Marshal.ReadInt32(b,36);
   if(!QueryInformationJobObject(j,9,b,144,IntPtr.Zero)) throw new Exception("Job memory query failed");
   long peakCommit=Marshal.ReadInt64(b,136);
   if(!QueryInformationJobObject(j,3,b,65536,IntPtr.Zero)) throw new Exception("Job PID query failed");
   int n=Marshal.ReadInt32(b,4); long ws=0;
   for(int i=0;i<n;i++) try { using(var p=System.Diagnostics.Process.GetProcessById((int)Marshal.ReadInt64(b,8+i*8))) ws+=p.WorkingSet64; } catch(ArgumentException) {} catch(InvalidOperationException) {}
   return new long[]{cpu, count, peakCommit, ws};
  } finally { Marshal.FreeHGlobal(b); }
 }
}
'@
$prefix = [IO.Path]::GetFullPath($OutputPrefix)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($prefix)) | Out-Null
$ready = "$prefix.ready"
if (Test-Path -LiteralPath $ready) { throw 'Use a fresh output prefix; ready marker already exists.' }
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = if ($env:SPOOLER_AUDIT_NODE_EXE) { [IO.Path]::GetFullPath($env:SPOOLER_AUDIT_NODE_EXE) } else { Join-Path $repoRoot 'deployment/out/toolchain/node/node.exe' }
$start.Arguments = '"' + (Join-Path $repoRoot 'scripts/reviews/spooler-render-performance.cjs') + '"'
$start.WorkingDirectory = $repoRoot
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.EnvironmentVariables['SPOOLER_RESOURCE_READY'] = $ready
$start.EnvironmentVariables['SPOOLER_RENDER_ROUNDS'] = [string]$Rounds
$start.EnvironmentVariables['SPOOLER_COMPILED_ONLY'] = [string][int]$CompiledOnly.IsPresent
$start.EnvironmentVariables['SPOOLER_TYPST_EXE'] = if ($env:SPOOLER_TYPST_EXE) { [IO.Path]::GetFullPath($env:SPOOLER_TYPST_EXE) } else { Join-Path $repoRoot 'deployment/out/stage/spooler/.cache/typst/0.15.1/typst.exe' }
$start.EnvironmentVariables['SPOOLER_TYPST_FONT_DIR'] = if ($env:SPOOLER_TYPST_FONT_DIR) { [IO.Path]::GetFullPath($env:SPOOLER_TYPST_FONT_DIR) } else { Join-Path $repoRoot 'deployment/out/stage/spooler/.cache/typst/0.15.1/fonts' }
$start.EnvironmentVariables['SPOOLER_RECEIPT_TRANSPORT'] = [string][int]$ReceiptTransport.IsPresent
$start.EnvironmentVariables['SPOOLER_TCP_NODELAY'] = [string][int]$NoDelay.IsPresent
$job = [RenderJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw 'Cannot create accounting job.' }
$process = $null
$assigned = $false
try {
 $process = [Diagnostics.Process]::Start($start)
 if (-not [RenderJob]::AssignProcessToJobObject($job, $process.Handle)) { throw 'Cannot account for renderer process tree.' }
 $assigned = $true
 $stdout = $process.StandardOutput.ReadToEndAsync()
 $stderr = $process.StandardError.ReadToEndAsync()
 $clock = [Diagnostics.Stopwatch]::StartNew()
 [IO.File]::WriteAllText($ready, 'ready')
 $samples = [Collections.Generic.List[object]]::new()
 do {
  $values = [RenderJob]::Read($job)
  $samples.Add([pscustomobject]@{ elapsed_ms=$clock.ElapsedMilliseconds; cpu_ms=$values[0]/10000; processes_created=$values[1]; peak_job_commit_bytes=$values[2]; working_set_bytes=$values[3] })
  Start-Sleep -Milliseconds 100
 } while (-not $process.HasExited)
 $process.WaitForExit()
 [IO.File]::WriteAllText("$prefix.render.json", $stdout.GetAwaiter().GetResult())
 [IO.File]::WriteAllText("$prefix.stderr.log", $stderr.GetAwaiter().GetResult())
 $final = [RenderJob]::Read($job)
 $result = [ordered]@{ renderer='typst'; rounds=$Rounds; exit_code=$process.ExitCode; elapsed_ms=$clock.ElapsedMilliseconds; cpu_ms=$final[0]/10000; processes_created=$final[1]; peak_job_commit_bytes=$final[2]; samples=$samples }
 [IO.File]::WriteAllText("$prefix.resources.json", ($result | ConvertTo-Json -Depth 5))
 if ($process.ExitCode -ne 0) { throw "Benchmark failed; see $prefix.stderr.log" }
 Write-Output "Completed $prefix"
} finally {
 if ($process -and -not $process.HasExited) {
  if ($assigned) { [RenderJob]::TerminateJobObject($job, 1) | Out-Null }
  else { $process.Kill() }
 }
 if ($process) { $process.Dispose() }
 [RenderJob]::CloseHandle($job) | Out-Null
 if (Test-Path -LiteralPath $ready) { Remove-Item -LiteralPath $ready }
}
