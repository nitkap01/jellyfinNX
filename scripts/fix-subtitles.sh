#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C

SUBLIMINAL="$HOME/.local/bin/subliminal"
AUTHFILE="${AUDIOFIX_AUTHFILE:-$HOME/.audiofix.auth}"
WORK_DIR="${AUDIOFIX_WORK_DIR:-$HOME/jellyfin_audio_fix/work}"
MIN_VIDEO_BYTES=$((100 * 1024 * 1024))
PICKER_ROOTS=("/MEDIA/Eng_Movies" "/MEDIA/Hin_Movies")
LANGUAGE="en"
LOCAL_DIR=""

usage() {
  cat <<'EOF'
Usage: fix-subtitles.sh [<movie-folder-or-video-file>]

No path given: opens an interactive picker over /MEDIA/Eng_Movies and /MEDIA/Hin_Movies.
Downloads the best-matching English subtitle (via subliminal) and saves it
next to the movie with the same name (e.g. Movie.Name.mp4 -> Movie.Name.srt),
overwriting any existing subtitle of that name.
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

  local depth
  depth="$(printf '%s' "${target#/MEDIA}" | tr -cd '/' | wc -c)"
  if [ "$target" = "/MEDIA" ] || [ "$depth" -le 1 ]; then
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

  log "Searching for an English subtitle for: $base"
  "$SUBLIMINAL" download -l "$LANGUAGE" -s -f -d "$LOCAL_DIR" "$SRC" || true

  local local_srt="$LOCAL_DIR/$stem.srt"
  [ -s "$local_srt" ] || die 3 "No matching subtitle found for: $base"

  detect_cifs_mount "$dir"
  if [ "$ON_CIFS" != "true" ]; then
    cp "$local_srt" "$dir/$stem.srt"
    log "Saved: $dir/$stem.srt"
    exit 0
  fi

  check_authfile
  local rel_dir server share out
  rel_dir="${dir#"$ON_CIFS_MP"}"
  rel_dir="${rel_dir#/}"
  server="$(printf '%s' "$ON_CIFS_DEV" | sed -E 's#^//([^/]+)/.*#\1#')"
  share="$(printf '%s' "$ON_CIFS_DEV" | sed -E 's#^//[^/]+/([^/]+)$#\1#')"

  out="$(smbclient "//${server}/${share}" -A "$AUTHFILE" -m SMB3 -D "$rel_dir" -c "put \"$local_srt\" \"$stem.srt\"" 2>&1)"
  if printf '%s' "$out" | grep -q 'NT_STATUS_'; then
    die 4 "Upload failed: $out"
  fi

  local i=0 ok=false
  while [ $i -lt 5 ]; do
    [ -s "$dir/$stem.srt" ] && { ok=true; break; }
    sleep 1
    i=$((i + 1))
  done
  if [ "$ok" = "true" ]; then
    log "Saved: $dir/$stem.srt"
  else
    die 4 "Upload reported success but the file isn't visible yet through the read mount. Check manually: $dir/$stem.srt"
  fi
}

main "$@"
