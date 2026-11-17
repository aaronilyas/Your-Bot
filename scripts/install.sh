#!/bin/sh
# Your Bot — Linux installer.
#
#   curl -fsSL https://github.com/aaronilyas/Your-Bot/releases/latest/download/install.sh | sh
#
# Detects the distro's package manager and installs the matching native package from the
# latest GitHub release (deb, rpm or pacman). Anything else gets the AppImage in ~/.local/bin.
# Options (environment): YOUR_BOT_VERSION=v0.1.0 to pin a release, YOUR_BOT_FORMAT=appimage
# to force the AppImage, YOUR_BOT_NO_DEPS=1 to skip the optional sandbox prerequisites.
set -eu

REPO="aaronilyas/Your-Bot"
VERSION="${YOUR_BOT_VERSION:-latest}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = Linux ] || die "this script is for Linux; download the macOS/Windows installer from https://github.com/$REPO/releases"
have curl || die "curl is required"

SUDO=""; CAN_ROOT=1
if [ "$(id -u)" -ne 0 ]; then
  if have sudo; then SUDO="sudo"; elif have doas; then SUDO="doas"; else CAN_ROOT=""; fi
fi

case "$(uname -m)" in
  x86_64|amd64) DEB_ARCH=amd64; RPM_ARCH=x86_64; PAC_ARCH=x64; AI_ARCH=x86_64 ;;
  aarch64|arm64) DEB_ARCH=arm64; RPM_ARCH=aarch64; PAC_ARCH=aarch64; AI_ARCH=arm64 ;;
  *) die "unsupported CPU architecture: $(uname -m) (x86_64 and arm64 are supported)" ;;
esac

if [ -n "${YOUR_BOT_RELEASE_API:-}" ]; then API="$YOUR_BOT_RELEASE_API"   # mirrors / testing
elif [ "$VERSION" = latest ]; then API="https://api.github.com/repos/$REPO/releases/latest"
else API="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
fi
say "Looking up release ($VERSION)"
ASSETS=$(curl -fsSL "$API" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(http[^"]*\)"/\1/') \
  || die "could not query $API"

asset() { printf '%s\n' "$ASSETS" | grep -E "$1" | head -n1; }

FORMAT="${YOUR_BOT_FORMAT:-}"
if [ -z "$FORMAT" ] && [ -n "$CAN_ROOT" ]; then
  if have apt-get && have dpkg; then FORMAT=deb
  elif have dnf || have yum || have zypper; then FORMAT=rpm
  elif have pacman; then FORMAT=pacman
  fi
fi
FORMAT="${FORMAT:-appimage}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch() {
  [ -n "$1" ] || die "no $FORMAT package for $(uname -m) in this release"
  FILE="$TMP/$(basename "$1")"
  say "Downloading $(basename "$1")"
  curl -fL --progress-bar -o "$FILE" "$1"
}

deps() {
  [ -z "${YOUR_BOT_NO_DEPS:-}" ] || return 0
  say "Installing sandbox prerequisites (python3, venv, bubblewrap) for the strict execution profile"
  "$@" || say "Could not install prerequisites; strict bots stay unavailable until they are installed"
}

case "$FORMAT" in
  deb)
    fetch "$(asset "linux-$DEB_ARCH\.deb$")"
    $SUDO apt-get update -qq || true
    $SUDO apt-get install -y "$FILE"
    deps $SUDO apt-get install -y python3 python3-venv bubblewrap gcc libc6-dev
    ;;
  rpm)
    fetch "$(asset "linux-$RPM_ARCH\.rpm$")"
    if have dnf; then
      $SUDO dnf install -y "$FILE"
      deps $SUDO dnf install -y python3 bubblewrap gcc glibc-devel
    elif have zypper; then
      $SUDO zypper --non-interactive install --allow-unsigned-rpm "$FILE"
      deps $SUDO zypper --non-interactive install python3 bubblewrap gcc glibc-devel
    else
      $SUDO yum install -y "$FILE"
      deps $SUDO yum install -y python3 bubblewrap gcc glibc-devel
    fi
    ;;
  pacman)
    fetch "$(asset "linux-$PAC_ARCH\.pacman$")"
    $SUDO pacman -U --noconfirm "$FILE"
    deps $SUDO pacman -S --needed --noconfirm python bubblewrap gcc
    ;;
  appimage)
    fetch "$(asset "linux-$AI_ARCH\.AppImage$")"
    mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
    install -m 0755 "$FILE" "$HOME/.local/bin/your-bot.AppImage"
    cat > "$HOME/.local/share/applications/your-bot.desktop" <<EOF
[Desktop Entry]
Name=Your Bot
Comment=Private, local-first conversational agent
Exec=$HOME/.local/bin/your-bot.AppImage %U
Terminal=false
Type=Application
Categories=Utility;
EOF
    say "Installed to ~/.local/bin/your-bot.AppImage (AppImages need FUSE 2: libfuse2 / fuse2 / fuse-libs)"
    ;;
  *) die "unknown YOUR_BOT_FORMAT: $FORMAT (deb, rpm, pacman, appimage)" ;;
esac

if [ "$FORMAT" = appimage ]; then
  say "Your Bot is installed. Launch it from your app menu or run: ~/.local/bin/your-bot.AppImage"
else
  say "Your Bot is installed. Launch it from your app menu or run: your-bot"
fi
