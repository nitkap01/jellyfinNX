#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C

# own copy in /opt/mediafix/venv (install.sh); the old per-user install is the fallback
SUBLIMINAL="${MEDIAFIX_SUBLIMINAL:-/opt/mediafix/venv/bin/subliminal}"
[ -x "$SUBLIMINAL" ] || SUBLIMINAL="$HOME/.local/bin/subliminal"
AUTHFILE="${AUDIOFIX_AUTHFILE:-$HOME/.audiofix.auth}"
WORK_DIR="${AUDIOFIX_WORK_DIR:-/var/lib/mediafix/work}"
MIN_VIDEO_BYTES=$((100 * 1024 * 1024))
# interactive picker only: MEDIAFIX_PICKER_ROOTS (space-separated), else every NAS share mounted here
if [ -n "${MEDIAFIX_PICKER_ROOTS:-}" ]; then read -r -a PICKER_ROOTS <<<"$MEDIAFIX_PICKER_ROOTS"
else mapfile -t PICKER_ROOTS < <(findmnt -rn -t cifs,smb3,nfs,nfs4 -o TARGET 2>/dev/null | sed 's/\\x20/ /g'); fi
LANGUAGE="en"
LOCAL_DIR=""
DRY_RUN=false
NAMES_ONLY=false

usage() {
  cat <<'EOF'
Usage: fix-subtitles.sh [--dry-run] [<movie-folder-or-video-file>]
       fix-subtitles.sh --names <movie-folder-or-video-file>

No path given: opens an interactive picker over the NAS shares mounted here.
Downloads the best-matching English subtitle (via subliminal) and saves it
next to the movie as <name>.en.srt (e.g. Movie.Name.mp4 -> Movie.Name.en.srt, which
Jellyfin lists as English), overwriting an existing subtitle of that name.
If subliminal cannot use the real file name (e.g. "Title 2013 aka Other SS 1080p ..."),
it retries with cleaned-up names: title + year (from the file name, then from the
folder name like "Title (2014)") + resolution/source/codec tags.

--dry-run  search and download into a temp folder only; nothing is written next to the movie.
--names    only print the cleaned-up names that would be tried (no search, no download).
EOF
}

log() { printf '%s\n' "$*"; }

die() {
  local code="$1"; shift
  printf 'ERROR: %s\n' "$*" >&2
  exit "$code"
}

cleanup() {
  local rc=$?
  [ -n "$LOCAL_DIR" ] && [ -d "$LOCAL_DIR" ] && rm -rf "$LOCAL_DIR"
  exit "$rc"
}
trap cleanup EXIT INT TERM

list_picker_candidates() {
  local root
  for root in "${PICKER_ROOTS[@]}"; do
    [ -d "$root" ] || continue
    find "$root" -mindepth 1 -maxdepth 1 -type d -printf '%f\t%p\n' 2>/dev/null
    find "$root" -mindepth 1 -maxdepth 1 -type f \( -iname '*.mp4' -o -iname '*.mkv' \) ! -name '.*' -printf '%f\t%p\n' 2>/dev/null
  done
}

run_picker() {
  { : </dev/tty; } 2>/dev/null || die 1 "No terminal available for the picker. Pass a path directly instead."
  local fzf_bin="$HOME/bin/fzf"
  if ! [ -x "$fzf_bin" ]; then
    command -v fzf >/dev/null 2>&1 || die 1 "fzf not found. Run the fixaudio setup step to install it, or pass a movie path directly."
    fzf_bin="fzf"
  fi
  local sel
  sel="$(list_picker_candidates | sort | "$fzf_bin" --height=80% --border --delimiter='\t' --with-nth=1 --prompt='Pick a movie: ' || true)"
  [ -n "$sel" ] || { printf 'No selection made.\n' >&2; exit 0; }
  printf '%s\n' "$sel" | awk -F'\t' '{print $2}'
}

