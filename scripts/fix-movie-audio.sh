#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C

FFMPEG=/usr/lib/jellyfin-ffmpeg/ffmpeg
FFPROBE=/usr/lib/jellyfin-ffmpeg/ffprobe

TARGET_I=-18
TARGET_LRA=11
TARGET_TP=-3
AAC_BITRATE=192k
LRA_THRESHOLD_DEFAULT=18

MIN_VIDEO_BYTES=$((100 * 1024 * 1024))
DURATION_TOLERANCE_S=2.0
TP_FAIL_ABOVE=-0.5
MIN_OUTPUT_RATIO=0.50
NAS_FREE_MARGIN_BYTES=$((20 * 1024 * 1024 * 1024))
SMB_VISIBILITY_RETRIES=5
SMB_VISIBILITY_SLEEP=2

WORK_DIR="${AUDIOFIX_WORK_DIR:-$HOME/jellyfin_audio_fix/work}"
LOG_DIR="$HOME/jellyfin_audio_fix/logs"
AUTHFILE="${AUDIOFIX_AUTHFILE:-$HOME/.audiofix.auth}"
JOURNAL_FILE="$WORK_DIR/audiofix.journal"
LOCK_FILE="$WORK_DIR/audiofix.lock"
PROGRESS_STATUS_FILE="$WORK_DIR/progress.status"
PICKER_ROOTS=("/MEDIA/Eng_Movies" "/MEDIA/Hin_Movies")

DRY_RUN=false
LRA_THRESHOLD="$LRA_THRESHOLD_DEFAULT"
POSITIONAL=""
LOCAL_OUT=""
LOCK_FD=9

usage() {
  cat <<'EOF'
Usage: fix-movie-audio.sh [--dry-run] [--lra-threshold N] [<movie-folder-or-video-file>]

No path given: opens an interactive picker over /MEDIA/Eng_Movies and /MEDIA/Hin_Movies.
EOF
}

log() { printf '%s\n' "$*"; }

fail_status_for_code() {
  case "$1" in
    2) echo "FAIL_DISCOVERY" ;;
    3) echo "FAIL_PROBE" ;;
    4) echo "FAIL_ENCODE" ;;
    5) echo "FAIL_VERIFY" ;;
    6) echo "FAIL_CREDS" ;;
    7) echo "FAIL_NAS" ;;
    8) echo "FAIL_INCONSISTENT" ;;
    *) echo "" ;;
  esac
}

die() {
  local code="$1"; shift
  printf 'ERROR: %s\n' "$*" >&2
  local status
  status="$(fail_status_for_code "$code")"
  [ -n "$status" ] && log_result "$status" 2>/dev/null || true
  exit "$code"
}

cleanup() {
  local rc=$?
  if [ -n "$LOCAL_OUT" ] && [ -f "$LOCAL_OUT" ] && [ "${KEEP_LOCAL_OUT:-false}" != "true" ]; then
    rm -f "$LOCAL_OUT"
  fi
  if [ -n "${REMOTE_TMP_PENDING:-}" ]; then
    smb_raw del "$REL_DIR" "$REMOTE_TMP_PENDING" >/dev/null 2>&1 || true
  fi
  rm -f "$PROGRESS_STATUS_FILE"
  exit "$rc"
}
trap cleanup EXIT INT TERM

get_field() {
  local line="$1" prefix="$2" part
  IFS='|' read -ra __parts <<<"$line"
  for part in "${__parts[@]}"; do
    if [[ "$part" == "$prefix"* ]]; then
      printf '%s\n' "${part#"$prefix"}"
      return 0
    fi
  done
  return 1
}

awk_gt() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a>b)}'; }
awk_le() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a<=b)}'; }

within_tolerance() {
  awk -v a="$1" -v b="$2" -v t="$3" 'BEGIN{d=a-b; if(d<0)d=-d; exit !(d<=t)}'
}

make_bar() {
  local pct="$1" width=30 i bar=""
  [ "$pct" -gt 100 ] 2>/dev/null && pct=100
  [ "$pct" -lt 0 ] 2>/dev/null && pct=0
  local filled=$(( pct * width / 100 ))
  for ((i = 0; i < width; i++)); do
    if [ "$i" -lt "$filled" ]; then bar+="#"; else bar+="-"; fi
  done
  printf '%s' "$bar"
}

write_progress_status() {
  local phase="$1" pct="$2" tmp
  tmp="$(mktemp "$WORK_DIR/progress.status.XXXXXX")"
  printf 'phase=%s\npct=%s\n' "$phase" "$pct" >"$tmp"
  mv -f "$tmp" "$PROGRESS_STATUS_FILE"
}

