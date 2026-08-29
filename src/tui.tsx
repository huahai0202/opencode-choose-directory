/** @jsxImportSource @opentui/solid */

import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { Plugin } from "@opencode-ai/plugin/tui"
import type { Context } from "@opencode-ai/plugin/tui/context"

const execFileAsync = promisify(execFile)
const BEGIN_MARKER = "__OPENCODE_DIRECTORY_BEGIN__"
const END_MARKER = "__OPENCODE_DIRECTORY_END__"

const PICKER_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"

# Use the native Windows common dialog in folder mode. This provides the
# Explorer-style navigation UI instead of the legacy WinForms tree dialog.
$source = @'
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
'@

Add-Type -TypeDefinition $source -ErrorAction Stop
$selected = [OpenCodeFolderPicker]::Pick(
  $env:OPENCODE_INITIAL_DIRECTORY,
  $env:OPENCODE_PICKER_TITLE,
  $env:OPENCODE_PICKER_OK_LABEL
)
if ($selected) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($selected)
  Write-Output "__OPENCODE_DIRECTORY_BEGIN__"
  Write-Output ([System.Convert]::ToBase64String($bytes))
  Write-Output "__OPENCODE_DIRECTORY_END__"
}
`

function encodePowerShellCommand(script: string) {
  return Buffer.from(script, "utf16le").toString("base64")
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function pickDirectory(initialDirectory: string) {
  const powershell = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe"
  const result = await execFileAsync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encodePowerShellCommand(PICKER_SCRIPT),
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

  const output = (result as { stdout: string | Uint8Array }).stdout
  const stdout = typeof output === "string" ? output : Buffer.from(output).toString("utf8")
  const lines = stdout.split(/\r?\n/).map((line: string) => line.trim())
  const begin = lines.indexOf(BEGIN_MARKER)
  const end = lines.indexOf(END_MARKER, begin + 1)
  if (begin < 0 || end <= begin + 1) return undefined

  const encodedPath = lines.slice(begin + 1, end).join("")
  if (!encodedPath) return undefined
  return Buffer.from(encodedPath, "base64").toString("utf8").trim() || undefined
}

async function setHomeDirectory(context: Context, directory: string) {
  const info = await stat(directory)
  if (!info.isDirectory()) throw new Error("The selected path is not a directory")

  // OpenCode V2 stores the next session location on the home route. The
  // published plugin type does not expose HomeRoute.location yet.
  context.ui.router.navigate({
    type: "home",
    location: { directory },
  } as unknown as Parameters<Context["ui"]["router"]["navigate"]>[0])
  context.ui.toast.show({
    message: `Working directory set to ${context.ui.format.path(directory)}`,
    variant: "success",
  })
}

function DirectoryButton(props: { onClick: () => void }) {
  return (
    <box
      border={["left", "right"]}
      borderStyle="rounded"
      borderColor="#a7c080"
      backgroundColor="#343f44"
      width={12}
      height={1}
      alignSelf="flex-start"
      flexShrink={0}
      marginLeft={1}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      justifyContent="center"
      onMouseUp={props.onClick}
    >
      <text fg="#a7c080">选择目录</text>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-choose-directory",
  setup(context) {
    if (process.platform !== "win32") return

    let running = false
    const run = async () => {
      if (running) return
      running = true
      try {
        const current = context.location?.directory ?? context.data.location.default().directory
        const selected = await pickDirectory(current)
        if (selected) await setHomeDirectory(context, selected)
      } catch (error) {
        context.ui.toast.show({
          title: "Unable to choose directory",
          message: errorText(error),
          variant: "error",
        })
      } finally {
        running = false
      }
    }

    return context.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID }) => (sessionID ? <></> : <DirectoryButton onClick={() => void run()} />),
    })
  },
})
