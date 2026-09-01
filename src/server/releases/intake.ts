import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

export const MAX_ZIP_BYTES = 50 * 1024 ** 2;
export const MAX_UNZIPPED_BYTES = 250 * 1024 ** 2;
export const MAX_FILES = 5000;

const IGNORED = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|\.git|node_modules)(\/|$)/;
const EXEC_EXT = /\.(exe|dll|so|dylib|sh|bat|cmd|ps1|php|py|rb|pl|cgi)$/i;

export class IntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeError";
  }
}

export type ExtractedFile = { path: string; size: number };

export type IntakeResult = {
  files: ExtractedFile[];
  fileCount: number;
  sizeBytes: number;
  archiveHash: string;
  /** Root folder that was stripped, when the zip wrapped everything in one directory. */
  strippedRoot: string | null;
};

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: true }, (err, zip) =>
      err ? reject(err) : resolve(zip),
    );
  });
}

function isSymlink(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
}

export function safeRelative(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized))
    throw new IntakeError(`Chemin absolu refusé : ${name}`);
  const parts = normalized.split("/").filter((p) => p.length > 0);
  if (parts.some((p) => p === "..")) throw new IntakeError(`Chemin dangereux refusé : ${name}`);
  if (parts.some((p) => p.includes("\0")))
    throw new IntakeError(`Nom de fichier invalide : ${name}`);
  return parts.join("/");
}

/**
 * Extracts a site archive into destDir, refusing anything that is not a plain
 * file inside the archive (symlinks, absolute paths, parent traversal,
 * executables). Flattens a single wrapping directory.
 */
export async function extractSiteZip(zipPath: string, destDir: string): Promise<IntakeResult> {
  const info = await stat(zipPath);
  if (info.size > MAX_ZIP_BYTES)
    throw new IntakeError(`Archive trop volumineuse (max ${MAX_ZIP_BYTES / 1024 ** 2} Mo).`);
  const archiveHash = createHash("sha256")
    .update(await readFile(zipPath))
    .digest("hex");

  const zip = await openZip(zipPath);
  const entries: yauzl.Entry[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });

  const files = entries.filter((e) => !e.fileName.endsWith("/"));
  const kept: { entry: yauzl.Entry; rel: string }[] = [];
  let total = 0;
  for (const entry of files) {
    const rel = safeRelative(entry.fileName);
    if (!rel || IGNORED.test(rel)) continue;
    if (isSymlink(entry)) throw new IntakeError(`Lien symbolique refusé : ${entry.fileName}`);
    if (EXEC_EXT.test(rel))
      throw new IntakeError(`Fichier exécutable ou script serveur refusé : ${rel}`);
    total += entry.uncompressedSize;
    if (total > MAX_UNZIPPED_BYTES)
      throw new IntakeError(
        `Contenu décompressé trop volumineux (max ${MAX_UNZIPPED_BYTES / 1024 ** 2} Mo).`,
      );
    kept.push({ entry, rel });
  }
  if (kept.length === 0) throw new IntakeError("L'archive est vide.");
  if (kept.length > MAX_FILES) throw new IntakeError(`Trop de fichiers (max ${MAX_FILES}).`);

  // Flatten "monsite/index.html" into "index.html" when every file shares one root folder.
  const roots = new Set(kept.map(({ rel }) => rel.split("/")[0]));
  let strippedRoot: string | null = null;
  if (roots.size === 1 && kept.every(({ rel }) => rel.includes("/"))) {
    strippedRoot = [...roots][0];
  }

  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  const out: ExtractedFile[] = [];
  const zip2 = await openZip(zipPath);
  await new Promise<void>((resolve, reject) => {
    zip2.on("error", reject);
    zip2.on("end", resolve);
    zip2.on("entry", (entry: yauzl.Entry) => {
      const match = kept.find((k) => k.entry.fileName === entry.fileName);
      if (!match) {
        zip2.readEntry();
        return;
      }
      const rel = strippedRoot ? match.rel.slice(strippedRoot.length + 1) : match.rel;
      const target = path.join(destDir, rel);
      if (!target.startsWith(destDir + path.sep)) {
        reject(new IntakeError(`Chemin refusé : ${entry.fileName}`));
        return;
      }
      zip2.openReadStream(entry, async (err, stream) => {
        if (err) return reject(err);
        try {
          await mkdir(path.dirname(target), { recursive: true });
          await pipeline(stream, createWriteStream(target));
          out.push({ path: rel, size: entry.uncompressedSize });
          zip2.readEntry();
        } catch (e) {
          reject(e);
        }
      });
    });
    zip2.readEntry();
  });

  out.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: out,
    fileCount: out.length,
    sizeBytes: out.reduce((n, f) => n + f.size, 0),
    archiveHash,
    strippedRoot,
  };
}
