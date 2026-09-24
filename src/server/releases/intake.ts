import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

export const MAX_ZIP_BYTES = 50 * 1024 ** 2;
export const MAX_UNZIPPED_BYTES = 250 * 1024 ** 2;
export const MAX_FILES = 5000;
/** Entries of the zip central directory, folders and ignored files included. */
export const MAX_ENTRIES = 2 * MAX_FILES;

/** System files dropped silently: they never belong to a site and nobody needs to hear about them. */
const JUNK_SEGMENT = /^(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$/i;
/** Work folders of a project, dropped with a notice. */
const WORK_SEGMENT = /^(node_modules|bower_components|__pycache__)$/i;
/** Secrets and agent instructions: never published, whatever the folder. */
const SECRET_FILE =
  /^(CLAUDE\.md|AGENTS\.md|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.(pem|key|p12|pfx|ppk|jks|keystore|env))$/i;
/** Tooling scripts and executables beside the site: ignored, the servers only serve files. */
const SCRIPT_EXT =
  /\.(exe|dll|so|dylib|sh|bash|zsh|fish|bat|cmd|ps1|psm1|vbs|php|phtml|py|pyc|rb|pl|cgi|jar|msi|command)$/i;
/** Build folders preferred over a project's root index.html (Vite, Astro, Next export…). */
const BUILD_DIR = /^(dist|build|out|public|_site|www)$/i;

export class IntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeError";
  }
}

export type ExtractedFile = { path: string; size: number };

export type SkipReason = "hidden" | "secret" | "work" | "script" | "outside";
export type SkippedFile = { path: string; reason: SkipReason };

/** What the extraction left aside, for the analysis to tell the user. */
export type IntakeNotes = {
  /** Folder of the archive used as the site root, when it is not the archive root. */
  strippedRoot: string | null;
  /** Other folders that also had an index.html, when the choice was not obvious. */
  otherRoots: string[];
  skipped: SkippedFile[];
};

export type IntakeResult = IntakeNotes & {
  files: ExtractedFile[];
  fileCount: number;
  sizeBytes: number;
  archiveHash: string;
};

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: true, autoClose: false }, (err, zip) =>
      err ? reject(asIntakeError(err)) : resolve(zip),
    );
  });
}

/** yauzl reports format problems as plain Errors: turn them into a message for the user. */
function asIntakeError(err: unknown): Error {
  if (err instanceof IntakeError) return err;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && code.startsWith("E")) return err as Error; // disk, not the archive
  const message = err instanceof Error ? err.message : String(err);
  if (/absolute path|invalid relative path|invalid characters/i.test(message))
    return new IntakeError("L'archive contient un chemin de fichier dangereux, elle est refusée.");
  if (/end of central directory/i.test(message))
    return new IntakeError("Ce fichier n'est pas une archive .zip valide.");
  return new IntakeError("Archive illisible ou corrompue. Recompressez le dossier du site.");
}

function isSymlink(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
}

/** Normalises an entry name (slashes, NFC) and refuses anything that could leave the folder. */
export function safeRelative(name: string): string {
  const normalized = name.replace(/\\/g, "/").normalize("NFC");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized))
    throw new IntakeError(`Chemin absolu refusé : ${name}`);
  if (/[\u0000-\u001f\u007f]/.test(normalized))
    throw new IntakeError(
      `Nom de fichier invalide (caractère de contrôle) : ${JSON.stringify(name)}`,
    );
  const parts = normalized.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) throw new IntakeError(`Chemin dangereux refusé : ${name}`);
  return parts.join("/");
}

/** Why a file of the archive is left out of the site, or null to keep it. */
export function classifyEntry(rel: string): SkipReason | "junk" | null {
  const segments = rel.split("/");
  if (segments.some((s) => JUNK_SEGMENT.test(s))) return "junk";
  if (segments.some((s) => WORK_SEGMENT.test(s))) return "work";
  if (segments.some((s) => s.startsWith(".") && s !== ".well-known")) return "hidden";
  const base = segments[segments.length - 1];
  if (SECRET_FILE.test(base)) return "secret";
  if (SCRIPT_EXT.test(base)) return "script";
  return null;
}

