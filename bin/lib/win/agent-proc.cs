// agent-proc.cs — the Windows process helper of agent-dispatch (bin/lib/agent-core.mjs, "Windows" in its header).
//
// Windows has no process groups and no signals: Node's kill() is TerminateProcess on one pid, and a process tree
// keeps no link to a descendant whose parent ended. Node cannot reach the APIs that close those gaps, so the core
// compiles this file once with the csc.exe of .NET Framework 4 (part of every Windows 10 / 11) into its cache and
// runs it for:
//   ps                     every process as "pid ppid start" (start "-" when unreadable)
//   start <pid>...         one line per pid: its start time, or "-"
//   boot                   the boot id: "<BootId counter>-<creation time of the System process>", or "-"
//   run [options] <app> <cmdline>
//                          runs one command inside a Job Object of its own and waits for it. The job kills every
//                          process in it once its last handle closes (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) and allows
//                          no breakaway, so the command and everything it starts — also a descendant whose parent has
//                          ended — die with this helper, however it ends: one TerminateProcess to it stops the whole
//                          tree. When the command exits on its own, whatever it left in the job is terminated before
//                          the helper exits with the command's exit code.
//                          <app> and <cmdline> are base64 of UTF-8: the absolute path of the executable ("-": let
//                          CreateProcess search) and the full command line, quoted by the caller. The command gets the
//                          helper's environment, working directory, console and standard handles.
//                          --timeout MS     terminate the job MS after the helper started (0: no deadline)
//                          --stop-file F    terminate the job once file F exists (a job's terminal claim)
//                          --owner-log F    before the command starts, append this helper as a process group of the
//                                           job to the ownership log F (which must exist), as boundedExec's
//                                           supervisor does on POSIX
//                          --status-file F  write the outcome there as one JSON object before exiting
// A start time is "ft:<n>": the creation time from GetProcessTimes, in 100 ns units since 1601 (UTC). It is fixed when
// the process is created, so a clock step never changes it, and the pid of an ended process that Windows hands out
// again comes with another one.
//
// C# 5 only (the csc of .NET Framework 4): no string interpolation, no ?. operator.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class AgentProc
{
    const uint TH32CS_SNAPPROCESS = 0x2;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint CREATE_SUSPENDED = 0x4;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectExtendedLimitInformation = 9;
    const uint WAIT_OBJECT_0 = 0;
    const uint STILL_ACTIVE = 259;
    const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
    const uint HANDLE_FLAG_INHERIT = 1;
    const uint STARTF_USESTDHANDLES = 0x100;
    const uint FILE_APPEND_DATA = 0x4;
    const uint FILE_SHARE_ALL = 0x7;
    const uint OPEN_EXISTING = 3;
    static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr file, byte[] buffer, uint length, out uint written, IntPtr overlapped);

    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "ps") return Ps();
            if (args.Length >= 1 && args[0] == "start") return Start(args);
            if (args.Length == 1 && args[0] == "boot") return Boot();
            if (args.Length >= 1 && args[0] == "run") return Run(args);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("agent-proc: " + e.Message);
            return 125;
        }
        Console.Error.WriteLine("usage: agent-proc ps | start <pid>... | boot | run [--timeout MS] [--stop-file F] [--owner-log F] [--status-file F] <app-b64> <cmdline-b64>");
        return 125;
    }

    // ---- process identity ----

    static string StartOf(uint pid)
    {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return null;
        try
        {
            long creation, exit, kernel, user;
            uint code;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user) || creation <= 0) return null;
            // An ended process whose object someone still holds open: not alive, so no identity to confirm.
            if (!GetExitCodeProcess(process, out code) || code != STILL_ACTIVE && exit != 0) return null;
            return "ft:" + creation.ToString();
        }
        finally { CloseHandle(process); }
    }

    static string OwnStart()
    {
        long creation, exit, kernel, user;
        return GetProcessTimes(GetCurrentProcess(), out creation, out exit, out kernel, out user) ? "ft:" + creation.ToString() : null;
    }

    static int Ps()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE) return 1;
        StringBuilder text = new StringBuilder();
        try
        {
            PROCESSENTRY32W entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry))
            {
                string start = entry.th32ProcessID == 0 ? null : StartOf(entry.th32ProcessID);
                text.Append(entry.th32ProcessID).Append(' ').Append(entry.th32ParentProcessID).Append(' ').Append(start ?? "-").Append('\n');
            }
        }
        finally { CloseHandle(snapshot); }
        Console.Out.Write(text.ToString());
        return 0;
    }

    static int Start(string[] args)
    {
        StringBuilder text = new StringBuilder();
        for (int i = 1; i < args.Length; i++)
        {
            uint pid;
            string start = uint.TryParse(args[i], out pid) && pid > 0 ? StartOf(pid) : null;
            text.Append(start ?? "-").Append('\n');
        }
        Console.Out.Write(text.ToString());
        return 0;
    }

    // The BootId counter (incremented on every boot, also after a Fast Startup resume) together with the creation time
    // of the System process (pid 4, created once per kernel boot). Either part alone is enough; "-" when neither reads.
    static int Boot()
    {
        string counter = null;
        try
        {
            object value = Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters", "BootId", null);
            if (value is int) counter = ((uint)(int)value).ToString();
        }
        catch (Exception) { counter = null; }
        string kernel = StartOf(4);
        if (counter == null && kernel == null) { Console.Out.Write("-\n"); return 0; }
        Console.Out.Write((counter ?? "?") + "-" + (kernel ?? "?") + "\n");
        return 0;
    }

    // ---- run ----

    static string JsonString(string value)
    {
        if (value == null) return "null";
        StringBuilder text = new StringBuilder("\"");
        foreach (char c in value)
        {
            if (c == '"' || c == '\\') text.Append('\\').Append(c);
            else if (c < 0x20) text.Append("\\u").Append(((int)c).ToString("x4"));
            else text.Append(c);
        }
        return text.Append('"').ToString();
    }

    static string ErrorCode(int win32)
    {
        switch (win32)
        {
            case 2: case 3: return "ENOENT";
            case 5: return "EACCES";
            case 193: case 216: return "ENOEXEC";
            case 206: return "E2BIG";
            default: return "EWIN" + win32.ToString();
        }
    }

    static bool AppendLine(string file, string line)
    {
        IntPtr handle = CreateFileW(file, FILE_APPEND_DATA, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE) return false;
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes(line);
            uint written;
            return WriteFile(handle, bytes, (uint)bytes.Length, out written, IntPtr.Zero) && written == bytes.Length;
        }
        finally { CloseHandle(handle); }
    }

    static uint ActiveProcesses(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) return 0;
        return info.ActiveProcesses;
    }

    static int Run(string[] args)
    {
        DateTime started = DateTime.UtcNow;
        long timeoutMs = 0;
        string stopFile = null, ownerLog = null, statusFile = null;
        List<string> positional = new List<string>();
        for (int i = 1; i < args.Length; i++)
        {
            if (args[i] == "--timeout" && i + 1 < args.Length) timeoutMs = long.Parse(args[++i]);
            else if (args[i] == "--stop-file" && i + 1 < args.Length) stopFile = args[++i];
            else if (args[i] == "--owner-log" && i + 1 < args.Length) ownerLog = args[++i];
            else if (args[i] == "--status-file" && i + 1 < args.Length) statusFile = args[++i];
            else positional.Add(args[i]);
        }
        if (positional.Count != 2) throw new ArgumentException("run needs <app-b64> <cmdline-b64>");
        string app = positional[0] == "-" ? null : Encoding.UTF8.GetString(Convert.FromBase64String(positional[0]));
        string commandLine = Encoding.UTF8.GetString(Convert.FromBase64String(positional[1]));
        DateTime deadline = timeoutMs > 0 ? started.AddMilliseconds(timeoutMs) : DateTime.MaxValue;

        Outcome outcome = new Outcome();
        try
        {
            outcome.ExitCode = RunInJob(app, commandLine, deadline, stopFile, ownerLog, outcome);
        }
        catch (Exception e)
        {
            outcome.ErrorCode = "ESUPERVISOR";
            outcome.ErrorDetail = e.Message;
        }
        if (statusFile != null)
        {
            string json = "{\"status\":" + (outcome.ExitCode.HasValue ? outcome.ExitCode.Value.ToString() : "null") +
                ",\"timedOut\":" + (outcome.TimedOut ? "true" : "false") +
                ",\"stopped\":" + (outcome.Stopped ? "true" : "false") +
                ",\"pid\":" + (outcome.Pid.HasValue ? outcome.Pid.Value.ToString() : "null") +
                ",\"leftovers\":" + outcome.Leftovers.ToString() +
                ",\"survivors\":" + outcome.Survivors.ToString() +
                ",\"error\":" + (outcome.ErrorCode == null ? "null" : "{\"code\":" + JsonString(outcome.ErrorCode) + ",\"errno\":" + outcome.Errno.ToString() + ",\"detail\":" + JsonString(outcome.ErrorDetail) + "}") +
                "}\n";
            try { File.WriteAllText(statusFile, json, new UTF8Encoding(false)); } catch (Exception) { }
        }
        if (outcome.ErrorCode != null && !outcome.ExitCode.HasValue) return 125;
        return outcome.ExitCode.HasValue ? (int)outcome.ExitCode.Value : 1;
    }

    class Outcome
    {
        public uint? ExitCode;
        public uint? Pid;
        public bool TimedOut, Stopped;
        public uint Leftovers, Survivors;
        public string ErrorCode, ErrorDetail;
        public int Errno;
    }

    static uint? RunInJob(string app, string commandLine, DateTime deadline, string stopFile, string ownerLog, Outcome outcome)
    {
        if (ownerLog != null)
        {
            string line = "{\"groups\":[{\"pgid\":" + GetCurrentProcessId().ToString() + ",\"startedAt\":" + JsonString(OwnStart()) + "}],\"by\":\"exec\",\"at\":" + JsonString(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")) + "}\n";
            if (!AppendLine(ownerLog, line)) { outcome.ErrorCode = "ESUPERVISOR"; outcome.ErrorDetail = "its process group could not be recorded for the job"; return null; }
        }
        if (DateTime.UtcNow >= deadline)
        {
            outcome.TimedOut = true;
            outcome.ErrorCode = "ETIMEDOUT";
            outcome.ErrorDetail = "the deadline passed before the command started";
            return null;
        }

        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error().ToString());
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            throw new InvalidOperationException("SetInformationJobObject failed: " + Marshal.GetLastWin32Error().ToString());

        // The command gets this helper's standard handles, which must be inheritable for that.
        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        foreach (IntPtr handle in new IntPtr[] { startup.hStdInput, startup.hStdOutput, startup.hStdError })
            if (handle != IntPtr.Zero && handle != INVALID_HANDLE_VALUE) SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

        PROCESS_INFORMATION info;
        if (!CreateProcessW(app, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref startup, out info))
        {
            int error = Marshal.GetLastWin32Error();
            outcome.ErrorCode = ErrorCode(error);
            outcome.Errno = -error;
            outcome.ErrorDetail = "CreateProcess error " + error.ToString();
            CloseHandle(job);
            return null;
        }
        outcome.Pid = info.dwProcessId;
        // Into the job while still suspended: nothing it starts can be created outside it.
        if (!AssignProcessToJobObject(job, info.hProcess))
        {
            int error = Marshal.GetLastWin32Error();
            TerminateProcess(info.hProcess, 1);
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            CloseHandle(job);
            throw new InvalidOperationException("AssignProcessToJobObject failed: " + error.ToString());
        }
        ResumeThread(info.hThread);
        CloseHandle(info.hThread);

        while (WaitForSingleObject(info.hProcess, 50) != WAIT_OBJECT_0)
        {
            string why = null;
            if (DateTime.UtcNow >= deadline) { outcome.TimedOut = true; why = "timeout"; }
            else if (stopFile != null && File.Exists(stopFile)) { outcome.Stopped = true; why = "stop"; }
            if (why == null) continue;
            TerminateJobObject(job, 1);
            WaitForSingleObject(info.hProcess, 5000);
            break;
        }
        uint code;
        uint? exitCode = GetExitCodeProcess(info.hProcess, out code) && code != STILL_ACTIVE ? (uint?)code : null;
        CloseHandle(info.hProcess);
        if (outcome.TimedOut) { outcome.ErrorCode = "ETIMEDOUT"; }
        else if (outcome.Stopped) { outcome.ErrorCode = "ECANCELED"; outcome.ErrorDetail = "stopped: the job was cancelled"; }

        // What the command left behind in its job goes with it.
        outcome.Leftovers = ActiveProcesses(job);
        if (outcome.Leftovers > 0) TerminateJobObject(job, 1);
        for (int waited = 0; ActiveProcesses(job) > 0 && waited < 5000; waited += 20) Thread.Sleep(20);
        outcome.Survivors = ActiveProcesses(job);
        CloseHandle(job);
        return exitCode;
    }
}
