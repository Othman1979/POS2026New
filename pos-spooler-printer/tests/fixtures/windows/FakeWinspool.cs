// In-memory stand-in for the winspool/kernel32 calls PosSpoolerPlatform.cs makes. Compiled
// with the helper's real source (only its P/Invoke declarations are redirected here), so
// PrintRaw, the deadline timer and WaitForLocalQueueDrain run unchanged. No OS printer is used.
//
// Model per printer: FIFO job queue; the head job despools into a device buffer that drains
// at the print rate; a job is PRINTED once every byte reached the device (as Windows reports
// completion once the port accepted the data). SetJob(DELETE) on the printing job stops its
// remaining bytes. "direct" printers skip spooling: WritePrinter feeds the device itself.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class FakeWinspool
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void SetLastError(int code);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct JobInfo1
    {
        public int JobId;
        public IntPtr pPrinterName, pMachineName, pUserName, pDocument, pDatatype, pStatus;
        public int Status, Priority, Position, TotalPages, PagesPrinted;
        public short Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PrinterInfo2
    {
        public IntPtr Server, Name, Share, Port, Driver, Comment, Location, DevMode, SepFile, Processor, Datatype, Parameters, Security;
        public int Attributes, Priority, DefaultPriority, StartTime, UntilTime, Status, Jobs, AveragePPM;
    }

    private const int PRINTING = 0x10, PRINTED = 0x80, DELETED = 0x100, COMPLETE = 0x1000, SPOOLING = 0x08, DELETING = 0x04;

    private sealed class Printer
    {
        public string Name;
        public int Rate = 60000, DeviceBuffer = 16384;
        public bool Direct;
        public bool RetainFails, ReleaseFails;
        public int PartialWrite;
        public long StallAt = -1;
        public int StallMs;
        public bool Stalled;
        public long ExternalCancelAt = -1;   // an operator's "Cancel" on the printing job, by device bytes
        public bool ExternalCanceled;
        public int Status, NextStatus, StatusAfterMs = -1, StatusDelayMs;
        public bool StatusChanged;
        public double Budget;
        public long DeviceQueued;         // bytes in the device buffer, not yet printed
        public long DeviceTotal;          // bytes ever delivered to the device
        public long Consumed;             // bytes the device has printed
        public List<Job> Queue = new List<Job>();
        public List<AutoResetEvent> Watchers = new List<AutoResetEvent>();
        public FileStream Device;
    }

    private sealed class Job
    {
        public int Id;
        public Printer Printer;
        public MemoryStream Spool = new MemoryStream();
        public long Delivered;
        public bool Ended, Deleted, Printing, Printed, Retained;
        public long DeletedAtDelivered = -1;
        public SHA256 Hash = SHA256.Create();
    }

    private static readonly object Gate = new object();
    private static readonly Dictionary<string, Printer> Printers = new Dictionary<string, Printer>(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<long, Printer> Handles = new Dictionary<long, Printer>();
    private static readonly Dictionary<long, Job> HandleJobs = new Dictionary<long, Job>();
    private static readonly Dictionary<int, Job> Jobs = new Dictionary<int, Job>();
    private static readonly Dictionary<long, AutoResetEvent> Changes = new Dictionary<long, AutoResetEvent>();
    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private static long NextHandle = 0x1000;
    private static int NextJob = 1;
    private static StreamWriter Events;
    private static string OutDir;

    static FakeWinspool()
    {
        var config = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(
            File.ReadAllText(Environment.GetEnvironmentVariable("FAKE_WINSPOOL_CONFIG")));
        OutDir = Convert.ToString(config["out"]);
        Directory.CreateDirectory(OutDir);
        Events = new StreamWriter(Path.Combine(OutDir, "events.jsonl"), true, new UTF8Encoding(false)) { AutoFlush = true };
        foreach (var entry in (Dictionary<string, object>)config["printers"])
        {
            var settings = (Dictionary<string, object>)entry.Value;
            var printer = new Printer { Name = entry.Key };
            object value;
            if (settings.TryGetValue("rate", out value)) printer.Rate = Convert.ToInt32(value);
            if (settings.TryGetValue("deviceBuffer", out value)) printer.DeviceBuffer = Convert.ToInt32(value);
            if (settings.TryGetValue("direct", out value)) printer.Direct = Convert.ToBoolean(value);
            if (settings.TryGetValue("retainFails", out value)) printer.RetainFails = Convert.ToBoolean(value);
            if (settings.TryGetValue("releaseFails", out value)) printer.ReleaseFails = Convert.ToBoolean(value);
            if (settings.TryGetValue("partialWrite", out value)) printer.PartialWrite = Convert.ToInt32(value);
            if (settings.TryGetValue("stallAt", out value)) printer.StallAt = Convert.ToInt64(value);
            if (settings.TryGetValue("stallMs", out value)) printer.StallMs = Convert.ToInt32(value);
            if (settings.TryGetValue("externalCancelAt", out value)) printer.ExternalCancelAt = Convert.ToInt64(value);
            if (settings.TryGetValue("status", out value)) printer.Status = Convert.ToInt32(value);
            if (settings.TryGetValue("nextStatus", out value)) printer.NextStatus = Convert.ToInt32(value);
            if (settings.TryGetValue("statusAfterMs", out value)) printer.StatusAfterMs = Convert.ToInt32(value);
            if (settings.TryGetValue("statusDelayMs", out value)) printer.StatusDelayMs = Convert.ToInt32(value);
            printer.Device = new FileStream(Path.Combine(OutDir, printer.Name + ".bin"), FileMode.Create, FileAccess.Write, FileShare.Read);
            Printers[printer.Name] = printer;
            var thread = new Thread(() => Run(printer)) { IsBackground = true };
            thread.Start();
        }
    }

    public static void SetError(int code) { SetLastError(code); }

    private static void Log(string text) { lock (Events) Events.WriteLine("{\"t_ms\":" + Clock.ElapsedMilliseconds + "," + text + "}"); }

    private static void Notify(Printer printer) { foreach (var e in printer.Watchers) e.Set(); }

    private static void Deliver(Printer printer, Job job, byte[] bytes, int offset, int count)
    {
        printer.Device.Write(bytes, offset, count);
        printer.Device.Flush();
        File.AppendAllText(Path.Combine(OutDir, printer.Name + ".segments.jsonl"), "{\"job\":" + job.Id + ",\"length\":" + count + "}\n");
        printer.DeviceQueued += count;
        printer.DeviceTotal += count;
        job.Delivered += count;
    }

    // One loop per printer: the device prints at Rate; the spooler feeds the head job into it.
    private static void Run(Printer printer)
    {
        var last = Clock.Elapsed.TotalSeconds;
        while (true)
        {
            Thread.Sleep(5);
            lock (Gate)
            {
                if (!printer.StatusChanged && printer.StatusAfterMs >= 0 && Clock.ElapsedMilliseconds >= printer.StatusAfterMs)
                {
                    printer.StatusChanged = true;
                    printer.Status = printer.NextStatus;
                    Log("\"printer\":\"" + printer.Name + "\",\"event\":\"status_changed\"");
                    Notify(printer);
                }
                var elapsed = Clock.Elapsed.TotalSeconds - last;
                last += elapsed;
                if (!printer.Stalled && printer.StallAt >= 0 && printer.Consumed >= printer.StallAt)
                {
                    printer.Stalled = true;
                    Log("\"printer\":\"" + printer.Name + "\",\"event\":\"device_stall_start\",\"stall_ms\":" + printer.StallMs);
                    var until = Clock.ElapsedMilliseconds + printer.StallMs;
                    while (Clock.ElapsedMilliseconds < until) Monitor.Wait(Gate, (int)Math.Max(1, until - Clock.ElapsedMilliseconds));
                    Log("\"printer\":\"" + printer.Name + "\",\"event\":\"device_stall_end\"");
                    last = Clock.Elapsed.TotalSeconds;
                    elapsed = 0;
                }
                printer.Budget = Math.Min(printer.Budget + printer.Rate * elapsed, printer.Rate * 0.05);
                var print = (long)Math.Min(printer.Budget, printer.DeviceQueued);
                printer.DeviceQueued -= print;
                printer.Consumed += print;
                printer.Budget -= print;
                if (printer.Direct) { Monitor.PulseAll(Gate); continue; }
                var job = printer.Queue.Find(candidate => !candidate.Printed && !candidate.Deleted);
                if (job == null || job.Deleted) continue;
                var room = printer.DeviceBuffer - printer.DeviceQueued;
                var available = job.Spool.Length - job.Delivered;
                if (available > 0 && room > 0)
                {
                    if (!job.Printing)
                    {
                        job.Printing = true;
                        Log("\"printer\":\"" + printer.Name + "\",\"job\":" + job.Id + ",\"event\":\"printing\"");
                        Notify(printer);
                    }
                    var count = (int)Math.Min(available, room);
                    Deliver(printer, job, job.Spool.GetBuffer(), (int)job.Delivered, count);
                    if (!printer.ExternalCanceled && printer.ExternalCancelAt >= 0 && printer.DeviceTotal >= printer.ExternalCancelAt)
                    {
                        printer.ExternalCanceled = true;
                        Delete(job, "operator_cancel");
                        continue;
                    }
                }
                if (job.Ended && job.Delivered == job.Spool.Length && !job.Printed)
                {
                    job.Printed = true;
                    Log("\"printer\":\"" + printer.Name + "\",\"job\":" + job.Id + ",\"event\":\"printed\",\"bytes\":" + job.Delivered);
                    Notify(printer);
                    var done = job;
                    ThreadPool.QueueUserWorkItem(_ => { Thread.Sleep(100); lock (Gate) { if (!done.Retained) done.Printer.Queue.Remove(done); Notify(done.Printer); } });
                }
            }
        }
    }

    public static bool OpenPrinter(string name, out IntPtr handle)
    {
        lock (Gate)
        {
            Printer printer;
            if (!Printers.TryGetValue(name, out printer)) { handle = IntPtr.Zero; return false; }
            var id = NextHandle++;
            Handles[id] = printer;
            handle = new IntPtr(id);
            return true;
        }
    }

    public static bool ClosePrinter(IntPtr handle) { lock (Gate) { Handles.Remove(handle.ToInt64()); HandleJobs.Remove(handle.ToInt64()); } return true; }

    public static bool GetPrinter(IntPtr handle, IntPtr buffer, int size, out int needed)
    {
        int delay;
        lock (Gate) { delay = Handles[handle.ToInt64()].StatusDelayMs; }
        if (delay > 0) Thread.Sleep(delay);
        needed = Marshal.SizeOf(typeof(PrinterInfo2));
        lock (Gate)
        {
            if (buffer == IntPtr.Zero || size < needed) { SetError(122); return false; }
            var info = new PrinterInfo2 { Status = Handles[handle.ToInt64()].Status };
            Marshal.StructureToPtr(info, buffer, false);
            return true;
        }
    }

    public static int StartDocPrinter(IntPtr handle, string document, string datatype)
    {
        lock (Gate)
        {
            if (datatype != "RAW") return 0;
            var printer = Handles[handle.ToInt64()];
            var job = new Job { Id = NextJob++, Printer = printer };
            Jobs[job.Id] = job;
            HandleJobs[handle.ToInt64()] = job;
            printer.Queue.Add(job);
            Log("\"printer\":\"" + printer.Name + "\",\"job\":" + job.Id + ",\"event\":\"start_doc\",\"queue_position\":" + (printer.Queue.Count - 1));
            Notify(printer);
            return job.Id;
        }
    }

    public static bool StartPagePrinter(IntPtr handle) { lock (Gate) return !HandleJobs[handle.ToInt64()].Deleted; }
    public static bool EndPagePrinter(IntPtr handle) { lock (Gate) return !HandleJobs[handle.ToInt64()].Deleted; }

    public static bool WritePrinter(IntPtr handle, byte[] buffer, int count, out int written)
    {
        Job job;
        lock (Gate) job = HandleJobs[handle.ToInt64()];
        written = 0;
        if (!job.Printer.Direct)
        {
            lock (Gate)
            {
                if (job.Deleted) { SetError(63); return false; }
                if (job.Printer.PartialWrite > 0) count = Math.Min(count, job.Printer.PartialWrite);
                job.Spool.Write(buffer, 0, count);
                job.Hash.TransformBlock(buffer, 0, count, null, 0);
                written = count;
                return true;
            }
        }
        // Direct printing: the call blocks until the device has taken the bytes.
        lock (Gate)
        {
            job.Hash.TransformBlock(buffer, 0, count, null, 0);
            if (!job.Printing) { job.Printing = true; Log("\"printer\":\"" + job.Printer.Name + "\",\"job\":" + job.Id + ",\"event\":\"printing\""); Notify(job.Printer); }
            while (written < count)
            {
                if (job.Deleted) { SetError(63); return false; }
                var room = (int)(job.Printer.DeviceBuffer - job.Printer.DeviceQueued);
                if (room <= 0) { Monitor.Wait(Gate, 20); continue; }
                var take = Math.Min(room, count - written);
                Deliver(job.Printer, job, buffer, written, take);
                written += take;
            }
            return true;
        }
    }

    public static bool EndDocPrinter(IntPtr handle)
    {
        lock (Gate)
        {
            var job = HandleJobs[handle.ToInt64()];
            if (job.Deleted) { SetError(63); return false; }
            job.Ended = true;
            job.Hash.TransformFinalBlock(new byte[0], 0, 0);
            if (job.Printer.Direct) job.Spool.SetLength(job.Delivered);
            Log("\"printer\":\"" + job.Printer.Name + "\",\"job\":" + job.Id + ",\"event\":\"end_doc\",\"bytes\":" + (job.Printer.Direct ? job.Delivered : job.Spool.Length)
                + ",\"sha256\":\"" + BitConverter.ToString(job.Hash.Hash).Replace("-", "").ToLowerInvariant() + "\"");
            if (job.Printer.Direct && !job.Printed)
            {
                job.Printed = true;
                Log("\"printer\":\"" + job.Printer.Name + "\",\"job\":" + job.Id + ",\"event\":\"printed\",\"bytes\":" + job.Delivered);
                var done = job;
                ThreadPool.QueueUserWorkItem(_ => { Thread.Sleep(100); lock (Gate) { if (!done.Retained) done.Printer.Queue.Remove(done); Notify(done.Printer); } });
            }
            Notify(job.Printer);
            return true;
        }
    }

    public static bool AbortPrinter(IntPtr handle)
    {
        lock (Gate)
        {
            Job job;
            if (HandleJobs.TryGetValue(handle.ToInt64(), out job)) Delete(job, "abort_printer");
            return true;
        }
    }

    private static void Delete(Job job, string reason)
    {
        if (job.Deleted) return;
        job.Deleted = true;
        job.DeletedAtDelivered = job.Delivered;
        Log("\"printer\":\"" + job.Printer.Name + "\",\"job\":" + job.Id + ",\"event\":\"deleted\",\"reason\":\"" + reason + "\",\"was_printing\":"
            + (job.Printing && !job.Printed ? "true" : "false") + ",\"delivered\":" + job.Delivered + ",\"total\":" + job.Spool.Length + ",\"ended\":" + (job.Ended ? "true" : "false"));
        Monitor.PulseAll(Gate);
        Notify(job.Printer);
        var done = job;
        ThreadPool.QueueUserWorkItem(_ => { Thread.Sleep(50); lock (Gate) { done.Printer.Queue.Remove(done); Notify(done.Printer); } });
    }

    public static bool SetJob(IntPtr handle, int jobId, int command)
    {
        lock (Gate)
        {
            Job job;
            if (!Jobs.TryGetValue(jobId, out job) || !job.Printer.Queue.Contains(job)) { SetError(87); return false; }
            if (command == 8 && job.Printer.RetainFails || command == 9 && job.Printer.ReleaseFails) { SetError(5); return false; }
            if (command == 5) Delete(job, "set_job_delete");
            if (command == 8) { job.Retained = true; Log("\"event\":\"retain\",\"job\":" + job.Id); }
            if (command == 9) { job.Retained = false; if (job.Printed) job.Printer.Queue.Remove(job); Log("\"event\":\"release\",\"job\":" + job.Id); }
            return true;
        }
    }

    public static bool GetJob(IntPtr handle, int jobId, IntPtr buffer, int size, out int needed)
    {
        lock (Gate)
        {
            needed = 0;
            Job job;
            if (!Jobs.TryGetValue(jobId, out job) || !job.Printer.Queue.Contains(job)) { SetError(87); return false; }
            needed = Marshal.SizeOf(typeof(JobInfo1));
            if (buffer == IntPtr.Zero || size < needed) { SetError(122); return false; }
            var status = 0;
            if (!job.Ended) status |= SPOOLING;
            if (job.Printing && !job.Printed && !job.Deleted) status |= PRINTING;
            if (job.Printed) status |= PRINTED | COMPLETE;
            if (job.Deleted) status |= DELETED | DELETING;
            var info = new JobInfo1 { JobId = jobId, Status = status, Position = job.Printer.Queue.IndexOf(job) + 1 };
            Marshal.StructureToPtr(info, buffer, false);
            return true;
        }
    }

    public static IntPtr FindFirstChange(IntPtr printerHandle)
    {
        lock (Gate)
        {
            var id = NextHandle++;
            var signal = new AutoResetEvent(false);
            Changes[id] = signal;
            Handles[printerHandle.ToInt64()].Watchers.Add(signal);
            return new IntPtr(id);
        }
    }

    public static bool FindNextChange(IntPtr change, out int flags) { flags = 0x200; return true; }

    public static bool FindCloseChange(IntPtr change)
    {
        lock (Gate)
        {
            AutoResetEvent signal;
            if (!Changes.TryGetValue(change.ToInt64(), out signal)) return false;
            Changes.Remove(change.ToInt64());
            foreach (var printer in Printers.Values) printer.Watchers.Remove(signal);
            return true;
        }
    }

    public static uint WaitMany(IntPtr[] handles, uint milliseconds)
    {
        WaitHandle[] signals = new WaitHandle[handles.Length];
        lock (Gate)
        {
            for (int i = 0; i < handles.Length; i++) signals[i] = Changes[handles[i].ToInt64()];
        }
        return (uint)WaitHandle.WaitAny(signals, (int)milliseconds);
    }

    public static uint Wait(IntPtr handle, uint milliseconds)
    {
        AutoResetEvent signal;
        lock (Gate) { if (!Changes.TryGetValue(handle.ToInt64(), out signal)) return 0xFFFFFFFF; }
        return signal.WaitOne((int)milliseconds) ? 0u : 0x102u;
    }
}
