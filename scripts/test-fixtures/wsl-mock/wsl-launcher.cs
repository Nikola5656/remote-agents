// Compiled by test-wsl-helpers.ps1 into a temp-dir wsl.exe on Windows.
// A .cmd shim cannot stand in for wsl.exe: cmd.exe re-parses %* and strips
// embedded quotes, so argv fidelity requires a real executable that receives
// CRT-parsed argv and re-quotes it for the child command line.
// Forwards to: %RA_WSL_MOCK_PWSH% -NoProfile -NonInteractive -File %RA_WSL_MOCK_PS1% <argv...>
using System;
using System.Diagnostics;
using System.Text;

static class WslLauncher
{
    static int Main(string[] args)
    {
        string pwsh = Environment.GetEnvironmentVariable("RA_WSL_MOCK_PWSH");
        string script = Environment.GetEnvironmentVariable("RA_WSL_MOCK_PS1");
        if (string.IsNullOrEmpty(pwsh) || string.IsNullOrEmpty(script))
        {
            Console.Error.WriteLine("wsl-launcher: RA_WSL_MOCK_PWSH and RA_WSL_MOCK_PS1 must be set");
            return 66;
        }
        var commandLine = new StringBuilder();
        AppendArgument(commandLine, "-NoProfile");
        AppendArgument(commandLine, "-NonInteractive");
        AppendArgument(commandLine, "-File");
        AppendArgument(commandLine, script);
        foreach (string arg in args) AppendArgument(commandLine, arg);

        var startInfo = new ProcessStartInfo(pwsh, commandLine.ToString()) { UseShellExecute = false };
        using (Process child = Process.Start(startInfo))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    // Windows CRT quoting: backslashes are literal unless they precede a quote
    // or the closing quote, where they must be doubled; embedded quotes are
    // backslash-escaped. Never route through a shell.
    static void AppendArgument(StringBuilder commandLine, string arg)
    {
        if (commandLine.Length > 0) commandLine.Append(' ');
        bool needsQuotes = arg.Length == 0 || arg.IndexOfAny(new[] { ' ', '\t', '"' }) >= 0;
        if (!needsQuotes)
        {
            commandLine.Append(arg);
            return;
        }
        commandLine.Append('"');
        int pendingBackslashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { pendingBackslashes++; continue; }
            if (c == '"')
            {
                commandLine.Append('\\', pendingBackslashes * 2 + 1).Append('"');
                pendingBackslashes = 0;
                continue;
            }
            commandLine.Append('\\', pendingBackslashes).Append(c);
            pendingBackslashes = 0;
        }
        commandLine.Append('\\', pendingBackslashes * 2).Append('"');
    }
}
