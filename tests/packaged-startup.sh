#!/bin/sh
set -eu
# Launch the untouched package through its normal application entrypoint.
/opt/your-bot/your-bot > /tmp/packaged-startup.log 2>&1 &
desktop_pid=$!
trap 'kill "$desktop_pid" 2>/dev/null || true; wait "$desktop_pid" 2>/dev/null || true' EXIT
attempt=0
while [ "$attempt" -lt 100 ]; do
  kill -0 "$desktop_pid"
  case "$(xwininfo -root -tree)" in
    *'"Your Bot"'*)
      # X11 registers the window before Electron finishes loading its page.
      # Let that initial load settle before testing liveness and quitting.
      sleep 1
      kill -0 "$desktop_pid"
      case "$(cat /tmp/packaged-startup.log)" in
        *'Desktop startup failed'*) cat /tmp/packaged-startup.log >&2; exit 1 ;;
      esac
      echo 'PACKAGED_ENTRYPOINT_OK: standalone application displayed its desktop window'
      exit 0
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 0.1
done
echo 'Packaged application did not display its window' >&2
exit 1
