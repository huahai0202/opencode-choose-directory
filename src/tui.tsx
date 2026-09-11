/** @jsxImportSource @opentui/solid */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { Plugin } from "@opencode-ai/plugin/tui"
import type { Context } from "@opencode-ai/plugin/tui/context"

const execFileAsync = promisify(execFile)
const BEGIN_MARKER = "__OPENCODE_DIRECTORY_BEGIN__"
const END_MARKER = "__OPENCODE_DIRECTORY_END__"
const CANCEL_MARKER = "__OPENCODE_DIRECTORY_CANCEL__"
const READY_MARKER = "__OPENCODE_PICKER_READY__"
const QUIT_COMMAND = "__OPENCODE_PICKER_QUIT__"

// The native Windows common dialog in folder mode. This provides the
// Explorer-style navigation UI instead of the legacy WinForms tree dialog.
const CSHARP_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;

public static class OpenCodeFolderPicker
{
    private const uint FOS_PICKFOLDERS = 0x20;
    private const uint FOS_FORCEFILESYSTEM = 0x40;
    private const uint FOS_PATHMUSTEXIST = 0x800;

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    [ComImport]
    [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr specs);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder([MarshalAs(UnmanagedType.Interface)] IShellItem item);
        void SetFolder([MarshalAs(UnmanagedType.Interface)] IShellItem item);
        void GetFolder([MarshalAs(UnmanagedType.Interface)] out IShellItem item);
        void GetCurrentSelection([MarshalAs(UnmanagedType.Interface)] out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void GetResult([MarshalAs(UnmanagedType.Interface)] out IShellItem item);
        void AddPlace([MarshalAs(UnmanagedType.Interface)] IShellItem item, int placement);
        void RemovePlace([MarshalAs(UnmanagedType.Interface)] IShellItem item);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr bindingContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr result);
        void GetParent([MarshalAs(UnmanagedType.Interface)] out IShellItem parent);
        void GetDisplayName(SIGDN nameType, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare([MarshalAs(UnmanagedType.Interface)] IShellItem item, uint hint, out int order);
    }

    private enum SIGDN : uint
    {
        FILESYSPATH = 0x80058000
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bindingContext,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    public static string Pick(string initialDirectory, string title, string okButtonLabel)
    {
        IFileDialog dialog = null;
        IShellItem initial = null;
        IShellItem result = null;
        IntPtr displayName = IntPtr.Zero;

        try
        {
            dialog = (IFileDialog)new FileOpenDialog();
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            dialog.SetTitle(title);
            dialog.SetOkButtonLabel(okButtonLabel);

            if (!String.IsNullOrEmpty(initialDirectory) && System.IO.Directory.Exists(initialDirectory))
            {
                Guid shellItemId = typeof(IShellItem).GUID;
                if (SHCreateItemFromParsingName(initialDirectory, IntPtr.Zero, ref shellItemId, out initial) == 0 && initial != null)
                {
                    dialog.SetFolder(initial);
                }
            }

            if (dialog.Show(IntPtr.Zero) != 0) return null;
            dialog.GetResult(out result);
            result.GetDisplayName(SIGDN.FILESYSPATH, out displayName);
            return displayName == IntPtr.Zero ? null : Marshal.PtrToStringUni(displayName);
        }
        finally
        {
            if (displayName != IntPtr.Zero) Marshal.FreeCoTaskMem(displayName);
            if (result != null) Marshal.FinalReleaseComObject(result);
            if (initial != null) Marshal.FinalReleaseComObject(initial);
            if (dialog != null) Marshal.FinalReleaseComObject(dialog);
        }
    }
}
`

// One-shot fallback: starts a fresh process, compiles the helper, shows the
// dialog once, and exits. Used only when the warm worker cannot start.
function buildOneShotScript() {
  return `$ErrorActionPreference = "Stop"

$source = @'
${CSHARP_SOURCE}'@

Add-Type -TypeDefinition $source -ErrorAction Stop
$selected = [OpenCodeFolderPicker]::Pick(
  $env:OPENCODE_INITIAL_DIRECTORY,
  $env:OPENCODE_PICKER_TITLE,
  $env:OPENCODE_PICKER_OK_LABEL
)
if ($selected) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($selected)
  Write-Output "${BEGIN_MARKER}"
  Write-Output ([System.Convert]::ToBase64String($bytes))
  Write-Output "${END_MARKER}"
}
`
}

// Warm worker: compiles the helper once, announces READY, then serves dialog
// requests read from stdin. The initial directory travels as a Base64 line so
// the worker never needs to restart.
function buildWorkerScript() {
  return `$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$source = @'
