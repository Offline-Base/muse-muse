// Info-ZIP writes a UTF-8 name but doesn't mark it as UTF-8, even with -UN=UTF8, so Windows and macOS read it in an old code
// page and show it garbled. Setting the flag on each entry is all they need.
import { open } from "node:fs/promises";

const EOCD_MAGIC = 0x06054b50;
const EOCD_BYTES = 22;
const UTF8_FLAG = 0x0800;

/** Marks every name in a zip as UTF-8, in place. The zip has no comment and is under 4 GB, because it's our own. */
export async function markUtf8Names(zipPath) {
  const file = await open(zipPath, "r+");
  try {
    const { size } = await file.stat();
    const end = Buffer.alloc(EOCD_BYTES);
    await file.read(end, 0, EOCD_BYTES, size - EOCD_BYTES);
    if (end.readUInt32LE(0) !== EOCD_MAGIC) throw new Error("This zip has no end record where it should.");
    const directory = Buffer.alloc(end.readUInt32LE(12));
    const directoryAt = end.readUInt32LE(16);
    await file.read(directory, 0, directory.length, directoryAt);

    const flags = Buffer.alloc(2);
    let at = 0;
    for (let entry = end.readUInt16LE(10); entry > 0; entry--) {
      const merged = directory.readUInt16LE(at + 8) | UTF8_FLAG;
      directory.writeUInt16LE(merged, at + 8);
      flags.writeUInt16LE(merged);
      await file.write(flags, 0, 2, directory.readUInt32LE(at + 42) + 6);
      at += 46 + directory.readUInt16LE(at + 28) + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    }
    await file.write(directory, 0, directory.length, directoryAt);
  } finally {
    await file.close();
  }
}
