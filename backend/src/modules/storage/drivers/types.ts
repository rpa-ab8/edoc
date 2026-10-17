export interface TestConnectionResult {
  success: boolean;
  step?: "connect" | "write" | "read" | "delete";
  message?: string;
}

// Every backend implements the same four-step round trip (Scope doc §6.1.1): connect, write a
// throwaway object, read it back and compare, delete it. put/get/delete are the real runtime
// operations later modules (Upload, Viewer) call — always through this interface, never a raw
// SDK/filesystem call from feature code (CLAUDE.md hard rule).
export interface StorageDriver {
  testConnection(): Promise<TestConnectionResult>;
  put(key: string, data: Buffer, contentType?: string): Promise<string>;
  get(storageRef: string): Promise<Buffer>;
  delete(storageRef: string): Promise<void>;
}