# Cleaned-up video names for subliminal (one per line, best first), used when the real name fails.
# Title + year from the file name, then title + year from the folder ("Title (2014)"), plus the
# resolution / source / codec tags of the file name. Names only: subliminal guesses from them.
clean_names() {
  python3 - "$1" <<'PY'
import os, re, sys
src = sys.argv[1]
stem, ext = os.path.splitext(os.path.basename(src))
ext = ext if ext.lower() in ('.mkv', '.mp4', '.avi', '.m4v') else '.mkv'
folder = os.path.basename(os.path.dirname(src))
YEAR = r'(?<!\d)(19[2-9]\d|20[0-4]\d)(?!\d)'

def words(t):
    t = re.sub(r'\[[^\]]*\]|\{[^}]*\}', ' ', t)            # [YTS], {tags}
    t = re.sub(r'^\s*www\.\S+\s*-?\s*', '', t, flags=re.I)  # site prefixes
    return re.sub(r'[._()\-]+', ' ', t).split()

def title_year(t):
    w = words(t)
    for i, x in enumerate(w):
        if i > 0 and re.fullmatch(YEAR, x):
            return ' '.join(w[:i]), x
    return None, None

def tags(t):
    s = ' '.join(words(t))
    out = []
    for pat, norm in ((r'\b(2160p|1080p|720p|576p|480p)\b', None), (r'\b(blu ?ray|bdrip|brrip)\b', 'BluRay'),
                      (r'\b(web dl|webdl)\b', 'WEB-DL'), (r'\bwebrip\b', 'WEBRip'), (r'\bhdtv\b', 'HDTV'), (r'\bdvdrip\b', 'DVDRip'),
                      (r'\b(x265|hevc|h ?265)\b', 'x265'), (r'\b(x264|h ?264|avc)\b', 'x264')):
        m = re.search(pat, s, re.I)
        if m:
            v = norm or m.group(1)
            if v not in out:
                out.append(v)
    return out

ft, fy = title_year(stem)
dt, dy = title_year(folder)
tg = tags(stem)
cands = []
for t, y in ((ft, fy), (dt, dy), (ft, dy), (dt, fy)):
    if t and y:
        n = '.'.join(t.split() + [y] + tg) + ext
        if n not in cands:
            cands.append(n)
if not cands:  # no year anywhere: the file name up to its first tag
    w = words(stem)
    cut = next((i for i, x in enumerate(w) if i > 0 and tags(x)), len(w))
    if w[:cut]:
        cands.append('.'.join(w[:cut] + tg) + ext)
for n in cands:
    print(n)
PY
}

# Runs subliminal for one path (real file or a bare name) into a fresh folder; prints the .srt it saved.
try_subliminal() {
  local what="$1" out
  out="$(mktemp -d "$LOCAL_DIR/try-XXXXXX")"
  "$SUBLIMINAL" download -l "$LANGUAGE" -s -f -d "$out" "$what" >&2 || true
  find "$out" -maxdepth 1 -type f -iname '*.srt' -size +0 -print -quit
}

resolve_target() {
  local arg="$1" target
  target="$(readlink -f "$arg" 2>/dev/null || true)"
  [ -n "$target" ] && [ -e "$target" ] || die 2 "Path not found: $arg"

  if [ -f "$target" ]; then
    SRC="$target"
    return 0
  fi
  if [ ! -d "$target" ]; then
    die 2 "Not a file or directory: $target"
  fi

  # A library root (a NAS share's mount point, or a folder holding several sub-folders) is refused. Judged from the
  # folder itself, not from fixed /MEDIA/... names, so movies can move between shares (JTV-18).
  local subdirs
  subdirs="$( (find "$target" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | head -2 | wc -l) || true)"
  if [ "$(findmnt -rn -o TARGET -T "$target" 2>/dev/null)" = "$target" ] || [ "$subdirs" -ge 2 ]; then
    die 2 "Refusing to scan a library root. Point me at a single movie folder or the video file itself."
  fi

  local listing count
  listing="$(find "$target" -maxdepth 1 -type f \( -iname '*.mp4' -o -iname '*.mkv' \) \
    ! -name '.*' ! -iname '*.part' \
    -size "+$((MIN_VIDEO_BYTES / 1024))k" -printf '%s\t%p\n' 2>/dev/null | sort -rn)"
  count="$(printf '%s' "$listing" | grep -c . || true)"

  if [ -z "$listing" ] || [ "$count" -eq 0 ]; then
    die 2 "No usable video file found in $target."
  fi
  if [ "$count" -eq 1 ]; then
    SRC="$(printf '%s' "$listing" | awk -F'\t' '{print $2}')"
    return 0
  fi

  log "Multiple video files found in $target:"
  printf '%s\n' "$listing" | awk -F'\t' '{printf "  %10d bytes  %s\n", $1, $2}'
  local suggestion
  suggestion="$(printf '%s' "$listing" | head -1 | awk -F'\t' '{print $2}')"
  die 2 "Ambiguous. Re-run naming the exact file, e.g.:
  fix-subtitles.sh \"$suggestion\""
}

