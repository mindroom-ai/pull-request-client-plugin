/** GitHub supplies the immutable new blob SHA alongside the patch and line totals. */
export type DiffSource = {
  patch: string | null;
  sha: string | null;
  additions: number;
  deletions: number;
};

// Whole-file highlighting runs on the UI thread.
export const MAX_DIFF_BLOB_BYTES = 128 * 1024;
export const GIT_LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';