run_ffmpeg_tracked() {
  local label="$1" total_duration="$2" errfile="$3"; shift 3
  local progfile
  progfile="$(mktemp "$WORK_DIR/progress-XXXXXX.tmp")"
  local show_bar=false
  { [ -t 1 ]; } && show_bar=true

  "$@" -progress "$progfile" 2>"$errfile" &
  local pid=$!

  local last_pct=-1 secs pct out_us elapsed=0 since_change=0 mm ss
  while kill -0 "$pid" 2>/dev/null; do
    if [ -s "$progfile" ]; then
      out_us="$(awk -F= '/^out_time_us=/{v=$2} END{print v+0}' "$progfile" 2>/dev/null)"
      if [ -n "$out_us" ] && [ "$out_us" -gt 0 ] 2>/dev/null; then
        secs=$(( out_us / 1000000 ))
        pct="$(awk -v s="$secs" -v d="$total_duration" 'BEGIN{if(d<=0){print 0; exit} p=int(s*100/d); if(p>100)p=100; if(p<0)p=0; print p}')"
        [ "$pct" != "$last_pct" ] && since_change=0
        last_pct="$pct"
      fi
    fi
    write_progress_status "$label" "${last_pct/-1/0}"
    if [ "$show_bar" = "true" ]; then
      mm=$(( elapsed / 60 )); ss=$(( elapsed % 60 ))
      if [ "$since_change" -ge 12 ]; then
        printf '\r%s [%s] %3d%%  %02d:%02d elapsed (still working, encoder is slower than the bar update)  ' \
          "$label" "$(make_bar "$last_pct")" "${last_pct/-1/0}" "$mm" "$ss"
      else
        printf '\r%s [%s] %3d%%  %02d:%02d elapsed  ' "$label" "$(make_bar "$last_pct")" "${last_pct/-1/0}" "$mm" "$ss"
      fi
    fi
    sleep 1
    elapsed=$(( elapsed + 1 ))
    since_change=$(( since_change + 1 ))
  done

  local rc=0
  wait "$pid" || rc=$?
  if [ "$show_bar" = "true" ]; then
    printf '\r%s [%s] 100%%  \n' "$label" "$(make_bar 100)"
  fi
  write_progress_status "$label" 100
  rm -f "$progfile"
  return "$rc"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=true; shift ;;
      --lra-threshold) LRA_THRESHOLD="$2"; shift 2 ;;
      --lra-threshold=*) LRA_THRESHOLD="${1#*=}"; shift ;;
      -h|--help) usage; exit 0 ;;
      --) shift; break ;;
      -*) die 1 "Unknown option: $1" ;;
      *)
        [ -z "$POSITIONAL" ] || die 1 "Unexpected extra argument: $1"
        POSITIONAL="$1"
        shift
        ;;
    esac
  done
  if [ $# -gt 0 ]; then
    [ -z "$POSITIONAL" ] || die 1 "Unexpected extra argument: $1"
    POSITIONAL="$1"
  fi
}

require_deps() {
  local bin
  for bin in "$FFMPEG" "$FFPROBE"; do
    [ -x "$bin" ] || die 1 "Required binary not found or not executable: $bin"
  done
  for bin in awk stat df flock sha256sum; do
    command -v "$bin" >/dev/null 2>&1 || die 1 "Required command not found: $bin"
  done
}

acquire_lock() {
  mkdir -p "$WORK_DIR" "$LOG_DIR"
  chmod 700 "$WORK_DIR" "$LOG_DIR" 2>/dev/null || true
  exec 9>"$LOCK_FILE"
  flock -n "$LOCK_FD" || die 2 "Another run is already in progress (lock: $LOCK_FILE)."
}

check_startup_journal() {
  [ -f "$JOURNAL_FILE" ] || return 0
  log "!! An unfinished run was found from a previous session:"
  log "----------------------------------------------------------------"
  cat "$JOURNAL_FILE"
  log "----------------------------------------------------------------"
  log "Refusing to start new work until this is resolved by hand."
  log "See the journal above for the phase reached and the exact remote"
  log "filenames involved, then use smbclient manually to finish or undo"
  log "the swap (rename the temp/backup file back as needed), then delete:"
  log "  $JOURNAL_FILE"
  exit 8
}

journal_write() {
  cat >"$JOURNAL_FILE" <<EOF
phase=$1
server=${SERVER:-}
share=${SHARE:-}
rel_dir=${REL_DIR:-}
original_name=${ORIGINAL_NAME:-}
backup_name=${BACKUP_NAME:-}
remote_tmp=${REMOTE_TMP:-}
authfile=${AUTHFILE:-}
timestamp=$(date '+%Y-%m-%d %H:%M:%S %Z')
EOF
  chmod 600 "$JOURNAL_FILE"
}

journal_clear() { rm -f "$JOURNAL_FILE"; }

check_authfile() {
  [ -e "$AUTHFILE" ] || die 6 "Credential file not found: $AUTHFILE
Create it (see the task doc) with username=/password=/domain= lines, then:
  chmod 600 $AUTHFILE"
  [ -f "$AUTHFILE" ] && [ ! -L "$AUTHFILE" ] || die 6 "Credential file must be a regular file, not a symlink: $AUTHFILE"
  local mode owner
  mode="$(stat -c '%a' "$AUTHFILE")"
  owner="$(stat -c '%U' "$AUTHFILE")"
  [ "$mode" = "600" ] && [ "$owner" = "$(whoami)" ] || \
    die 6 "Credential file must be mode 600 owned by $(whoami). Found: $mode $owner. Fix with:
  chmod 600 $AUTHFILE && chown $(whoami) $AUTHFILE"
  grep -q '^username=.\+' "$AUTHFILE" || die 6 "Credential file is missing a non-empty username= line."
  grep -q '^password=.\+' "$AUTHFILE" || die 6 "Credential file is missing a non-empty password= line."
}

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
    command -v fzf >/dev/null 2>&1 || die 1 "fzf not found. Run the one-time setup step to install it, or pass a movie path directly."
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

  local listing
  listing="$(find "$target" -maxdepth 1 -type f \( -iname '*.mp4' -o -iname '*.mkv' \) \
    ! -name '.*' ! -iname '*.pre-audiofix.*' ! -iname '*.part' \
    -size "+$((MIN_VIDEO_BYTES / 1024))k" -printf '%s\t%p\n' 2>/dev/null | sort -rn)"

  local count
  count="$(printf '%s' "$listing" | grep -c . || true)"

  if [ -z "$listing" ] || [ "$count" -eq 0 ]; then
    die 2 "No usable video file found in $target. (Looked for .mp4/.mkv over 100 MB, ignoring .part, dotfiles, and *.pre-audiofix.* files.)"
  fi

  if [ "$count" -eq 1 ]; then
    SRC="$(printf '%s' "$listing" | awk -F'\t' '{print $2}')"
    return 0
  fi

  log "Multiple video files found in $target:"
  printf '%s\n' "$listing" | awk -F'\t' '{printf "  %10d bytes  %s\n", $1, $2}'
  local suggestion
  suggestion="$(printf '%s' "$listing" | head -1 | awk -F'\t' '{print $2}')"
  if [ "$DRY_RUN" = "true" ]; then
    log "DRY RUN: ambiguous — would refuse to pick automatically. Re-run naming the exact file, e.g.:"
    log "  fix-movie-audio.sh --dry-run \"$suggestion\""
    exit 0
  fi
  die 2 "Ambiguous. Re-run naming the exact file, e.g.:
  fix-movie-audio.sh \"$suggestion\""
}

