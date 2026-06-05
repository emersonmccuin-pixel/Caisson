import type { FolderProbe } from '../files/types';
import type { CreateProjectMode } from './types';

type CreateProjectProbe = Pick<
  FolderProbe,
  'exists' | 'isDirectory' | 'hasFiles' | 'isGitRepo'
>;

export function createProjectModeFromProbe(probe: CreateProjectProbe): CreateProjectMode | null {
  if (!probe.exists || !probe.isDirectory) return null;
  if (probe.isGitRepo) return 'attach-to-git';
  return probe.hasFiles ? 'init-in-place' : 'init-empty';
}