${CSHARP_SOURCE}'@

Add-Type -TypeDefinition $source -ErrorAction Stop

[Console]::Out.WriteLine("${READY_MARKER}")
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  if ($line -eq "${QUIT_COMMAND}") { break }

  $initial = ""
  try {
    $initial = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($line))
  } catch {
    $initial = ""
  }

  $selected = $null
  try {
    $selected = [OpenCodeFolderPicker]::Pick($initial, $env:OPENCODE_PICKER_TITLE, $env:OPENCODE_PICKER_OK_LABEL)
  } catch {
    $selected = $null
  }

  if ($selected) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($selected)
    [Console]::Out.WriteLine("${BEGIN_MARKER}")
    [Console]::Out.WriteLine([System.Convert]::ToBase64String($bytes))
    [Console]::Out.WriteLine("${END_MARKER}")
  } else {
    [Console]::Out.WriteLine("${CANCEL_MARKER}")
  }
  [Console]::Out.Flush()
}
`
}

function powershellPath() {
  return process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe"
}

function encodePowerShellCommand(script: string) {
  return Buffer.from(script, "utf16le").toString("base64")
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function decodeStdout(output: string | Uint8Array) {
  return typeof output === "string" ? output : Buffer.from(output).toString("utf8")
}

function readSelectedPath(stdout: string) {
  const lines = stdout.split(/\r?\n/).map((line: string) => line.trim())
  const begin = lines.indexOf(BEGIN_MARKER)
  const end = lines.indexOf(END_MARKER, begin + 1)
  if (begin < 0 || end <= begin + 1) return undefined

  const encodedPath = lines.slice(begin + 1, end).join("")
  if (!encodedPath) return undefined
  return Buffer.from(encodedPath, "base64").toString("utf8").trim() || undefined
}

async function pickDirectoryOnce(initialDirectory: string) {
  const result = await execFileAsync(
    powershellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encodePowerShellCommand(buildOneShotScript()),
    ],
    {
      env: {
        ...process.env,
        OPENCODE_INITIAL_DIRECTORY: initialDirectory,
        OPENCODE_PICKER_TITLE: "选择工作目录",
        OPENCODE_PICKER_OK_LABEL: "选择文件夹",
      },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  )

  return readSelectedPath(decodeStdout((result as { stdout: string | Uint8Array }).stdout))
}

interface PendingPick {
  resolve: (value: string | undefined) => void
  reject: (error: Error) => void
  captured: string[]
  capturing: boolean
  settled: boolean
}

interface WorkerHandle {
  child: ChildProcessWithoutNullStreams
  ready: Promise<void>
  markReady: () => void
  failReady: (error: Error) => void
  readySettled: boolean
  buffer: string
  pending: PendingPick | undefined
}

/**
 * Keeps one hidden PowerShell process alive with the COM helper already
 * compiled, so opening the native folder picker skips process startup and
 * `Add-Type` compilation on every click.
 */
class DirectoryPicker {
  private handle: WorkerHandle | undefined
  private disposed = false

  constructor(
    private readonly command: string,
    private readonly script: string,
    private readonly title: string,
    private readonly okLabel: string,
  ) {}

  /** Starts the worker ahead of the first click; failures are silent. */
  warm() {
    if (this.disposed) return
    void this.ensure().catch(() => {})
  }

  async pick(initialDirectory: string) {
    const handle = await this.ensure()
    if (this.handle !== handle) throw new Error("Directory picker restarted")
    if (handle.pending) throw new Error("Directory picker is already open")

    const result = new Promise<string | undefined>((resolve, reject) => {
      handle.pending = { resolve, reject, captured: [], capturing: false, settled: false }
    })
    try {
      handle.child.stdin.write(`${Buffer.from(initialDirectory, "utf8").toString("base64")}\n`)
    } catch (error) {
      this.fail(handle, error instanceof Error ? error : new Error(String(error)))
    }
    return result
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    const handle = this.handle
    this.handle = undefined
    if (!handle) return

    this.fail(handle, new Error("Directory picker disposed"))
    try {
      handle.child.stdin.write(`${QUIT_COMMAND}\n`)
      handle.child.stdin.end()
    } catch {
      // The pipe may already be closed; the kill below is the backstop.
    }
    setTimeout(() => {
      if (!handle.child.killed) handle.child.kill()
    }, 250)
  }

  private ensure(): Promise<WorkerHandle> {
    if (this.disposed) return Promise.reject(new Error("Directory picker disposed"))
    const existing = this.handle
    if (existing) return existing.ready.then(() => existing)

    const handle = this.spawn()
    this.handle = handle
    return handle.ready.then(() => handle)
  }

  private spawn(): WorkerHandle {
    const child = spawn(this.command, this.arguments(), {
      env: {
        ...process.env,
        OPENCODE_PICKER_TITLE: this.title,
        OPENCODE_PICKER_OK_LABEL: this.okLabel,
      },
      windowsHide: true,
    })

    let markReady!: () => void
    let failReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      failReady = reject
    })

    const handle: WorkerHandle = {
      child,
      ready,
      markReady,
      failReady,
      readySettled: false,
      buffer: "",
      pending: undefined,
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.onData(handle, chunk))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", () => {})
    child.stdin.on("error", () => {})
    child.on("error", (error) => this.fail(handle, error))
    child.on("exit", (code) =>
      this.fail(handle, new Error(`Directory picker exited with code ${code ?? "unknown"}`)),
    )

    return handle
  }

  private arguments() {
    return [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encodePowerShellCommand(this.script),
    ]
  }

  private fail(handle: WorkerHandle, error: Error) {
    if (!handle.readySettled) {
      handle.readySettled = true
      handle.failReady(error)
    }
    const pending = handle.pending
    if (pending && !pending.settled) {
      pending.settled = true
      handle.pending = undefined
      pending.reject(error)
    }
    if (this.handle === handle) this.handle = undefined
  }

  private onData(handle: WorkerHandle, chunk: string) {
    if (this.handle !== handle) return
    handle.buffer += chunk

    let index = handle.buffer.indexOf("\n")
    while (index >= 0) {
      const line = handle.buffer.slice(0, index).replace(/\r$/, "").trim()
      handle.buffer = handle.buffer.slice(index + 1)
      this.onLine(handle, line)
      index = handle.buffer.indexOf("\n")
    }
  }

  private onLine(handle: WorkerHandle, line: string) {
    if (!handle.readySettled && line === READY_MARKER) {
      handle.readySettled = true
      handle.markReady()
      return
    }

    const pending = handle.pending
    if (!pending || pending.settled) return

    if (line === BEGIN_MARKER) {
      pending.capturing = true
      pending.captured = []
      return
    }
    if (line === END_MARKER) {
      pending.settled = true
      handle.pending = undefined
      const encoded = pending.captured.join("")
      pending.resolve(encoded ? Buffer.from(encoded, "base64").toString("utf8").trim() || undefined : undefined)
      return
    }
    if (line === CANCEL_MARKER) {
      pending.settled = true
      handle.pending = undefined
      pending.resolve(undefined)
      return
    }
    if (pending.capturing) pending.captured.push(line)
  }
}

async function chooseDirectory(picker: DirectoryPicker, initialDirectory: string) {
  try {
    return await picker.pick(initialDirectory)
  } catch {
    // The warm worker is unavailable: fall back to a one-shot process.
    return await pickDirectoryOnce(initialDirectory)
  }
}

async function setHomeDirectory(context: Context, directory: string) {
  const info = await stat(directory)
  if (!info.isDirectory()) throw new Error("The selected path is not a directory")

  // Resolve the path through OpenCode so workspace metadata and path
  // normalization are preserved instead of passing a raw directory only.
  const resolved = await context.client.location.get({ location: { directory } })
  const location = {
    directory: resolved.directory,
    ...(resolved.workspaceID ? { workspaceID: resolved.workspaceID } : {}),
  }

  // The first home prompt requires location-scoped catalogs. Load the critical
  // ones before exposing the selected location to the composer.
  await Promise.all([
    context.data.location.agent.sync(location),
    context.data.location.model.sync(location),
    context.data.location.provider.sync(location),
  ])

  // Update the home route immediately so the prompt has a synchronous target.
  // The published plugin type does not expose HomeRoute.location yet.
  context.ui.router.navigate({
    type: "home",
    location,
  } as unknown as Parameters<Context["ui"]["router"]["navigate"]>[0])
  context.ui.toast.show({
    message: `Working directory set to ${context.ui.format.path(location.directory)}`,
    variant: "success",
  })
}

function DirectoryButton(props: {
  context: Context
  onClick: () => void
  onMouseDown: () => void
}) {
  // 常态低调深柔和色，无任何交互反馈
  const dimColor = "#7a8478" // Everforest 次级深灰绿（低调收敛）

  return (
    <box
      height={1}
      alignSelf="flex-start"
      flexShrink={0}
      marginLeft={1}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      justifyContent="center"
      alignItems="center"
      onMouseDown={props.onMouseDown}
      onMouseUp={props.onClick}
    >
      <text fg={dimColor}>{"\uf07b"}</text>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-choose-directory",
  setup(context) {
    if (process.platform !== "win32") return

    const picker = new DirectoryPicker(
      powershellPath(),
      buildWorkerScript(),
      "选择工作目录",
      "选择文件夹",
    )
    // Compile the COM helper in the background so the first click opens the
    // native dialog without PowerShell startup or Add-Type latency.
    picker.warm()

    let running = false
    let promptEditor: { readonly isDestroyed: boolean; focus: () => void } | undefined
    const rememberPromptFocus = () => {
      const editor = context.renderer.currentFocusedEditor
      if (editor) promptEditor = editor
    }
    const restorePromptFocus = () => {
      const editor = promptEditor
      if (!editor || editor.isDestroyed) return
      setTimeout(() => {
        if (!editor.isDestroyed) editor.focus()
      }, 0)
    }
    const run = async () => {
      if (running) return
      running = true
      rememberPromptFocus()
      try {
        const current = context.location?.directory ?? context.data.location.default().directory
        const selected = await chooseDirectory(picker, current)
        if (selected) await setHomeDirectory(context, selected)
      } catch (error) {
        context.ui.toast.show({
          title: "Unable to choose directory",
          message: errorText(error),
          variant: "error",
        })
      } finally {
        restorePromptFocus()
        running = false
      }
    }

    const unregister = context.ui.slot({
      // The outer footer renders status/file content first, so appending here
      // keeps the button at the far right regardless of plugin load order.
      append: "prompt.footer",
      render: ({ sessionID }) =>
        sessionID ? (
          <></>
        ) : (
          <DirectoryButton
            context={context}
            onMouseDown={rememberPromptFocus}
            onClick={() => void run()}
          />
        ),
    })

    return () => {
      unregister()
      picker.dispose()
    }
  },
})