validate_source() {
  local base ext
  base="$(basename -- "$SRC")"
  ext="${base##*.}"
  EXT_LOWER="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
  case "$EXT_LOWER" in
    mp4|mkv) ;;
    *) die 2 "Unsupported container '.$ext'. Only .mp4 and .mkv are supported." ;;
  esac

  if printf '%s' "$SRC" | grep -qP '["\\\x00-\x1f]'; then
    die 2 "Path contains a character that cannot be safely quoted for smbclient: $SRC"
  fi

  STEM="${base%.*}"
  SRC_DIR="$(dirname -- "$SRC")"
  ORIGINAL_NAME="$base"
  BACKUP_NAME="${STEM}.pre-audiofix.${ext}.bak"
  BACKUP_PATH="$SRC_DIR/$BACKUP_NAME"

  if [ -e "$BACKUP_PATH" ]; then
    die 2 "Already processed: $BACKUP_PATH exists. Refusing to overwrite the only pristine original."
  fi

  SRC_SIZE="$(stat -c '%s' "$SRC")"
  SRC_MTIME="$(stat -c '%Y' "$SRC")"
  SRC_SHA256="$(sha256sum "$SRC" | awk '{print $1}')"
}

probe_default_audio_stream() {
  local compact
  compact="$("$FFPROBE" -v error -select_streams a \
    -show_entries "stream=index,codec_name,channels,sample_rate:stream_disposition=default" \
    -of compact=p=0 -i "$SRC" || true)"
  [ -n "$compact" ] || die 3 "No audio stream in $SRC."

  local ord=-1 chosen_ord=-1 chosen_ch="" chosen_sr="" fallback_ord="" fallback_ch="" fallback_sr="" line ch sr def
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    ord=$((ord + 1))
    ch="$(get_field "$line" "channels=" || true)"
    sr="$(get_field "$line" "sample_rate=" || true)"
    def="$(get_field "$line" "disposition:default=" || true)"
    if [ "$ord" -eq 0 ]; then fallback_ord=0; fallback_ch="$ch"; fallback_sr="$sr"; fi
    if [ "$def" = "1" ] && [ "$chosen_ord" -eq -1 ]; then
      chosen_ord=$ord
      chosen_ch="$ch"
      chosen_sr="$sr"
    fi
  done <<<"$compact"

  if [ "$chosen_ord" -ge 0 ]; then
    AUDIO_K="$chosen_ord"
    AUDIO_CH="$chosen_ch"
    AUDIO_SR="$chosen_sr"
  else
    AUDIO_K="$fallback_ord"
    AUDIO_CH="$fallback_ch"
    AUDIO_SR="$fallback_sr"
  fi
  [[ "$AUDIO_CH" =~ ^[0-9]+$ ]] || die 3 "Could not determine channel count for the default audio stream."
  [[ "$AUDIO_SR" =~ ^[0-9]+$ ]] || die 3 "Could not determine sample rate for the default audio stream."

  SRC_DURATION="$("$FFPROBE" -v error -show_entries format=duration -of default=nw=1:nk=1 -i "$SRC")"
  SRC_STREAM_COUNT="$("$FFPROBE" -v error -show_entries stream=index -of csv=p=0 -i "$SRC" | grep -c . || true)"
}

run_loudnorm_analysis() {
  local prefix="" filt errfile
  [ "$AUDIO_CH" -gt 2 ] && prefix="aformat=channel_layouts=stereo,"
  filt="${prefix}loudnorm=I=${TARGET_I}:LRA=${TARGET_LRA}:TP=${TARGET_TP}:print_format=json"
  errfile="$(mktemp "$WORK_DIR/analysis-XXXXXX.log")"

  local rc=0
  run_ffmpeg_tracked "Analyzing loudness" "$SRC_DURATION" "$errfile" \
    "$FFMPEG" -hide_banner -nostats -nostdin -i "$SRC" \
    -vn -sn -dn -map "0:a:${AUDIO_K}" -af "$filt" -f null - || rc=$?
  [ $rc -eq 0 ] || { cat "$errfile" >&2; rm -f "$errfile"; die 3 "Loudness analysis pass failed."; }

  local parsed
  parsed="$(awk -F'"' '
    /"input_i"/{v["i"]=$4} /"input_tp"/{v["tp"]=$4} /"input_lra"/{v["lra"]=$4}
    /"input_thresh"/{v["th"]=$4} /"target_offset"/{v["off"]=$4}
    END{print v["i"], v["tp"], v["lra"], v["th"], v["off"]}' "$errfile")"
  rm -f "$errfile"

  IN_I="$(awk '{print $1}' <<<"$parsed")"
  IN_TP="$(awk '{print $2}' <<<"$parsed")"
  IN_LRA="$(awk '{print $3}' <<<"$parsed")"
  IN_TH="$(awk '{print $4}' <<<"$parsed")"
  OFFSET="$(awk '{print $5}' <<<"$parsed")"

  for v in "$IN_I" "$IN_TP" "$IN_LRA" "$IN_TH"; do
    [ -n "$v" ] || die 3 "Could not measure loudness (empty analysis result)."
    case "$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')" in
      *inf*|*nan*) die 3 "Could not measure loudness (silent or unreadable audio track)." ;;
    esac
  done
}

