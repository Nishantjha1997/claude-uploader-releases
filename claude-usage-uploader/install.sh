#!/usr/bin/env bash
# Claude Usage Uploader — macOS & Linux Installer
# -------------------------------------------------------
# Usage:
#   chmod +x install.sh
#   ./install.sh            # installs to /usr/local/ClaudeUsageUploader (needs sudo on Linux)
#   ./install.sh --user     # installs to ~/ClaudeUsageUploader (no sudo needed)
# -------------------------------------------------------
set -euo pipefail

# -------------------- CONFIG --------------------
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

USER_MODE=false
for arg in "$@"; do
  [ "$arg" = "--user" ] && USER_MODE=true
done

if $USER_MODE; then
  INSTALL_DIR="$HOME/ClaudeUsageUploader"
else
  INSTALL_DIR="/usr/local/ClaudeUsageUploader"
fi

# -------------------- PLATFORM DETECTION --------------------
echo "=== Claude Usage Uploader Installer ==="
echo "Platform : $PLATFORM ($ARCH)"
echo "Install  : $INSTALL_DIR"
echo ""

case "$PLATFORM" in
  Darwin)
    if [ "$ARCH" = "arm64" ]; then
      BINARY_NAME="ClaudeUsageUploader-mac-arm64"
    else
      BINARY_NAME="ClaudeUsageUploader-mac-x64"
    fi
    ;;
  Linux)
    BINARY_NAME="ClaudeUsageUploader-linux-x64"
    ;;
  *)
    echo "Error: Unsupported platform '$PLATFORM'. This installer supports macOS and Linux only."
    echo "On Windows, use the ClaudeUsageUploaderSetup-*.exe installer."
    exit 1
    ;;
esac

BINARY_PATH="$SCRIPT_DIR/$BINARY_NAME"
KEY_FILE="$SCRIPT_DIR/service-account-key.json"

# -------------------- PRE-FLIGHT CHECKS --------------------
if [ ! -f "$BINARY_PATH" ]; then
  echo "Error: Binary not found: $BINARY_PATH"
  echo ""
  echo "Expected one of the following files next to install.sh:"
  echo "  ClaudeUsageUploader-mac-x64     (macOS Intel)"
  echo "  ClaudeUsageUploader-mac-arm64   (macOS Apple Silicon)"
  echo "  ClaudeUsageUploader-linux-x64   (Linux x64)"
  echo ""
  echo "Build commands (run from project root):"
  echo "  macOS x64:   npx pkg claude-usage-uploader.js --target node16-macos-x64 --output ClaudeUsageUploader-mac-x64"
  echo "  macOS arm64: npx pkg claude-usage-uploader.js --target node16-macos-arm64 --output ClaudeUsageUploader-mac-arm64"
  echo "  Linux x64:   npx pkg claude-usage-uploader.js --target node16-linux-x64 --output ClaudeUsageUploader-linux-x64"
  exit 1
fi

if [ ! -f "$KEY_FILE" ]; then
  echo "Error: service-account-key.json not found in $SCRIPT_DIR"
  echo "Place the Google service account key file beside install.sh and run again."
  exit 1
fi

# -------------------- INSTALL --------------------
if [ ! -d "$INSTALL_DIR" ]; then
  if $USER_MODE; then
    mkdir -p "$INSTALL_DIR"
  else
    if [ "$(id -u)" -ne 0 ]; then
      echo "Installing to $INSTALL_DIR requires sudo. Re-run with sudo or use --user flag."
      exit 1
    fi
    mkdir -p "$INSTALL_DIR"
  fi
fi

echo "Copying files..."
cp "$BINARY_PATH" "$INSTALL_DIR/ClaudeUsageUploader"
cp "$KEY_FILE"    "$INSTALL_DIR/service-account-key.json"
chmod +x "$INSTALL_DIR/ClaudeUsageUploader"

echo "Files installed to $INSTALL_DIR"
echo ""

# -------------------- FIRST-TIME SETUP --------------------
echo "Running first-time setup..."
echo "(You will be prompted to enter your name.)"
echo ""

"$INSTALL_DIR/ClaudeUsageUploader"

# -------------------- DONE --------------------
echo ""
echo "=== Installation complete! ==="
if [ "$PLATFORM" = "Darwin" ]; then
  echo "Scheduler : macOS LaunchAgent (runs every Monday at 09:00)"
  echo "To check  : launchctl list | grep sigmasolve"
  echo "To remove : launchctl unload ~/Library/LaunchAgents/com.sigmasolve.claudeusageuploader.plist"
else
  echo "Scheduler : crontab entry (runs every Monday at 09:00)"
  echo "To check  : crontab -l"
  echo "To remove : crontab -e  (delete the ClaudeUsageUploader line)"
fi
echo "Log file  : /tmp/claude-uploader.log"
echo ""
