import type { FsEntry } from "./FilesPanel";

let dirHandle: FileSystemDirectoryHandle | null = null;
let dirPath: string = ""; // display name from handle or manual path

export function setDirHandle(h: FileSystemDirectoryHandle | null) { dirHandle = h; }
export function getDirHandle() { return dirHandle; }
export function setDirPath(p: string) { dirPath = p; }
export function getDirPath() { return dirPath; }

/** Enumerate a single level of a directory handle */
export async function enumerateHandle(
  handle: FileSystemDirectoryHandle
): Promise<FsEntry[]> {
  const result: FsEntry[] = [];
  for await (const [name, entry] of (handle as any).entries()) {
    result.push({
      name,
      path: name, // relative within the handle
      isDirectory: entry.kind === "directory",
      _handle: entry as FileSystemDirectoryHandle | FileSystemFileHandle,
    });
  }
  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

/** Open the native directory picker and return the root entries + display name */
export async function pickAndEnumerateFolder(): Promise<{
  entries: FsEntry[];
  name: string;
  handle: FileSystemDirectoryHandle;
} | null> {
  try {
    const handle = await (window as any).showDirectoryPicker();
    dirHandle = handle;
    dirPath = handle.name;
    return { entries: await enumerateHandle(handle), name: handle.name, handle };
  } catch {
    return null;
  }
}

/** Read a file from its handle */
export async function readFileFromHandle(
  handle: FileSystemFileHandle
): Promise<string> {
  const file = await handle.getFile();
  return file.text();
}

/** Write content to a file via its handle */
export async function writeFileToHandle(
  handle: FileSystemFileHandle,
  content: string
): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

/** Open the native file picker and return the handle + content */
export async function pickAndReadFile(): Promise<{
  name: string;
  content: string;
  handle: FileSystemFileHandle;
} | null> {
  try {
    const [handle] = await (window as any).showOpenFilePicker();
    const content = await readFileFromHandle(handle);
    return { name: handle.name, content, handle };
  } catch {
    return null;
  }
}
