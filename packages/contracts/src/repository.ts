export const REPOSITORY_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export interface ArchiveObjectInfo {
  key: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Storage for version archives, implemented per backend in future milestones. Archives are
 * immutable: `put` must fail if the key already exists. Implementations verify size and hash before
 * making an object visible, so readers never see a partial upload.
 */
export interface ArchiveRepository {
  readonly id: string;
  readonly kind: string;
  stat(key: string): Promise<ArchiveObjectInfo | null>;
  put(
    key: string,
    content: ReadableStream<Uint8Array>,
    expected: { sizeBytes: number; sha256: string },
  ): Promise<ArchiveObjectInfo>;
  get(key: string): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
}
