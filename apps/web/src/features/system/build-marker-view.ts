// Pure logic for the dev-instance build marker banner.
// Parses the /api/dev/status response and returns a view model (or null when
// no build info is present, e.g. packaged app or plain dev run).

export interface BuildMarkerView {
  sha: string;
  branch: string;
}

export interface DevStatusResponse {
  activeAgents?: number;
  canRestart?: boolean;
  buildSha?: string | null;
  buildBranch?: string | null;
}

/**
 * Returns a BuildMarkerView when the API reported a build SHA, null otherwise.
 * Null = no banner should render (packaged build, or plain pnpm dev with no env set).
 */
export function parseBuildMarker(data: DevStatusResponse): BuildMarkerView | null {
  if (!data.buildSha) return null;
  return { sha: data.buildSha, branch: data.buildBranch ?? '' };
}
