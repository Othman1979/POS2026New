using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

internal static class PosSpoolerPlatform
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly object OutputLock = new object();
    private static readonly object WatchLock = new object();
    private static long WatchGeneration = 0;
    private static Thread WatchThread;
    private static readonly object PrintLock = new object();
    private static readonly ManualResetEvent PrintsIdle = new ManualResetEvent(true);
    private static int ActivePrints = 0;
    private static readonly object ObservationLock = new object();
    private static readonly ManualResetEvent ObservationsIdle = new ManualResetEvent(true);
    private static readonly ManualResetEvent ObservationsStopping = new ManualResetEvent(false);
    private static int ActiveObservations;
    private static readonly string StatusInstance = Guid.NewGuid().ToString("N");
    private static long StatusSequence;

    private static void Write(object value)
    {
        lock (OutputLock)
        {
            Console.Out.WriteLine(Json.Serialize(value));
            Console.Out.Flush();
        }
    }

    private static string StateRootFromArgs(string[] args)
    {
        for (int index = 0; index + 1 < args.Length; index++)
        {
            if (String.Equals(args[index], "--state-root", StringComparison.Ordinal)) return args[index + 1];
        }
        throw new InvalidOperationException("STATE_ROOT_REQUIRED");
    }

    private static string MutexName(string stateRoot)
    {
        string canonical = Path.GetFullPath(stateRoot)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            .ToUpperInvariant();
        using (SHA256 hash = SHA256.Create())
        {
            byte[] digest = hash.ComputeHash(Encoding.UTF8.GetBytes(canonical));
            StringBuilder hex = new StringBuilder(digest.Length * 2);
            foreach (byte value in digest) hex.Append(value.ToString("x2"));
            return "Global\\POSAPP-Spooler-V2-" + hex.ToString();
        }
    }

    private static Dictionary<string, object> AsObject(object value)
    {
        Dictionary<string, object> result = value as Dictionary<string, object>;
        if (result == null) throw new InvalidOperationException("REQUEST_INVALID");
        return result;
    }

    private static string RequiredString(Dictionary<string, object> value, string name)
    {
        object raw;
        if (!value.TryGetValue(name, out raw) || raw == null || String.IsNullOrEmpty(Convert.ToString(raw)))
            throw new InvalidOperationException("REQUEST_INVALID");
        return Convert.ToString(raw);
    }

    private static string DeviceStatus(int status)
    {
        const int PRINTER_STATUS_ERROR = 0x00000002;
        const int PRINTER_STATUS_PAPER_JAM = 0x00000008;
        const int PRINTER_STATUS_PAPER_OUT = 0x00000010;
        const int PRINTER_STATUS_PAPER_PROBLEM = 0x00000040;
        const int PRINTER_STATUS_OFFLINE = 0x00000080;
        const int PRINTER_STATUS_DOOR_OPEN = 0x00400000;
        if (status == 0) return "unknown";
        if ((status & PRINTER_STATUS_PAPER_OUT) != 0) return "paper_out";
        if ((status & PRINTER_STATUS_PAPER_JAM) != 0) return "jammed";
        if ((status & PRINTER_STATUS_DOOR_OPEN) != 0) return "cover_open";
        if ((status & PRINTER_STATUS_PAPER_PROBLEM) != 0) return "paper_low";
        if ((status & PRINTER_STATUS_ERROR) != 0) return "error";
        if ((status & PRINTER_STATUS_OFFLINE) != 0) return "offline";
        return "ok";
    }

    private static string RequiredPath(Dictionary<string, object> value, string name)
    {
        string result = RequiredString(value, name);
        if (!Path.IsPathRooted(result)) throw new InvalidOperationException("REQUEST_INVALID");
        return Path.GetFullPath(result);
    }

    private static string[] PrinterNames(Dictionary<string, object> value)
    {
        object raw;
        if (!value.TryGetValue("printer_names", out raw) || !(raw is System.Collections.IList))
            throw new InvalidOperationException("REQUEST_INVALID");
        System.Collections.IList list = (System.Collections.IList)raw;
        if (list.Count > 64) throw new InvalidOperationException("REQUEST_INVALID");
        List<string> names = new List<string>();
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (object item in list)
        {
            string name = item as string;
            if (String.IsNullOrWhiteSpace(name) || name.Length > 255) throw new InvalidOperationException("REQUEST_INVALID");
            foreach (char letter in name) if (Char.IsControl(letter)) throw new InvalidOperationException("REQUEST_INVALID");
            if (seen.Add(name)) names.Add(name);
        }
        return names.ToArray();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DOC_INFO_1
    {
        public string pDocName;
        public string pOutputFile;
        public string pDataType;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PRINTER_INFO_2
    {
        public IntPtr pServerName;
        public IntPtr pPrinterName;
        public IntPtr pShareName;
        public IntPtr pPortName;
        public IntPtr pDriverName;
        public IntPtr pComment;
        public IntPtr pLocation;
        public IntPtr pDevMode;
        public IntPtr pSepFile;
        public IntPtr pPrintProcessor;
        public IntPtr pDatatype;
        public IntPtr pParameters;
        public IntPtr pSecurityDescriptor;
        public int Attributes;
        public int Priority;
        public int DefaultPriority;
        public int StartTime;
        public int UntilTime;
        public int Status;
        public int cJobs;
        public int AveragePPM;
    }

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int StartDocPrinter(IntPtr hPrinter, int level, ref DOC_INFO_1 documentInfo);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool AbortPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr hPrinter, byte[] buffer, int count, out int written);

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool SetJob(IntPtr hPrinter, int jobId, int level, IntPtr job, int command);
    private const int JOB_CONTROL_RETAIN = 8;
    private const int JOB_CONTROL_RELEASE = 9;
    private const int ERROR_INVALID_PARAMETER = 87;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;
    private const int JOB_STATUS_PRINTED = 0x00000080;
    private const int JOB_STATUS_DELETED = 0x00000100;
    private const int JOB_STATUS_DELETING = 0x00000004;
    private const int JOB_STATUS_COMPLETE = 0x00001000;
    private const int PRINTER_CHANGE_SET_JOB = 0x00000200;
    private const int PRINTER_CHANGE_DELETE_JOB = 0x00000400;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct JOB_INFO_1
    {
        public int JobId;
        public IntPtr pPrinterName;
        public IntPtr pMachineName;
        public IntPtr pUserName;
        public IntPtr pDocument;
        public IntPtr pDatatype;
        public IntPtr pStatus;
        public int Status;
        public int Priority;
        public int Position;
        public int TotalPages;
        public int PagesPrinted;
        public short Year;
        public short Month;
        public short DayOfWeek;
        public short Day;
        public short Hour;
        public short Minute;
        public short Second;
        public short Milliseconds;
    }

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool GetJob(IntPtr hPrinter, int jobId, int level, IntPtr job, int bufferSize, out int needed);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool GetPrinter(IntPtr hPrinter, int level, IntPtr buffer, int bufferSize, out int needed);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern IntPtr FindFirstPrinterChangeNotification(IntPtr hPrinter, int filter, int options, IntPtr notifyOptions);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool FindNextPrinterChangeNotification(IntPtr changeHandle, out int change, IntPtr options, IntPtr notifyInfo);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool FindClosePrinterChangeNotification(IntPtr changeHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);

    private static Dictionary<string, object> PrinterStatus(string name)
    {
        IntPtr printer = IntPtr.Zero;
        try
        {
            if (!OpenPrinter(name, out printer, IntPtr.Zero))
                return new Dictionary<string, object> { { "printer_name", name }, { "device_status", "offline" }, { "status_source", "os_reported" } };
            int needed;
            GetPrinter(printer, 2, IntPtr.Zero, 0, out needed);
            if (needed <= 0) throw new InvalidOperationException("PRINTER_STATUS_FAILED");
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetPrinter(printer, 2, buffer, needed, out needed)) throw new InvalidOperationException("PRINTER_STATUS_FAILED");
                PRINTER_INFO_2 info = (PRINTER_INFO_2)Marshal.PtrToStructure(buffer, typeof(PRINTER_INFO_2));
                return new Dictionary<string, object> {
                    { "printer_name", name }, { "device_status", DeviceStatus(info.Status) },
                    { "status_code", info.Status }, { "status_source", "os_reported" }
                };
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { if (printer != IntPtr.Zero) ClosePrinter(printer); }
    }

    private static int ClampDrainMs(Dictionary<string, object> payload)
    {
        int drain = 120000;
        object raw;
        if (payload.TryGetValue("drain_ms", out raw) && raw != null)
        {
            try { drain = Convert.ToInt32(raw); }
            catch { drain = 120000; }
        }
        if (drain < 2000) return 2000;
        if (drain > 300000) return 300000;
        return drain;
    }

    private static string DrainStrategy(Dictionary<string, object> payload)
    {
        object raw;
        if (payload.TryGetValue("drain_strategy", out raw)
            && String.Equals(Convert.ToString(raw), "poll", StringComparison.OrdinalIgnoreCase)) return "poll";
        return "notify";
    }

    private static bool ValidChangeHandle(IntPtr handle)
    {
        return handle != IntPtr.Zero && handle != InvalidHandleValue;
    }

    private static bool NotificationEligible(string printerName)
    {
        // Remote queue notification setup may block on network/provider state.
        // Keep UNC shares on the bounded polling path.
        return !printerName.StartsWith("\\\\", StringComparison.Ordinal);
    }

    private static bool OptionalBool(Dictionary<string, object> payload, string name, bool fallback)
    {
        object raw;
        if (!payload.TryGetValue(name, out raw) || raw == null) return fallback;
        try { return Convert.ToBoolean(raw); } catch { return fallback; }
    }

    // One bounded observation window. Expiry with the job still queued is "queued":
    // the OS owns the job and will print it when the device recovers, so the caller
    // simply observes again. Nothing here ever cancels an OS job. RETAIN keeps normal
    // completion visible long enough to tell it apart from a cancellation.
    private static string WaitForLocalQueueDrain(IntPtr printer, int jobId, int drainMs,
        IntPtr changeNotification, string requestedStrategy, out string waitMode)
    {
        int started = Environment.TickCount;
        bool useNotifications = requestedStrategy == "notify" && ValidChangeHandle(changeNotification);
        waitMode = useNotifications ? "notification" : requestedStrategy == "notify" ? "poll_fallback" : "poll";
        while (!ObservationsStopping.WaitOne(0) && unchecked(Environment.TickCount - started) < drainMs)
        {
            int needed;
            bool sized = GetJob(printer, jobId, 1, IntPtr.Zero, 0, out needed);
            int error = Marshal.GetLastWin32Error();
            if (!sized && error == ERROR_INVALID_PARAMETER) return "job_missing";
            if (!sized && (error != ERROR_INSUFFICIENT_BUFFER || needed <= 0)) return "drain_unknown";
            if (needed <= 0) return "drain_unknown";
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetJob(printer, jobId, 1, buffer, needed, out needed))
                {
                    if (Marshal.GetLastWin32Error() == ERROR_INVALID_PARAMETER) return "job_missing";
                    return "drain_unknown";
                }
                JOB_INFO_1 info = (JOB_INFO_1)Marshal.PtrToStructure(buffer, typeof(JOB_INFO_1));
                int status = info.Status;
                if ((status & (JOB_STATUS_DELETED | JOB_STATUS_DELETING)) != 0) return "job_deleted";
                if ((status & (JOB_STATUS_PRINTED | JOB_STATUS_COMPLETE)) != 0)
                    return "drained";
            }
            finally { Marshal.FreeHGlobal(buffer); }
            int remaining = drainMs - unchecked(Environment.TickCount - started);
            if (remaining <= 0) break;
            int waitMs = remaining < 400 ? remaining : 400;
            if (!useNotifications)
            {
                ObservationsStopping.WaitOne(waitMs);
                continue;
            }
            uint waitResult = WaitForSingleObject(changeNotification, Convert.ToUInt32(waitMs));
            if (waitResult == WAIT_TIMEOUT) continue;
            if (waitResult == WAIT_OBJECT_0)
            {
                int change;
                if (FindNextPrinterChangeNotification(changeNotification, out change, IntPtr.Zero, IntPtr.Zero)) continue;
            }
            useNotifications = false;
            waitMode = "poll_fallback";
        }
        return "queued";
    }

    // Observe an already submitted job for one window. The document was handed to the
    // spooler in full by print_raw, so every outcome here leaves the stream intact.
    private static Dictionary<string, object> WaitJob(Dictionary<string, object> payload)
    {
        string name = RequiredString(payload, "printer_name");
        int jobId = Convert.ToInt32(RequiredString(payload, "job_id"));
        bool retained = OptionalBool(payload, "retained", true);
        string drainStrategy = DrainStrategy(payload);
        IntPtr printer = IntPtr.Zero;
        IntPtr drainNotification = IntPtr.Zero;
        try
        {
            if (!OpenPrinter(name, out printer, IntPtr.Zero)) throw new InvalidOperationException("WINspool_OPEN_FAILED");
            if (drainStrategy == "notify" && NotificationEligible(name))
            {
                IntPtr candidate = FindFirstPrinterChangeNotification(
                    printer, PRINTER_CHANGE_SET_JOB | PRINTER_CHANGE_DELETE_JOB, 0, IntPtr.Zero);
                if (ValidChangeHandle(candidate)) drainNotification = candidate;
            }
            string drainWaitMode;
            string drain = WaitForLocalQueueDrain(
                printer, jobId, ClampDrainMs(payload), drainNotification, drainStrategy, out drainWaitMode);
            if (drain == "job_deleted") throw new InvalidOperationException("WINspool_JOB_DELETED");
            if (drain == "drain_unknown") throw new InvalidOperationException("WINspool_DRAIN_UNKNOWN");
            bool unretainedCompletion = false;
            if (drain == "job_missing")
            {
                // A retained job cannot vanish on its own; without retention the
                // spooler removes a printed job at once, so "gone" is the completion.
                if (retained) throw new InvalidOperationException("WINspool_JOB_MISSING");
                drain = "drained";
                unretainedCompletion = true;
            }
            // RELEASE removes retention only after the provider reports completion;
            // it does not interrupt the printing stream. Failure must not reprint.
            bool released = drain == "drained" && retained ? SetJob(printer, jobId, 0, IntPtr.Zero, JOB_CONTROL_RELEASE) : true;
            return new Dictionary<string, object> {
                { "job_id", jobId }, { "device_status", drain }, { "drain_wait_mode", drainWaitMode },
                { "retention_released", released }, { "unretained_completion", unretainedCompletion }
            };
        }
        finally
        {
            if (ValidChangeHandle(drainNotification)) FindClosePrinterChangeNotification(drainNotification);
            if (printer != IntPtr.Zero) ClosePrinter(printer);
        }
    }

    private static Dictionary<string, object> PrintRaw(Dictionary<string, object> payload)
    {
        string name = RequiredString(payload, "printer_name");
        string artifactPath = RequiredPath(payload, "artifact_path");
        string expectedHash = RequiredString(payload, "artifact_sha256").ToLowerInvariant();
        if (!File.Exists(artifactPath) || expectedHash.Length != 64) throw new InvalidOperationException("ARTIFACT_INVALID");
        object rawQueueId;
        string queueId = payload.TryGetValue("queue_id", out rawQueueId) && rawQueueId != null ? Convert.ToString(rawQueueId) : "";
        IntPtr printer = IntPtr.Zero;
        bool documentStarted = false;
        bool writeAttempted = false;
        try
        {
            using (FileStream input = new FileStream(artifactPath, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.SequentialScan))
            using (SHA256 sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(input);
                string actualHash = BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
                if (!String.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("ARTIFACT_HASH_MISMATCH");
                input.Position = 0;
                if (!OpenPrinter(name, out printer, IntPtr.Zero)) throw new InvalidOperationException("WINspool_OPEN_FAILED");
                DOC_INFO_1 document = new DOC_INFO_1 {
                    pDocName = queueId.Length > 0 ? "POSAPP V2 Print Job #" + queueId : "POSAPP V2 Print Job",
                    pDataType = "RAW", pOutputFile = null
                };
                int jobId = StartDocPrinter(printer, 1, ref document);
                if (jobId <= 0) throw new InvalidOperationException("WINspool_START_DOC_FAILED");
                documentStarted = true;
                // A provider without retention still prints; completion is then inferred
                // from the job leaving the queue, and the caller records the weaker proof.
                bool retained = SetJob(printer, jobId, 0, IntPtr.Zero, JOB_CONTROL_RETAIN);
                if (!StartPagePrinter(printer)) throw new InvalidOperationException("WINspool_START_PAGE_FAILED");
                byte[] buffer = new byte[64 * 1024];
                long accepted = 0;
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    int offset = 0;
                    while (offset < read)
                    {
                        int remaining = read - offset;
                        byte[] segment = buffer;
                        if (offset > 0)
                        {
                            segment = new byte[remaining];
                            Buffer.BlockCopy(buffer, offset, segment, 0, remaining);
                        }
                        int written;
                        writeAttempted = true;
                        if (!WritePrinter(printer, segment, remaining, out written) || written <= 0)
                            throw new InvalidOperationException("WINspool_WRITE_FAILED");
                        offset += written;
                        accepted += written;
                    }
                }
                if (!EndPagePrinter(printer)) throw new InvalidOperationException("WINspool_END_PAGE_FAILED");
                if (!EndDocPrinter(printer)) throw new InvalidOperationException("WINspool_END_DOC_FAILED");
                documentStarted = false;
                // EndDoc handed every byte to Winspool: the job is submitted and the
                // caller persists that before observing it with wait_job.
                return new Dictionary<string, object> {
                    { "job_id", jobId }, { "bytes_accepted", accepted }, { "artifact_sha256", actualHash },
                    { "device_status", "submitted" }, { "retained", retained }
                };
            }
        }
        finally
        {
            // Only an empty, pre-write document can safely be aborted by us.
            // A write error may follow partial delivery even when written == 0.
            if (documentStarted && !writeAttempted && printer != IntPtr.Zero) AbortPrinter(printer);
            if (printer != IntPtr.Zero) ClosePrinter(printer);
        }
    }

    private static void StopWatch()
    {
        lock (WatchLock) { Interlocked.Increment(ref WatchGeneration); }
        if (WatchThread != null && WatchThread.IsAlive) WatchThread.Join(1500);
        WatchThread = null;
    }

    private static void StartWatch(string[] names)
    {
        StopWatch();
        if (names.Length == 0) return;
        long myGeneration;
        lock (WatchLock) { myGeneration = Interlocked.Increment(ref WatchGeneration); }
        WatchThread = new Thread(() => {
            while (Volatile.Read(ref WatchGeneration) == myGeneration)
            {
                List<IntPtr> handles = new List<IntPtr>();
                List<string> watchedNames = new List<string>();
                List<IntPtr> printers = new List<IntPtr>();
                int openedAt = Environment.TickCount;
                try
                {
                    foreach (string name in names)
                    {
                        if (Volatile.Read(ref WatchGeneration) != myGeneration) break;
                        IntPtr printer;
                        if (OpenPrinter(name, out printer, IntPtr.Zero))
                        {
                            IntPtr change = FindFirstPrinterChangeNotification(printer, 0x000000FF, 0, IntPtr.Zero);
                            if (ValidChangeHandle(change)) { handles.Add(change); watchedNames.Add(name); printers.Add(printer); }
                            else ClosePrinter(printer);
                        }
                        var initial = ObservedPrinterStatus(name);
                        if (Volatile.Read(ref WatchGeneration) == myGeneration)
                            Write(new Dictionary<string, object> { { "type", "event" }, { "event", "printer_status" }, { "status", initial } });
                    }
                    IntPtr[] waitHandles = handles.ToArray();
                    while (Volatile.Read(ref WatchGeneration) == myGeneration)
                    {
                        // Wait on all 64 supported printers together. The short
                        // watchdog only bounds shutdown/reconfiguration; a status
                        // event wakes immediately, independent of printer count.
                        if (waitHandles.Length == 0) Thread.Sleep(250);
                        uint result = waitHandles.Length == 0 ? WAIT_TIMEOUT
                            : WaitForMultipleObjects(Convert.ToUInt32(waitHandles.Length), waitHandles, false, 250);
                        if (Volatile.Read(ref WatchGeneration) != myGeneration) break;
                        if (result == WAIT_TIMEOUT)
                        {
                            if (handles.Count < names.Length && unchecked(Environment.TickCount - openedAt) >= 30000) break;
                            continue;
                        }
                        if (result >= waitHandles.Length) break;
                        int change;
                        if (!FindNextPrinterChangeNotification(waitHandles[result], out change, IntPtr.Zero, IntPtr.Zero)) break;
                        var status = ObservedPrinterStatus(watchedNames[(int)result]);
                        if (Volatile.Read(ref WatchGeneration) == myGeneration)
                            Write(new Dictionary<string, object> { { "type", "event" }, { "event", "printer_status" }, { "status", status } });
                    }
                }
                catch (IOException) { return; }
                finally
                {
                    foreach (IntPtr handle in handles) FindClosePrinterChangeNotification(handle);
                    foreach (IntPtr printer in printers) ClosePrinter(printer);
                }
                // Missing queues/unsupported notifications retry without a spin
                // or a new helper request every two seconds.
                while (Volatile.Read(ref WatchGeneration) == myGeneration && unchecked(Environment.TickCount - openedAt) < 30000)
                    Thread.Sleep(250);
            }
        });
        WatchThread.IsBackground = true;
        WatchThread.Start();
    }

    private static Dictionary<string, object> ObservedPrinterStatus(string name)
    {
        long sequence = Interlocked.Increment(ref StatusSequence);
        Dictionary<string, object> status;
        try { status = PrinterStatus(name); }
        catch (InvalidOperationException error)
        {
            status = new Dictionary<string, object> { { "printer_name", name }, { "device_status", "unknown" },
                { "status_source", "os_reported" }, { "error_code", error.Message } };
        }
        status["observation_instance"] = StatusInstance;
        status["observation_sequence"] = sequence;
        return status;
    }

    private static object Execute(string command, Dictionary<string, object> payload)
    {
        if (command == "protect")
        {
            byte[] plaintext = Convert.FromBase64String(RequiredString(payload, "value"));
            byte[] ciphertext = ProtectedData.Protect(plaintext, null, DataProtectionScope.LocalMachine);
            return new Dictionary<string, object> { { "value", Convert.ToBase64String(ciphertext) } };
        }
        if (command == "unprotect")
        {
            byte[] ciphertext = Convert.FromBase64String(RequiredString(payload, "value"));
            byte[] plaintext = ProtectedData.Unprotect(ciphertext, null, DataProtectionScope.LocalMachine);
            return new Dictionary<string, object> { { "value", Convert.ToBase64String(plaintext) } };
        }
        if (command == "print_raw") return PrintRaw(payload);
        if (command == "wait_job") return WaitJob(payload);
        if (command == "printer_status") return PrinterStatus(RequiredString(payload, "printer_name"));
        if (command == "watch_printers")
        {
            string[] names = PrinterNames(payload);
            StartWatch(names);
            // Initial snapshots arrive on the same event stream as changes. A
            // slow GetPrinter provider must not block the command reader or be
            // queried twice during watch setup.
            return new Dictionary<string, object> { { "statuses", new object[0] } };
        }
        throw new InvalidOperationException("COMMAND_UNSUPPORTED");
    }

    private static void ExecuteAndWrite(object id, string command, Dictionary<string, object> payload)
    {
        try
        {
            Write(new Dictionary<string, object> { { "id", id }, { "result", Execute(command, payload) } });
        }
        catch (Exception error)
        {
            string code = error is CryptographicException ? "DPAPI_FAILED" : error.Message;
            Write(new Dictionary<string, object> {
                { "id", id },
                { "error", new Dictionary<string, object> { { "code", code } } }
            });
        }
    }

    private static void ObservationFinished()
    {
        lock (ObservationLock) { ActiveObservations--; if (ActiveObservations == 0) ObservationsIdle.Set(); }
    }

    private static void StartObservation(object id, Dictionary<string, object> payload)
    {
        lock (ObservationLock)
        {
            if (ActiveObservations >= 64) throw new InvalidOperationException("PLATFORM_HELPER_BUSY");
            ActiveObservations++;
            ObservationsIdle.Reset();
        }
        try
        {
            // A native wait must not occupy the protocol reader or starve the
            // pool that delivers print_raw on another printer. The Node endpoint
            // lanes already admit at most one observation per physical printer.
            Thread observer = new Thread(() => {
                try { ExecuteAndWrite(id, "wait_job", payload); }
                catch (IOException) { /* Parent exited; release observation handles. */ }
                finally { ObservationFinished(); }
            });
            observer.IsBackground = true;
            observer.Start();
        }
        catch { ObservationFinished(); throw; }
    }

    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        Mutex stateMutex = null;
        bool ownsMutex = false;
        try
        {
            bool createdNew;
            stateMutex = new Mutex(true, MutexName(StateRootFromArgs(args)), out createdNew);
            ownsMutex = createdNew;
            if (!createdNew)
            {
                Write(new Dictionary<string, object> { { "type", "fatal" }, { "code", "STATE_ROOT_LOCKED" } });
                return 73;
            }

            Write(new Dictionary<string, object> { { "type", "ready" } });
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                object id = null;
                string command = null;
                Dictionary<string, object> payload = null;
                try
                {
                    Dictionary<string, object> request = AsObject(Json.DeserializeObject(line));
                    request.TryGetValue("id", out id);
                    command = RequiredString(request, "command");
                    object rawPayload;
                    payload = request.TryGetValue("payload", out rawPayload)
                        ? AsObject(rawPayload)
                        : new Dictionary<string, object>();
                    object capturedId = id;
                    string capturedCommand = command;
                    Dictionary<string, object> capturedPayload = payload;
                    if (capturedCommand == "print_raw")
                    {
                        lock (PrintLock) { ActivePrints++; PrintsIdle.Reset(); }
                        ThreadPool.QueueUserWorkItem(state => {
                            try { ExecuteAndWrite(capturedId, capturedCommand, capturedPayload); }
                            catch (IOException) { /* Parent exited; finish native delivery before releasing the mutex. */ }
                            finally { lock (PrintLock) { ActivePrints--; if (ActivePrints == 0) PrintsIdle.Set(); } }
                        });
                    }
                    else if (capturedCommand == "wait_job")
                        StartObservation(capturedId, capturedPayload);
                    else
                        ExecuteAndWrite(capturedId, capturedCommand, capturedPayload);
                }
                catch (Exception error)
                {
                    string code = error is CryptographicException ? "DPAPI_FAILED" : error.Message;
                    Write(new Dictionary<string, object> {
                        { "id", id },
                        { "error", new Dictionary<string, object> { { "code", code } } }
                    });
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            Write(new Dictionary<string, object> { { "type", "fatal" }, { "code", error.Message } });
            return 74;
        }
        finally
        {
            // EOF and reader failures must both preserve an active native write.
            ObservationsStopping.Set();
            PrintsIdle.WaitOne();
            ObservationsIdle.WaitOne();
            StopWatch();
            if (ownsMutex && stateMutex != null) stateMutex.ReleaseMutex();
            if (stateMutex != null) stateMutex.Dispose();
        }
    }
}