check_authfile() {
  [ -e "$AUTHFILE" ] || die 6 "Credential file not found: $AUTHFILE"
  [ -f "$AUTHFILE" ] && [ ! -L "$AUTHFILE" ] || die 6 "Credential file must be a regular file, not a symlink: $AUTHFILE"
  local mode owner
  mode="$(stat -c '%a' "$AUTHFILE")"
  owner="$(stat -c '%U' "$AUTHFILE")"
  [ "$mode" = "600" ] && [ "$owner" = "$(whoami)" ] || \
    die 6 "Credential file must be mode 600 owned by $(whoami). Found: $mode $owner."
}

detect_cifs_mount() {
  ON_CIFS=false
  local line fstype esc_mp mp
  while IFS= read -r line; do
    fstype="$(awk '{print $3}' <<<"$line")"
    [ "$fstype" = "cifs" ] || continue
    esc_mp="$(awk '{print $2}' <<<"$line")"
    mp="$(printf '%b' "${esc_mp//\\/\\\\}")"
    case "$1/" in
      "$mp"/*|"$mp")
        if [ -z "${ON_CIFS_MP:-}" ] || [ "${#mp}" -gt "${#ON_CIFS_MP}" ]; then
          ON_CIFS=true
          ON_CIFS_MP="$mp"
          ON_CIFS_DEV="$(awk '{print $1}' <<<"$line")"
        fi
        ;;
    esac
  done </proc/mounts
}

main() {
  [ -x "$SUBLIMINAL" ] || die 1 "subliminal not found at $SUBLIMINAL. Run the one-time setup step first."

  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=true; shift ;;
      --names) NAMES_ONLY=true; shift ;;
      -h|--help) usage; exit 0 ;;
      *) break ;;
    esac
  done
  local arg="${1:-}"
  [ -z "$arg" ] && arg="$(run_picker)"
  resolve_target "$arg"

  if printf '%s' "$SRC" | grep -qP '["\\\x00-\x1f]'; then
    die 2 "Filename contains a character that cannot be safely handled: $SRC"
  fi

  local base stem dir
  base="$(basename -- "$SRC")"
  stem="${base%.*}"
  dir="$(dirname -- "$SRC")"

  mkdir -p "$WORK_DIR"
  LOCAL_DIR="$(mktemp -d "$WORK_DIR/subs-XXXXXX")"

  if [ "$NAMES_ONLY" = "true" ]; then
    clean_names "$SRC"
    exit 0
  fi

  # Saved as <stem>.en.srt so Jellyfin lists it as English.
  local out_name="$stem.$LANGUAGE.srt"

  log "Searching for an English subtitle for: $base"
  local local_srt name
  local_srt="$(try_subliminal "$SRC")"
  if [ -z "$local_srt" ]; then
    # subliminal could not use the real name: retry with cleaned-up names (bare names, no file needed).
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      log "Nothing found with the file name; retrying as: $name"
      local_srt="$(try_subliminal "$LOCAL_DIR/$name")"
      [ -n "$local_srt" ] && break
    done < <(clean_names "$SRC")
  fi
  [ -n "$local_srt" ] && [ -s "$local_srt" ] || die 3 "No matching subtitle found for: $base"

  if [ "$DRY_RUN" = "true" ]; then
    log "Dry run: found $(basename -- "$local_srt") ($(wc -l < "$local_srt") lines); would save: $dir/$out_name"
    exit 0
  fi

  detect_cifs_mount "$dir"
  if [ "$ON_CIFS" != "true" ]; then
    cp "$local_srt" "$dir/$out_name"
    log "Saved: $dir/$out_name"
    exit 0
  fi

  check_authfile
  local rel_dir server share out
  rel_dir="${dir#"$ON_CIFS_MP"}"
  rel_dir="${rel_dir#/}"
  server="$(printf '%s' "$ON_CIFS_DEV" | sed -E 's#^//([^/]+)/.*#\1#')"
  share="$(printf '%s' "$ON_CIFS_DEV" | sed -E 's#^//[^/]+/([^/]+)$#\1#')"

  out="$(smbclient "//${server}/${share}" -A "$AUTHFILE" -m SMB3 -D "$rel_dir" -c "put \"$local_srt\" \"$out_name\"" 2>&1)"
  if printf '%s' "$out" | grep -q 'NT_STATUS_'; then
    die 4 "Upload failed: $out"
  fi

  local i=0 ok=false
  while [ $i -lt 5 ]; do
    [ -s "$dir/$out_name" ] && { ok=true; break; }
    sleep 1
    i=$((i + 1))
  done
  if [ "$ok" = "true" ]; then
    log "Saved: $dir/$out_name"
  else
    die 4 "Upload reported success but the file isn't visible yet through the read mount. Check manually: $dir/$out_name"
  fi
}

main "$@"