decide_fix() {
  DOWNMIX=false
  LOUDNORM=false
  [ "$AUDIO_CH" -gt 2 ] && DOWNMIX=true
  awk_gt "$IN_LRA" "$LRA_THRESHOLD" && LOUDNORM=true

  if [ "$DOWNMIX" = "false" ] && [ "$LOUDNORM" = "false" ]; then
    DECISION="NONE"
  elif [ "$DOWNMIX" = "true" ] && [ "$LOUDNORM" = "true" ]; then
    DECISION="DOWNMIX+LOUDNORM"
  elif [ "$DOWNMIX" = "true" ]; then
    DECISION="DOWNMIX"
  else
    DECISION="LOUDNORM"
  fi
}

build_ffmpeg_cmd() {
  local audio_filter="" ac_opt=()
  case "$DECISION" in
    LOUDNORM)
      audio_filter="loudnorm=I=${TARGET_I}:LRA=${TARGET_LRA}:TP=${TARGET_TP}:measured_I=${IN_I}:measured_LRA=${IN_LRA}:measured_TP=${IN_TP}:measured_thresh=${IN_TH}:offset=${OFFSET}:linear=false"
      [ "$AUDIO_CH" -eq 1 ] && audio_filter="${audio_filter}:dual_mono=true"
      ;;
    DOWNMIX)
      ac_opt=(-ac:a:"${AUDIO_K}" 2)
      ;;
    DOWNMIX+LOUDNORM)
      audio_filter="aformat=channel_layouts=stereo,loudnorm=I=${TARGET_I}:LRA=${TARGET_LRA}:TP=${TARGET_TP}:measured_I=${IN_I}:measured_LRA=${IN_LRA}:measured_TP=${IN_TP}:measured_thresh=${IN_TH}:offset=${OFFSET}:linear=false"
      ac_opt=(-ac:a:"${AUDIO_K}" 2)
      ;;
  esac

  local container_opts=() out_ext="$EXT_LOWER"
  if [ "$EXT_LOWER" = "mp4" ]; then
    container_opts=(-movflags +faststart+use_metadata_tags -f mp4)
  else
    container_opts=(-f matroska)
  fi

  LOCAL_OUT="$WORK_DIR/audiofix-$(date +%s)-$$.${out_ext}"

  FFMPEG_CMD=("$FFMPEG" -hide_banner -nostats -nostdin -y -i "$SRC"
    -map 0 -map_metadata 0 -map_chapters 0 -c copy
    -c:a:"${AUDIO_K}" aac -b:a:"${AUDIO_K}" "$AAC_BITRATE" -ar:a:"${AUDIO_K}" "$AUDIO_SR")
  [ ${#ac_opt[@]} -gt 0 ] && FFMPEG_CMD+=("${ac_opt[@]}")
  [ -n "$audio_filter" ] && FFMPEG_CMD+=(-filter:a:"${AUDIO_K}" "$audio_filter")
  FFMPEG_CMD+=(-metadata "audiofix=loudnorm I=${TARGET_I} LRA=${TARGET_LRA} TP=${TARGET_TP}; $(date '+%Y-%m-%d')")
  FFMPEG_CMD+=("${container_opts[@]}" "$LOCAL_OUT")
}

run_ffmpeg_fix() {
  local avail_kb avail
  avail_kb="$(df -Pk "$WORK_DIR" | awk 'NR==2{print $4}')"
  avail=$((avail_kb * 1024))
  local needed=$((SRC_SIZE * 12 / 10))
  [ "$avail" -ge "$needed" ] || die 2 "Not enough local scratch space: have $avail bytes, need ~$needed bytes."

  local encode_log rc=0
  encode_log="$(mktemp "$WORK_DIR/encode-XXXXXX.log")"
  run_ffmpeg_tracked "Encoding" "$SRC_DURATION" "$encode_log" "${FFMPEG_CMD[@]}" || rc=$?
  if [ $rc -ne 0 ]; then
    tail -30 "$encode_log" >&2
    rm -f "$encode_log"
    die 4 "ffmpeg encode failed (exit $rc)."
  fi
  rm -f "$encode_log"
}

verify_local() {
  [ -s "$LOCAL_OUT" ] || { rm -f "$LOCAL_OUT"; die 5 "Encoded output is missing or empty."; }

  local out_size
  out_size="$(stat -c '%s' "$LOCAL_OUT")"
  local min_size
  min_size="$(awk -v s="$SRC_SIZE" -v r="$MIN_OUTPUT_RATIO" 'BEGIN{printf "%d", s*r}')"
  if [ "$out_size" -lt "$min_size" ]; then
    rm -f "$LOCAL_OUT"
    die 5 "Encoded output ($out_size bytes) is under ${MIN_OUTPUT_RATIO}x the source size ($SRC_SIZE bytes) — looks truncated."
  fi

  local out_duration
  out_duration="$("$FFPROBE" -v error -show_entries format=duration -of default=nw=1:nk=1 -i "$LOCAL_OUT")"
  if ! within_tolerance "$out_duration" "$SRC_DURATION" "$DURATION_TOLERANCE_S"; then
    rm -f "$LOCAL_OUT"
    die 5 "Output duration ($out_duration s) differs from source ($SRC_DURATION s) by more than ${DURATION_TOLERANCE_S}s."
  fi

  local out_stream_count
  out_stream_count="$("$FFPROBE" -v error -show_entries stream=index -of csv=p=0 -i "$LOCAL_OUT" | grep -c . || true)"
  if [ "$out_stream_count" != "$SRC_STREAM_COUNT" ]; then
    rm -f "$LOCAL_OUT"
    die 5 "Output has $out_stream_count streams, source had $SRC_STREAM_COUNT — a stream was lost."
  fi

  local out_audio_line out_ch out_codec out_sr
  out_audio_line="$("$FFPROBE" -v error -select_streams "a:${AUDIO_K}" \
    -show_entries "stream=codec_name,channels,sample_rate" -of compact=p=0 -i "$LOCAL_OUT" | head -1)"
  out_ch="$(get_field "$out_audio_line" "channels=" || true)"
  out_codec="$(get_field "$out_audio_line" "codec_name=" || true)"
  out_sr="$(get_field "$out_audio_line" "sample_rate=" || true)"
  local expected_ch="$AUDIO_CH"
  [ "$DECISION" != "LOUDNORM" ] && expected_ch=2
  if [ "$out_codec" != "aac" ] || [ "$out_ch" != "$expected_ch" ]; then
    rm -f "$LOCAL_OUT"
    die 5 "Output audio stream is $out_codec/$out_ch channels, expected aac/$expected_ch."
  fi
  if [ "$out_sr" != "$AUDIO_SR" ]; then
    rm -f "$LOCAL_OUT"
    die 5 "Output sample rate is ${out_sr}Hz, source was ${AUDIO_SR}Hz — a filter silently resampled the audio. Not safe to ship (many TV hardware decoders reject non-48/44.1kHz AAC)."
  fi

  verify_stream_manifest "$SRC" "$LOCAL_OUT" || { rm -f "$LOCAL_OUT"; die 5 "A non-audio stream's codec/type changed unexpectedly — refusing to upload."; }

  local tp_filt tp_errfile tp_parsed
  tp_filt="loudnorm=I=${TARGET_I}:LRA=${TARGET_LRA}:TP=${TARGET_TP}:print_format=json"
  tp_errfile="$(mktemp "$WORK_DIR/tpcheck-XXXXXX.log")"
  run_ffmpeg_tracked "Verifying peak levels" "$SRC_DURATION" "$tp_errfile" \
    "$FFMPEG" -hide_banner -nostats -nostdin -i "$LOCAL_OUT" \
    -vn -sn -dn -map "0:a:${AUDIO_K}" -af "$tp_filt" -f null - || true
  tp_parsed="$(awk -F'"' '
    /"input_i"/{v["i"]=$4} /"input_tp"/{v["tp"]=$4} /"input_lra"/{v["lra"]=$4}
    END{print v["i"], v["tp"], v["lra"]}' "$tp_errfile")"
  rm -f "$tp_errfile"

  OUT_CH="$out_ch"
  OUT_I="$(awk '{print $1}' <<<"$tp_parsed")"
  OUT_TP="$(awk '{print $2}' <<<"$tp_parsed")"
  OUT_LRA="$(awk '{print $3}' <<<"$tp_parsed")"

  if [ -n "$OUT_TP" ] && awk_gt "$OUT_TP" "$TP_FAIL_ABOVE"; then
    rm -f "$LOCAL_OUT"
    die 5 "Encoded output true peak is ${OUT_TP} dBTP (limit ${TP_FAIL_ABOVE}). Not uploading."
  fi
}

verify_stream_manifest() {
  local before after
  before="$("$FFPROBE" -v error -show_entries "stream=index,codec_type,codec_name" -of compact=p=0 -i "$1")"
  after="$("$FFPROBE" -v error -show_entries "stream=index,codec_type,codec_name" -of compact=p=0 -i "$2")"
  local n_before n_after
  n_before="$(printf '%s\n' "$before" | grep -c .)"
  n_after="$(printf '%s\n' "$after" | grep -c .)"
  [ "$n_before" = "$n_after" ] || return 1

  local i=0 audio_seen=-1
  local before_line after_line btype bname atype aname
  while IFS= read -r before_line; do
    after_line="$(printf '%s\n' "$after" | sed -n "$((i + 1))p")"
    btype="$(get_field "$before_line" "codec_type=" || true)"
    atype="$(get_field "$after_line" "codec_type=" || true)"
    [ "$btype" = "$atype" ] || return 1
    if [ "$btype" = "audio" ]; then
      audio_seen=$((audio_seen + 1))
      if [ "$audio_seen" != "$AUDIO_K" ]; then
        bname="$(get_field "$before_line" "codec_name=" || true)"
        aname="$(get_field "$after_line" "codec_name=" || true)"
        [ "$bname" = "$aname" ] || return 1
      fi
    else
      bname="$(get_field "$before_line" "codec_name=" || true)"
      aname="$(get_field "$after_line" "codec_name=" || true)"
      [ "$bname" = "$aname" ] || return 1
    fi
    i=$((i + 1))
  done <<<"$before"
  return 0
}

detect_cifs_mount() {
  ON_CIFS=false
  local line fstype mp esc_mp
  while IFS= read -r line; do
    fstype="$(awk '{print $3}' <<<"$line")"
    [ "$fstype" = "cifs" ] || continue
    esc_mp="$(awk '{print $2}' <<<"$line")"
    mp="$(printf '%b' "${esc_mp//\\/\\\\}")"
    case "$SRC_DIR/" in
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

smb_raw() {
  local op="$1" rel_dir="$2"; shift 2
  local cmd
  case "$op" in
    ls) cmd='ls' ;;
    put) cmd="put \"$1\" \"$2\"" ;;
    del) cmd="del \"$1\"" ;;
    rename) cmd="rename \"$1\" \"$2\"" ;;
    *) die 1 "Internal error: unknown smb op $op" ;;
  esac
  smbclient "//${SERVER}/${SHARE}" -A "$AUTHFILE" -m SMB3 -D "$rel_dir" -c "$cmd" 2>&1
}

