/**
 * Shell scripts run on the site servers by the SSH agent. Kept apart from the
 * transport so they can be executed locally by the tests, on a scratch tree.
 * Every value interpolated here is validated by the agent and shell-quoted.
 */

/** Written inside a release once it is fully extracted, before it is moved into place. */
export const RELEASE_COMPLETE_MARKER = ".auscii-complete";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Receives a gzipped tar on stdin. Releases are immutable: extracted into a
 * temporary folder next to the others, marked complete, then renamed in one
 * step. A release that is already complete is never touched (it may be live).
 * A folder without the marker (interrupted upload of an older version of the
 * tool) is swapped for the fresh copy, then deleted.
 * Prints RELEASE_PRESENT or RELEASE_UPLOADED.
 */
export function uploadReleaseScript({
  releasesDir,
  name,
}: {
  releasesDir: string;
  name: string;
}): string {
  const n = shellQuote(name);
  const done = `${n}/${RELEASE_COMPLETE_MARKER}`;
  return `set -eu
cd -- ${shellQuote(releasesDir)}
if [ -f ${done} ]; then cat >/dev/null; echo RELEASE_PRESENT; exit 0; fi
tmp=$(mktemp -d .tmp-XXXXXXXXXX)
trap 'rm -rf -- "$tmp"' EXIT
tar xzf - -C "$tmp" --no-same-owner
chmod 755 "$tmp"
: > "$tmp/${RELEASE_COMPLETE_MARKER}"
if [ ! -e ${n} ] && mv -T -- "$tmp" ${n} 2>/dev/null; then echo RELEASE_UPLOADED; exit 0; fi
if [ -f ${done} ]; then echo RELEASE_PRESENT; exit 0; fi
old=$(mktemp -d .trash-XXXXXXXXXX)
mv -T -- ${n} "$old/release"
mv -T -- "$tmp" ${n}
rm -rf -- "$old"
echo RELEASE_UPLOADED
`;
}

/** Exit code 0 when the release is complete, 1 otherwise. */
export function hasReleaseScript({
  releasesDir,
  name,
}: {
  releasesDir: string;
  name: string;
}): string {
  return `test -f ${shellQuote(`${releasesDir}/${name}/${RELEASE_COMPLETE_MARKER}`)}`;
}

/**
 * Deletes the rel-* folders of a site except `keep` and the one `current`
 * points to; prints one deleted name per line. Folders are renamed before
 * deletion so a half-deleted release is never taken for a real one. Leftovers
 * of interrupted uploads older than an hour are removed too.
 */
export function pruneReleasesScript({
  siteDir,
  keep,
}: {
  siteDir: string;
  keep: string[];
}): string {
  return `set -eu
cd -- ${shellQuote(`${siteDir}/releases`)} 2>/dev/null || exit 0
cur=$(readlink -- ../current 2>/dev/null || true)
if [ -e ../current ] && [ -z "$cur" ]; then echo "current n'est pas un lien symbolique, purge annulée" >&2; exit 1; fi
cur=\${cur##*/}
for d in rel-*; do
  [ -d "$d" ] || continue
  [ "$d" = "$cur" ] && continue
  case ${shellQuote(` ${keep.join(" ")} `)} in *" $d "*) continue ;; esac
  mv -T -- "$d" ".trash-$d"
  rm -rf -- ".trash-$d"
  echo "$d"
done
find . -mindepth 1 -maxdepth 1 \\( -name '.tmp-*' -o -name '.trash-*' \\) -mmin +60 -exec rm -rf -- {} +
`;
}

export type CaddyPaths = {
  /** Folder imported by the main Caddyfile (import <sitesDir>/*.caddy). */
  sitesDir: string;
  /** Command validating the whole configuration. */
  validateCommand: string;
  /** Lock shared by every change to the Caddy configuration, reload included. */
  lockFile: string;
};

export const DEFAULT_CADDY_PATHS: CaddyPaths = {
  sitesDir: "/etc/caddy/sites",
  validateCommand: "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile",
  lockFile: "/etc/caddy/sites/.auscii.lock",
};

function withLock(lockFile: string): string {
  return `exec 9>>${shellQuote(lockFile)}
flock -w 120 9 || { echo "Configuration Caddy verrouillée par une autre opération" >&2; exit 1; }`;
}

/**
 * Installs <name>.caddy from stdin. The new content lands in <name>.caddy.new
 * (outside the import glob) and is checked against its hash, so a cut
 * connection never leaves a truncated block. The previous file is kept as
 * <name>.caddy.bak; if the whole configuration no longer validates, it is put
 * back (or the new file removed) and the script exits 3 with Caddy's output.
 */
export function writeCaddySiteScript(
  paths: CaddyPaths,
  { name, sha256 }: { name: string; sha256: string },
): string {
  const f = shellQuote(`${name}.caddy`);
  return `set -eu
cd -- ${shellQuote(paths.sitesDir)}
${withLock(paths.lockFile)}
f=${f}
cat > "$f.new"
if ! printf '%s  %s\\n' ${shellQuote(sha256)} "$f.new" | sha256sum -c --status; then
  rm -f -- "$f.new"; echo "Configuration reçue incomplète" >&2; exit 1
fi
had=0
if [ -f "$f" ]; then cp -p -- "$f" "$f.bak"; had=1; fi
mv -f -- "$f.new" "$f"
if ! out=$(${paths.validateCommand} 2>&1); then
  if [ "$had" = 1 ]; then mv -f -- "$f.bak" "$f"; else rm -f -- "$f"; fi
  printf '%s\\n' "$out" | grep -v '"level":"info"' | tail -n 20 >&2
  exit 3
fi
`;
}

export function removeCaddySiteScript(paths: CaddyPaths, { name }: { name: string }): string {
  const f = shellQuote(`${name}.caddy`);
  return `set -eu
cd -- ${shellQuote(paths.sitesDir)}
${withLock(paths.lockFile)}
rm -f -- ${f} ${f}.new ${f}.bak
`;
}

/** Reload under the same lock, so it never picks up a block still being validated. */
export function reloadCaddyScript(paths: CaddyPaths, reloadCommand: string): string {
  return `set -eu
${withLock(paths.lockFile)}
${reloadCommand}
`;
}
