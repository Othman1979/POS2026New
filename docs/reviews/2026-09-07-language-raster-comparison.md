# Measured Node, Rust and C# raster comparison

This is a component benchmark, not three completed spoolers. No production change was made. It answers whether equivalent native raster work is smaller/faster, without pretending it proves full-service resource savings.

## Exact work

Generate actual compiled customer/kitchen HTML using the existing fixture compiler, render it with current Puppeteer/canvas, and save 576-wide RGBA pixels (receipt height 911, kitchen 751). Each implementation reads the same RGBA once, runs the same alpha cutoff, floating-point luminance calculation, threshold, 256-row ESC/POS band packing and output concatenation 1,000 times, then saves the last result. All output hashes matched across languages and three rounds. Rust uses black_box to prevent unused repeated work being optimized away. The Node benchmark calls the existing production encoder, not a replacement implementation.

Three fresh-process repetitions per language/document, reversing language order in round two, produced 18,000 rasterizations. CPU and elapsed totals include startup/input/final output. Memory is sampled process working set at approximately 5 ms; values below are medians of per-process sampled peaks. These are not guaranteed peaks, private memory, or full-spooler measurements.

Toolchains: packaged Node 22.23.0, optimized Rust 1.98.1 (`rustc -O`), and the installed .NET Framework 4.x C# compiler (`csc /optimize+`). C# here is **not modern .NET or Native AOT**. `dotnet --list-sdks` returned no SDKs. Go was not available and was not measured. No SDK/runtime was installed.

| Language | Customer CPU / raster | Kitchen CPU / raster | Customer sampled peak working set | Kitchen sampled peak working set |
| --- | ---: | ---: | ---: | ---: |
| Node | 1.156 ms | 0.984 ms | 69.80 MiB | 69.21 MiB |
| Rust | 0.656 ms | 0.531 ms | 5.89 MiB | 5.51 MiB |
| C# (.NET Framework) | 0.906 ms | 0.734 ms | 21.44 MiB | 21.08 MiB |

Elapsed time per raster was approximately 1.195/0.977 ms for Node customer/kitchen, 0.676/0.551 ms for Rust, and 0.908/0.750 ms for C#. Rust reduced component CPU about 43–46%; C# about 22–25%.

## What these numbers mean

There is real evidence that a native raster executable can be smaller and cheaper than this Node raster process. Rust saved approximately **0.45–0.50 ms CPU per receipt**. That is a meaningful reduction in this component but a small fraction of the previously measured roughly 66 ms render-to-loopback delivery path.

The earlier full rendering/transport baseline used approximately 247–248 MiB peak job committed memory and 400–409 MiB sampled summed working set. Those measures cover a different workload and process tree. **Do not subtract the component working-set numbers from the full benchmark or claim a full-service percentage saving.** Chromium layout/capture, PNG decode, native image libraries, journal retention, TLS, status monitoring, platform integration and recovery are absent from this component benchmark.

No new transport language comparison was run: the existing Node transport already measured about 1.1–1.2 ms per ticket on loopback. Rust/C# use the same network and Windows printer facilities, but that observation is not proof of equal native implementation performance. Physical printer delivery has not been measured here.

The memory difference is evidence for investigating a native agent, not evidence that an entire Rust spooler would fit in 6 MiB. C# binary size also excludes its installed Framework runtime, so comparing executable sizes would be misleading. A mixed Node/native implementation could add process/IPC costs instead of realizing the standalone memory difference.

## Next evidence required before a rewrite decision

1. Equivalent service slices in modern C# and Rust: actual journal durability, hash validation, TCP transmission, Windows helper behavior, recovery, bounded queues and identity protection. Measure idle and sustained memory on the same machine with the same renderer.
2. A browser-free compiled-document renderer: preserve Arabic shaping, font metrics, wrapping, QR and templates. Compare output and total resources; this is where the largest current rendering cost could be removed.
3. Representative low-end hardware and physical printers, including interrupted writes and restart recovery. Language speed does not replace delivery-safety testing.

The measured result does **not** select a whole-system rewrite. Rust leads the measured component; C# retains its Windows-integration advantages, but its modern deployment modes still need measurement. There is no Go number to report.

## Reproduce

Set the staged Puppeteer cache, then run `node scripts/reviews/language-raster-fixtures.cjs`. Compile with `rustc -O scripts/reviews/language-raster.rs -o scratch/language-raster/rust.exe` and the Framework64 v4.0.30319 compiler using `/optimize+ /out:scratch/language-raster/csharp.exe scripts\reviews\language-raster.cs`. Run `powershell -NoProfile -File scripts/reviews/language-raster-measure.ps1` in the repository root. The script requires already-built executables and compares all output hashes. Run without other benchmarks.

[Raw and summarized evidence](2026-09-07-language-raster-evidence.json). Generated inputs, executable files and raw results stay under ignored `scratch/language-raster/`. No printer, production database, deployment or installed service was touched.
