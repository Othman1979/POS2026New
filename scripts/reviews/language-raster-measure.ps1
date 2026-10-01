$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$fixture=Join-Path $root 'scratch/language-raster'
$results=@()
foreach($round in 0..2){foreach($type in @('receipt','kitchen')){
 $languages=if($round -eq 1){@('csharp','rust','node')}else{@('node','rust','csharp')}
 foreach($language in $languages){
 $exe=if($language -eq 'node'){Join-Path $root 'deployment/out/toolchain/node/node.exe'}else{Join-Path $fixture "$language.exe"}
 $destination=Join-Path $fixture "$type-$language.bin"
 $arguments='"'+(Join-Path $fixture "$type.rgba")+'" "'+$destination+'" 1000'
 if($language -eq 'node'){$arguments='"'+(Join-Path $PSScriptRoot 'language-raster-node.cjs')+'" '+$arguments}
 $info=[Diagnostics.ProcessStartInfo]::new($exe,$arguments);$info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $watch=[Diagnostics.Stopwatch]::StartNew();$p=[Diagnostics.Process]::Start($info)
 $handle=$p.Handle # Keep process accounting available after exit.
 $peak=0L
 while(-not $p.WaitForExit(5)){$p.Refresh();$peak=[Math]::Max($peak,$p.WorkingSet64)}
 $p.Refresh();if($p.ExitCode -ne 0){throw "Failed $language"}
 $results+=[pscustomobject]@{language=$language;fixture=$type;round=$round;iterations=1000;wall_ms=$watch.Elapsed.TotalMilliseconds;cpu_ms=$p.TotalProcessorTime.TotalMilliseconds;sampled_peak_working_set_bytes=$peak;hash=(Get-FileHash $destination).Hash}
 $p.Dispose()
 }}}
foreach($type in @('receipt','kitchen')){if(@($results | Where-Object fixture -eq $type | Select-Object -ExpandProperty hash -Unique).Count -ne 1){throw "Output mismatch $type"}}
$results | ConvertTo-Json | Set-Content (Join-Path $fixture 'results.json')
$results | Format-Table language,fixture,round,cpu_ms,wall_ms,sampled_peak_working_set_bytes
