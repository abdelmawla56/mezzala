// apps/web/lib/tg/storage.ts
// MediaStorage interface + adapters.
// MZ_STORAGE=s3 → S3StorageAdapter (Task 2)
// MZ_STORAGE=local (default) → LocalStorageAdapter (existing behaviour)
export interface MediaStorage {
  put(key: string, body: Buffer | NodeJS.ReadableStream, mime: string): Promise<void>;
  presignGet(key: string, expiresIn?: number): Promise<string>;
  delete(key: string): Promise<void>;
}

// LocalStorageAdapter: writes to media-local/ on disk (offline dev, default)
import fs from "fs/promises";
import path from "path";

const LOCAL_DIR = process.env.LOCAL_MEDIA_DIR ?? path.join(process.cwd(), "media-local");

export class LocalStorageAdapter implements MediaStorage {
  async put(key: string, body: Buffer | NodeJS.ReadableStream): Promise<void> {
    const dest = path.join(LOCAL_DIR, key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (Buffer.isBuffer(body)) {
      await fs.writeFile(dest, body);
    } else {
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      await fs.writeFile(dest, Buffer.concat(chunks));
    }
  }

  async presignGet(key: string): Promise<string> {
    // Local: return a file:// or /api/media/stream path guarded by HMAC (Task 2 wires S3 properly)
    return `/api/media/stream?key=${encodeURIComponent(key)}`;
  }

  async delete(key: string): Promise<void> {
    await fs.unlink(path.join(LOCAL_DIR, key)).catch(() => {});
  }
}

export function createStorage(): MediaStorage {
  if (process.env.MZ_STORAGE === "s3") {
    // S3StorageAdapter will be implemented in Task 2
    throw new Error("S3 adapter not yet implemented — set MZ_STORAGE=local for dev");
  }
  return new LocalStorageAdapter();
}
