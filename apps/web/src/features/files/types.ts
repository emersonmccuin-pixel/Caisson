export interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isHidden: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export interface FolderProbe {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  hasFiles: boolean;
  fileCount: number;
  isGitRepo: boolean;
  hasMcpJson: boolean;
}

export interface FileTreeNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: FileTreeNode[];
  size?: number;
}

export type FilePreview =
  | { kind: 'markdown'; content: string; byteSize: number }
  | { kind: 'html'; content: string; byteSize: number }
  | { kind: 'image'; dataUri: string; byteSize: number }
  | { kind: 'text'; content: string; byteSize: number }
  | { kind: 'binary'; byteSize: number }
  | { kind: 'oversized'; byteSize: number };
