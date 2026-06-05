/**
 * Upload a pasted image blob to the server and return the absolute file path.
 * The server saves the file to <data>/pasted-images/<projectId>/ and returns
 * the path. The caller inserts that path into the chat input / PTY; Claude
 * reads the image via the Read tool.
 *
 * Uses raw binary body (not base64 JSON): fetch sends the Blob directly with
 * its MIME type as Content-Type. No encoding overhead.
 */
export async function uploadPastedImage(
  projectId: string,
  blob: Blob,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/projects/${projectId}/pasted-images`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    });
    const data = (await res.json()) as { ok: boolean; path?: string; error?: string };
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error ?? `upload failed (${res.status})` };
    }
    return { ok: true, path: data.path! };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