classify_smb_result() {
  local out="$1"
  case "$out" in
    *NT_STATUS_ACCESS_DENIED*|*NT_STATUS_OBJECT_NAME_COLLISION*|*NT_STATUS_OBJECT_NAME_NOT_FOUND*|*NT_STATUS_LOGON_FAILURE*|*NT_STATUS_BAD_NETWORK_NAME*|*NT_STATUS_OBJECT_PATH_NOT_FOUND*)
      echo "CLEAN_FAIL" ;;
    *NT_STATUS_*)
      echo "AMBIGUOUS" ;;
    *)
      echo "OK" ;;
  esac
}

smb_op() {
  local op="$1" rel_dir="$2"; shift 2
  local out status
  out="$(smb_raw "$op" "$rel_dir" "$@")"
  status="$(classify_smb_result "$out")"
  printf '%s\x1e%s\n' "$status" "$out"
}

smb_reconcile() {
  local listing
  listing="$(smb_raw ls "$REL_DIR" || true)"
  HAS_ORIGINAL=false; HAS_BACKUP=false; HAS_TMP=false
  grep -qF "  ${ORIGINAL_NAME}" <<<"$listing" && HAS_ORIGINAL=true
  grep -qF "  ${BACKUP_NAME}" <<<"$listing" && HAS_BACKUP=true
  [ -n "${REMOTE_TMP:-}" ] && grep -qF "  ${REMOTE_TMP}" <<<"$listing" && HAS_TMP=true
}

