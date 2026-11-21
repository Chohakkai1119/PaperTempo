import { unzipSync, strFromU8 } from "fflate";

export function unzipEntry(zipData: Uint8Array, entryName: string): ArrayBuffer {
  const files = unzipSync(zipData);
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith(entryName) || entryName.endsWith(name) || name === entryName) {
      return data.buffer;
    }
  }
  const entries = Object.keys(files);
  throw new Error(
    `Entry "${entryName}" not found in zip. Available: ${entries.join(", ")}`
  );
}