function depth(dir: string): number {
  return dir === "" ? 0 : dir.split("/").length;
}

function parentOf(dir: string): string {
  const i = dir.lastIndexOf("/");
  return i < 0 ? "" : dir.slice(0, i);
}

/**
 * Picks the folder that holds the site: the shallowest index.html, except
 * that the build folder of a JavaScript project (dist/, build/, out/…) wins
 * over the project's own index.html. Without any index.html, a single folder
 * wrapping everything is still unwrapped.
 */
export function chooseSiteRoot(paths: string[]): { root: string; others: string[] } {
  const all = new Set(paths);
  const indexDirs = paths
    .filter((p) => p === "index.html" || p.endsWith("/index.html"))
    .map((p) => (p === "index.html" ? "" : p.slice(0, -"/index.html".length)));
  if (indexDirs.length === 0) {
    const tops = new Set(paths.map((p) => p.split("/")[0]));
    const wrapped = tops.size === 1 && paths.every((p) => p.includes("/"));
    return { root: wrapped ? [...tops][0] : "", others: [] };
  }
  const minDepth = Math.min(...indexDirs.map(depth));
  const projectBuild = indexDirs
    .filter((d) => {
      if (depth(d) > minDepth + 1 || !BUILD_DIR.test(d.split("/").pop() ?? "")) return false;
      const parent = parentOf(d);
      return all.has(parent ? `${parent}/package.json` : "package.json");
    })
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  if (projectBuild.length > 0) return { root: projectBuild[0], others: [] };
  const shallowest = indexDirs
    .filter((d) => depth(d) === minDepth)
    .sort((a, b) => {
      const ba = BUILD_DIR.test(a.split("/").pop() ?? "") ? 0 : 1;
      const bb = BUILD_DIR.test(b.split("/").pop() ?? "") ? 0 : 1;
      return ba - bb || a.localeCompare(b);
    });
  return { root: shallowest[0], others: shallowest.slice(1) };
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(/* turbopackIgnore: true */ file), hash);
  return hash.digest("hex");
}

type Kept = { rel: string; size: number };

/** First pass: reads the central directory only and decides what to extract. */
async function planExtraction(zipPath: string) {
  const zip = await openZip(zipPath);
  try {
    if (zip.entryCount > MAX_ENTRIES)
      throw new IntakeError(`Trop de fichiers dans l'archive (maximum ${MAX_FILES}).`);
    const byOffset = new Map<number, Kept>();
    const seen = new Set<string>();
    const skipped: SkippedFile[] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      zip.on("error", (err) => reject(asIntakeError(err)));
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        try {
          const rel = safeRelative(entry.fileName);
          const reason = rel && !entry.fileName.endsWith("/") ? classifyEntry(rel) : "junk";
          if (reason === null) {
            if (isSymlink(entry))
              throw new IntakeError(`Lien symbolique refusé : ${entry.fileName}`);
            if (entry.isEncrypted())
              throw new IntakeError(
                "Archive protégée par un mot de passe : recompressez le dossier sans mot de passe.",
              );
            if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
              throw new IntakeError(
                "Méthode de compression non prise en charge : recompressez le dossier avec l'outil standard de votre ordinateur.",
              );
            if (!seen.has(rel)) {
              seen.add(rel);
              total += entry.uncompressedSize;
              if (total > MAX_UNZIPPED_BYTES)
                throw new IntakeError(
                  `Contenu décompressé trop volumineux (maximum ${MAX_UNZIPPED_BYTES / 1024 ** 2} Mo).`,
                );
              if (seen.size > MAX_FILES)
                throw new IntakeError(`Trop de fichiers dans l'archive (maximum ${MAX_FILES}).`);
              byOffset.set(entry.relativeOffsetOfLocalHeader, {
                rel,
                size: entry.uncompressedSize,
              });
            }
          } else if (reason !== "junk") {
            skipped.push({ path: rel, reason });
          }
          zip.readEntry();
        } catch (err) {
          reject(err);
        }
      });
      zip.readEntry();
    });
    return { byOffset, skipped };
  } finally {
    zip.close();
  }
}