nas_preflight() {
  check_authfile
  REL_DIR="${SRC_DIR#"$ON_CIFS_MP"}"
  REL_DIR="${REL_DIR#/}"
  if printf '%s' "$REL_DIR" | grep -qP '["\\\x00-\x1f]'; then
    die 2 "Remote directory path contains an unsafe character: $REL_DIR"
  fi
  SERVER="$(printf '%s' "$ON_CIFS_DEV" | sed -E 's#^//([^/]+)/.*#\1#')"
  SHARE="$(printf '%s' "$ON_CIFS_DEV" | sed -E 's#^//[^/]+/([^/]+)$#\1#')"

  local ls_result
  ls_result="$(smb_op ls "$REL_DIR")"
  [ "${ls_result%%$'\x1e'*}" = "OK" ] || die 6 "SMB reachability check failed: ${ls_result#*$'\x1e'}"

  local avail_kb
  avail_kb="$(smb_get_nas_avail_kb)"
  local avail_bytes=$((avail_kb * 1024))
  local out_size
  out_size="$(stat -c '%s' "$LOCAL_OUT")"
  local needed=$((out_size + NAS_FREE_MARGIN_BYTES))
  [ "$avail_bytes" -ge "$needed" ] || die 2 "Not enough NAS space: have $avail_bytes bytes free, need ~$needed."

  [ -e "$BACKUP_PATH" ] && die 2 "Already processed (backup appeared during processing): $BACKUP_PATH"

  local now_size now_mtime now_sha
  now_size="$(stat -c '%s' "$SRC")"
  now_mtime="$(stat -c '%Y' "$SRC")"
  if [ "$now_size" != "$SRC_SIZE" ] || [ "$now_mtime" != "$SRC_MTIME" ]; then
    die 2 "Source file changed while processing (size/mtime mismatch); aborting."
  fi
  now_sha="$(sha256sum "$SRC" | awk '{print $1}')"
  [ "$now_sha" = "$SRC_SHA256" ] || die 2 "Source file changed while processing (content mismatch); aborting."
}

smb_get_nas_avail_kb() {
  df -Pk "$ON_CIFS_MP" | awk 'NR==2{print $4}'
}

