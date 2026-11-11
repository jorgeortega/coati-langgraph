// The hash check on the site's export, with no data imports, so a Node
// script (scripts/build-index.ts) can use it as well as the Worker.

export type Manifest = { source: string; files: Record<string, string> };

/** The export doesn't match its manifest: rerun the site's export. */
export class StaleCopy extends Error {
  override name = 'StaleCopy';
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Every file in the manifest, checked against its hash. */
export async function checkExport(
  files: Record<string, string>,
  { files: hashes }: Manifest,
): Promise<Record<string, string>> {
  const checked: Record<string, string> = {};
  for (const [name, expected] of Object.entries(hashes)) {
    const text = files[name];
    if (text === undefined) throw new StaleCopy(`${name} is missing from data/`);
    if ((await sha256(text)) !== expected) {
      throw new StaleCopy(`${name} doesn't match manifest.json: rerun the site's export`);
    }
    checked[name] = text;
  }
  return checked;
}