/**
 * Extracts a site archive into destDir. Refuses what could escape the folder
 * (symlinks, absolute paths, parent traversal) and leaves aside what must not
 * be published (hidden files, secrets, tooling scripts, files outside the site
 * folder), listing them in `skipped`. The site folder is the one holding the
 * shallowest index.html, or a project's build folder.
 */
export async function extractSiteZip(zipPath: string, destDir: string): Promise<IntakeResult> {
  const info = await stat(/* turbopackIgnore: true */ zipPath);
  if (info.size > MAX_ZIP_BYTES)
    throw new IntakeError(`Archive trop volumineuse (maximum ${MAX_ZIP_BYTES / 1024 ** 2} Mo).`);
  const archiveHash = await hashFile(zipPath);
  const { targets, skipped, root, others } = await planSite(zipPath);

  await rm(/* turbopackIgnore: true */ destDir, { recursive: true, force: true });
  await mkdir(/* turbopackIgnore: true */ destDir, { recursive: true });
  const out: ExtractedFile[] = [];
  const zip = await openZip(zipPath);
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", (err) => reject(asIntakeError(err)));
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        const target = targets.get(entry.relativeOffsetOfLocalHeader);
        if (!target) {
          zip.readEntry();
          return;
        }
        const abs = path.join(/* turbopackIgnore: true */ destDir, target.rel);
        if (!abs.startsWith(destDir + path.sep)) {
          reject(new IntakeError(`Chemin refusé : ${entry.fileName}`));
          return;
        }
        zip.openReadStream(entry, (err, stream) => {
          if (err) return reject(asIntakeError(err));
          (async () => {
            await mkdir(/* turbopackIgnore: true */ path.dirname(abs), { recursive: true });
            await pipeline(stream, createWriteStream(/* turbopackIgnore: true */ abs));
            out.push({ path: target.rel, size: target.size });
            zip.readEntry();
          })().catch((e: unknown) => reject(asIntakeError(e)));
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: out,
    fileCount: out.length,
    sizeBytes: out.reduce((n, f) => n + f.size, 0),
    archiveHash,
    strippedRoot: root || null,
    otherRoots: others,
    skipped,
  };
}

/**
 * What extractSiteZip would keep and leave aside, from the central directory
 * only (nothing is written). Throws the same IntakeErrors, so a bad archive is
 * refused before anything is created for it.
 */
export async function inspectSiteZip(zipPath: string): Promise<IntakeNotes> {
  const info = await stat(/* turbopackIgnore: true */ zipPath);
  if (info.size > MAX_ZIP_BYTES)
    throw new IntakeError(`Archive trop volumineuse (maximum ${MAX_ZIP_BYTES / 1024 ** 2} Mo).`);
  const { skipped, root, others } = await planSite(zipPath);
  return { strippedRoot: root || null, otherRoots: others, skipped };
}

async function planSite(zipPath: string) {
  const { byOffset, skipped } = await planExtraction(zipPath);
  const { root, others } = chooseSiteRoot([...byOffset.values()].map((k) => k.rel));
  const rootPrefix = root ? `${root}/` : "";
  const targets = new Map<number, Kept>();
  for (const [offset, kept] of byOffset) {
    if (rootPrefix && !kept.rel.startsWith(rootPrefix)) {
      skipped.push({ path: kept.rel, reason: "outside" });
      continue;
    }
    targets.set(offset, { rel: kept.rel.slice(rootPrefix.length), size: kept.size });
  }
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  if (targets.size === 0) {
    throw new IntakeError(
      skipped.length > 0
        ? `Aucun fichier publiable dans l'archive (fichiers écartés : ${skipped
            .slice(0, 5)
            .map((s) => s.path)
            .join(", ")}${skipped.length > 5 ? "…" : ""}).`
        : "L'archive est vide.",
    );
  }

  // A file "a" beside "a/b.html" cannot be written: say so instead of failing midway.
  const filePaths = new Set([...targets.values()].map((t) => t.rel));
  for (const rel of filePaths) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (filePaths.has(dir))
        throw new IntakeError(
          `Conflit de noms dans l'archive : « ${dir} » est à la fois un fichier et un dossier.`,
        );
    }
  }
  return { targets, skipped, root, others };
}