write_back_to_nas() {
  REMOTE_TMP="audiofix-tmp-$(date +%s)-$$-$RANDOM.part"

  journal_write "uploading"
  REMOTE_TMP_PENDING="$REMOTE_TMP"
  local r status out
  r="$(smb_op put "$REL_DIR" "$LOCAL_OUT" "$REMOTE_TMP")"
  status="${r%%$'\x1e'*}"; out="${r#*$'\x1e'}"
  if [ "$status" != "OK" ]; then
    if [ "$status" = "AMBIGUOUS" ]; then
      sleep "$SMB_VISIBILITY_SLEEP"
      smb_reconcile
      if [ "$HAS_TMP" = "true" ]; then
        log "Ambiguous upload failure, but the temp file did land — continuing."
      else
        smb_raw del "$REL_DIR" "$REMOTE_TMP" >/dev/null 2>&1 || true
        REMOTE_TMP_PENDING=""
        journal_clear
        die 7 "Upload failed (ambiguous, reconciled as not-landed): $out"
      fi
    else
      REMOTE_TMP_PENDING=""
      journal_clear
      die 7 "Upload failed: $out"
    fi
  fi

  local i=0 visible=false
  while [ $i -lt "$SMB_VISIBILITY_RETRIES" ]; do
    if [ -e "$ON_CIFS_MP/$REL_DIR/$REMOTE_TMP" ]; then visible=true; break; fi
    sleep "$SMB_VISIBILITY_SLEEP"
    i=$((i + 1))
  done
  if [ "$visible" != "true" ]; then
    smb_raw del "$REL_DIR" "$REMOTE_TMP" >/dev/null 2>&1 || true
    REMOTE_TMP_PENDING=""
    journal_clear
    die 7 "Uploaded temp file never became visible through the read mount."
  fi

  local remote_tmp_size remote_tmp_dur local_size local_dur
  remote_tmp_size="$(stat -c '%s' "$ON_CIFS_MP/$REL_DIR/$REMOTE_TMP")"
  local_size="$(stat -c '%s' "$LOCAL_OUT")"
  if [ "$remote_tmp_size" != "$local_size" ]; then
    smb_raw del "$REL_DIR" "$REMOTE_TMP" >/dev/null 2>&1 || true
    REMOTE_TMP_PENDING=""
    journal_clear
    die 7 "Uploaded file size ($remote_tmp_size) doesn't match local ($local_size)."
  fi
  remote_tmp_dur="$("$FFPROBE" -v error -show_entries format=duration -of default=nw=1:nk=1 -i "$ON_CIFS_MP/$REL_DIR/$REMOTE_TMP" 2>/dev/null || echo "")"
  local_dur="$("$FFPROBE" -v error -show_entries format=duration -of default=nw=1:nk=1 -i "$LOCAL_OUT")"
  if [ -z "$remote_tmp_dur" ] || ! within_tolerance "$remote_tmp_dur" "$local_dur" 0.5; then
    smb_raw del "$REL_DIR" "$REMOTE_TMP" >/dev/null 2>&1 || true
    REMOTE_TMP_PENDING=""
    journal_clear
    die 7 "Uploaded file failed duration verification through the read mount."
  fi

  journal_write "uploaded_verified"

  r="$(smb_op rename "$REL_DIR" "$ORIGINAL_NAME" "$BACKUP_NAME")"
  status="${r%%$'\x1e'*}"; out="${r#*$'\x1e'}"
  if [ "$status" != "OK" ]; then
    if [ "$status" = "AMBIGUOUS" ]; then
      sleep "$SMB_VISIBILITY_SLEEP"
      smb_reconcile
      if [ "$HAS_BACKUP" = "true" ] && [ "$HAS_ORIGINAL" = "false" ]; then
        log "Ambiguous rename failure, but it did land — continuing."
      else
        smb_raw del "$REL_DIR" "$REMOTE_TMP" >/dev/null 2>&1 || true
        REMOTE_TMP_PENDING=""
        journal_clear
        die 7 "Rename of original failed (reconciled as not-applied): $out"
      fi
    else
      smb_raw del "$REL_DIR" "$REMOTE_TMP" >/dev/null 2>&1 || true
      REMOTE_TMP_PENDING=""
      journal_clear
      die 7 "Rename of original to backup name failed: $out"
    fi
  fi

  journal_write "original_renamed"

  r="$(smb_op rename "$REL_DIR" "$REMOTE_TMP" "$ORIGINAL_NAME")"
  status="${r%%$'\x1e'*}"; out="${r#*$'\x1e'}"
  if [ "$status" != "OK" ]; then
    sleep "$SMB_VISIBILITY_SLEEP"
    smb_reconcile
    if [ "$HAS_ORIGINAL" = "true" ] && [ "$HAS_TMP" = "false" ]; then
      log "Ambiguous final rename failure, but it did land — continuing."
    else
      local rb rb_status
      rb="$(smb_op rename "$REL_DIR" "$BACKUP_NAME" "$ORIGINAL_NAME")"
      rb_status="${rb%%$'\x1e'*}"
      if [ "$rb_status" = "OK" ]; then
        smb_raw del "$REL_DIR" "$REMOTE_TMP" >/dev/null 2>&1 || true
        REMOTE_TMP_PENDING=""
        journal_clear
        die 7 "Final rename failed; rolled back successfully. Library restored. Original error: $out"
      else
        sleep "$SMB_VISIBILITY_SLEEP"
        smb_reconcile
        if [ "$HAS_ORIGINAL" = "true" ] && [ "$HAS_TMP" = "false" ]; then
          log "Rollback failed because the original swap had actually already succeeded (the destination name was already taken by it) — that's the correct outcome, not an error. Continuing."
          smb_raw del "$REL_DIR" "$REMOTE_TMP" >/dev/null 2>&1 || true
        else
          print_manual_recovery
          exit 8
        fi
      fi
    fi
  fi

  REMOTE_TMP_PENDING=""
  journal_write "commit_done"
}

print_manual_recovery() {
  log "!! MANUAL ACTION REQUIRED — the movie is not at its expected filename."
  log "   Nothing was deleted. Files should be present in: $REL_DIR/"
  log "   To finish the swap by hand:"
  log "     smbclient \"//${SERVER}/${SHARE}\" -A $AUTHFILE -m SMB3 -D \"$REL_DIR\" -c 'rename \"$REMOTE_TMP\" \"$ORIGINAL_NAME\"'"
  log "   ...or to put things back exactly as they were:"
  log "     smbclient \"//${SERVER}/${SHARE}\" -A $AUTHFILE -m SMB3 -D \"$REL_DIR\" -c 'rename \"$BACKUP_NAME\" \"$ORIGINAL_NAME\"'"
}

verify_remote() {
  local i=0 ok=false
  local final_size local_size
  local_size="$(stat -c '%s' "$LOCAL_OUT")"
  while [ $i -lt "$SMB_VISIBILITY_RETRIES" ]; do
    if [ -e "$SRC" ] && [ -e "$BACKUP_PATH" ]; then
      final_size="$(stat -c '%s' "$SRC")"
      if [ "$final_size" = "$local_size" ]; then ok=true; break; fi
    fi
    sleep "$SMB_VISIBILITY_SLEEP"
    i=$((i + 1))
  done
  if [ "$ok" != "true" ]; then
    print_manual_recovery
    exit 8
  fi

  local backup_size
  backup_size="$(stat -c '%s' "$BACKUP_PATH")"
  [ "$backup_size" = "$SRC_SIZE" ] || { print_manual_recovery; exit 8; }

  local final_dur final_count
  final_dur="$("$FFPROBE" -v error -show_entries format=duration -of default=nw=1:nk=1 -i "$SRC" 2>/dev/null || echo "")"
  final_count="$("$FFPROBE" -v error -show_entries stream=index -of csv=p=0 -i "$SRC" 2>/dev/null | grep -c . || true)"
  if [ -z "$final_dur" ] || ! within_tolerance "$final_dur" "$SRC_DURATION" "$DURATION_TOLERANCE_S" || [ "$final_count" != "$SRC_STREAM_COUNT" ]; then
    print_manual_recovery
    exit 8
  fi

  journal_clear
}

log_result() {
  local status="$1"
  mkdir -p "$LOG_DIR"
  chmod 700 "$LOG_DIR" 2>/dev/null || true
  local line="RESULT|$(date -Is)|$status|${SRC:-}|${EXT_LOWER:-}|${AUDIO_CH:-}|${IN_I:-}|${IN_LRA:-}|${IN_TP:-}|${DECISION:-}|${OUT_CH:-}|${OUT_I:-}|${OUT_LRA:-}|${OUT_TP:-}|$SECONDS"
  printf '%s\n' "$line" >>"$LOG_DIR/audiofix.log"
  chmod 600 "$LOG_DIR/audiofix.log" 2>/dev/null || true
}

main() {
  parse_args "$@"
  require_deps
  acquire_lock
  write_progress_status "Starting" 0
  check_startup_journal

  if [ -z "$POSITIONAL" ]; then
    POSITIONAL="$(run_picker)"
  fi

  resolve_target "$POSITIONAL"
  validate_source
  probe_default_audio_stream
  run_loudnorm_analysis
  decide_fix

  if [ "$DECISION" = "NONE" ]; then
    log "$(basename -- "$SRC")"
    log "  audio: ${AUDIO_CH}ch   loudness ${IN_I} LUFS   range ${IN_LRA} LU   peak ${IN_TP} dBTP"
    log "  decision: no change needed (range ${IN_LRA} LU is at or below the ${LRA_THRESHOLD} LU threshold)"
    log_result "OK_NOFIX"
    exit 0
  fi

  build_ffmpeg_cmd

  if [ "$DRY_RUN" = "true" ]; then
    log "$(basename -- "$SRC")"
    log "  audio: ${AUDIO_CH}ch   loudness ${IN_I} LUFS   range ${IN_LRA} LU   peak ${IN_TP} dBTP"
    log "  decision: $DECISION"
    log "  DRY RUN — nothing was changed. Would run:"
    log "    ${FFMPEG_CMD[*]}"
    LOCAL_OUT=""
    log_result "DRYRUN"
    exit 0
  fi

  run_ffmpeg_fix
  verify_local

  detect_cifs_mount
  if [ "$ON_CIFS" != "true" ]; then
    log "Target is not on a CIFS mount; fixed file left at $LOCAL_OUT"
    KEEP_LOCAL_OUT=true
    log_result "OK_LOCAL_ONLY"
    exit 0
  fi

  nas_preflight
  write_back_to_nas
  verify_remote

  log "$(basename -- "$SRC")"
  log "  decision: $DECISION"
  log "  verified through $ON_CIFS_MP — swap complete."

  local del_r del_status
  del_r="$(smb_op del "$REL_DIR" "$BACKUP_NAME")"
  del_status="${del_r%%$'\x1e'*}"
  if [ "$del_status" = "OK" ]; then
    log "  original deleted (fix was verified, so it is no longer kept as a backup)."
  else
    log "  WARNING: fix succeeded but the original ($BACKUP_NAME) could not be auto-deleted: ${del_r#*$'\x1e'}"
    log "  It is safe but should be removed by hand."
  fi

  log "  Reminder: Jellyfin caches stream info in its own database. Run Dashboard ->"
  log "  Scheduled Tasks -> Scan Media Library before testing playback, or it may"
  log "  still try to serve the old track layout."
  log_result "OK_FIXED"
}

main "$@"
