#!/usr/bin/env bash
# KoVault: Google Cloud setup (sign-in + Google Drive) and Android signing.
#
# Google has no public API for the OAuth consent screen or for Sign-in OAuth clients,
# so those steps open the right Cloud Console page (with your project preselected)
# and wait for you. Everything else is automated:
#
#   - create or reuse a Google Cloud project              (gcloud)
#   - enable the Google Drive API                         (gcloud)
#   - write VITE_GOOGLE_CLIENT_ID to .env.local
#   - print SHA-1 fingerprints for Android OAuth clients  (keytool)
#   - optionally create a Play Store upload keystore      (keytool)
#   - optionally store the client ID and keystore in GitHub Actions (gh)
#
# Usage:
#   scripts/setup-google.sh [--project PROJECT_ID] [--skip-gcloud] [--skip-github]
#
# Safe to re-run: existing projects, keystores and .env.local values are reused.

set -euo pipefail

PACKAGE_NAME="com.kovault.app"
DRIVE_API="drive.googleapis.com"
DEV_ORIGINS=("http://localhost:5173" "http://localhost:4173")
KEYSTORE_DIR="${KOVAULT_KEYSTORE_DIR:-$HOME/.kovault}"
KEYSTORE="$KEYSTORE_DIR/kovault-upload.jks"
KEY_ALIAS="upload"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"

PROJECT=""
SKIP_GCLOUD=0
SKIP_GITHUB=0
CLIENT_ID=""
UPLOAD_SHA1=""

# ---------- helpers ----------
if [ -t 1 ]; then
  B=$'\e[1m'; DIM=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else
  B=""; DIM=""; G=""; Y=""; R=""; C=""; N=""
fi
step() { printf '\n%s━━ %s ━━%s\n' "$B$C" "$*" "$N"; }
ok()   { printf '%s✔%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '%s✘ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

ask() { # ask "Question" default -> echoes answer
  local reply
  read -r -p "$1${2:+ [$2]}: " reply </dev/tty || true
  printf '%s' "${reply:-${2:-}}"
}
confirm() { # confirm "Question" [Y|N]
  local def="${2:-Y}" reply
  read -r -p "$1 [$([ "$def" = Y ] && echo Y/n || echo y/N)]: " reply </dev/tty || true
  reply="${reply:-$def}"
  [[ "$reply" =~ ^[Yy] ]]
}
pause() { read -r -p "${DIM}Press Enter when done…${N}" _ </dev/tty || true; }

open_url() {
  printf '  %s%s%s\n' "$B" "$1" "$N"
  if have xdg-open; then xdg-open "$1" >/dev/null 2>&1 || true
  elif have open; then open "$1" >/dev/null 2>&1 || true
  elif have cmd.exe; then cmd.exe /c start "" "$1" >/dev/null 2>&1 || true
  fi
}

sha1_of() { # sha1_of KEYSTORE ALIAS STOREPASS-ENV-VAR
  keytool -list -v -keystore "$1" -alias "$2" -storepass:env "$3" 2>/dev/null |
    sed -n 's/^[[:space:]]*SHA1:[[:space:]]*//p' | head -1
}

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --project=*) PROJECT="${1#*=}"; shift ;;
    --skip-gcloud) SKIP_GCLOUD=1; shift ;;
    --skip-github) SKIP_GITHUB=1; shift ;;
    -h|--help) usage ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

console() { # console PATH -> console URL for this project
  printf 'https://console.cloud.google.com/%s?project=%s' "$1" "$PROJECT"
}

printf '%sKoVault — Google Cloud setup%s\n' "$B" "$N"
echo "This takes about 10 minutes. Steps that need the Cloud Console open in your browser."

# ---------- 1. project ----------
step "1/6  Google Cloud project"
if [ "$SKIP_GCLOUD" = 0 ] && ! have gcloud; then
  warn "gcloud CLI not found — project creation and API enabling will be manual."
  echo "  Install it from https://cloud.google.com/sdk/docs/install to automate these steps."
  SKIP_GCLOUD=1
fi

if [ "$SKIP_GCLOUD" = 0 ]; then
  if ! gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | grep -q .; then
    echo "Signing in to gcloud (a browser window opens)…"
    gcloud auth login
  fi
  account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"
  ok "gcloud signed in as $account"
fi

if [ -z "$PROJECT" ]; then
  suggestion="kovault-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c 6 || true)"
  PROJECT="$(ask "Project ID (6–30 chars: lowercase letters, digits, hyphens; existing or new)" "$suggestion")"
fi
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "Invalid project ID: $PROJECT"

if [ "$SKIP_GCLOUD" = 0 ]; then
  if gcloud projects describe "$PROJECT" --format='value(projectId)' >/dev/null 2>&1; then
    ok "Using existing project $PROJECT"
  else
    echo "Creating project $PROJECT…"
    gcloud projects create "$PROJECT" --name="KoVault" || die "Could not create the project. The ID may be taken — re-run with another --project."
    ok "Created project $PROJECT"
  fi
else
  echo "Create (or select) the project in the console:"
  open_url "https://console.cloud.google.com/projectcreate"
  pause
fi

# ---------- 2. Drive API ----------
step "2/6  Enable the Google Drive API"
if [ "$SKIP_GCLOUD" = 0 ]; then
  if gcloud services list --enabled --project="$PROJECT" --format='value(config.name)' 2>/dev/null | grep -qx "$DRIVE_API"; then
    ok "Drive API already enabled"
  else
    gcloud services enable "$DRIVE_API" --project="$PROJECT"
    ok "Drive API enabled"
  fi
else
  open_url "$(console "apis/library/$DRIVE_API")"
  echo "  Click ${B}Enable${N}."
  pause
fi

# ---------- 3. consent screen ----------
step "3/6  OAuth consent screen (manual — no API exists for this)"
cat <<EOF
In the page that opens (Google Auth Platform):
  a. ${B}Get started / Branding${N}: App name ${B}KoVault${N}, support email = yours, developer contact = yours.
     Skip the logo for now (a logo triggers brand verification).
  b. ${B}Audience${N}: choose ${B}External${N}. Under ${B}Test users${N}, add every Google account you'll test with.
  c. ${B}Data Access → Add or remove scopes${N}: tick
       openid
       .../auth/userinfo.email
       .../auth/userinfo.profile
       .../auth/drive.file   ${DIM}(search "drive.file"; non-sensitive, no Google review needed)${N}
     then ${B}Update${N} and ${B}Save${N}.
EOF
open_url "$(console "auth/overview")"
pause

# ---------- 4. web client ----------
step "4/6  Web OAuth client (used by both web and Android)"
existing=""
[ -f "$ENV_FILE" ] && existing="$(sed -n 's/^VITE_GOOGLE_CLIENT_ID=//p' "$ENV_FILE" | head -1)"
if [ -n "$existing" ] && confirm "Found client ID $existing in .env.local. Keep it?" Y; then
  CLIENT_ID="$existing"
else
  cat <<EOF
In the page that opens:
  a. Application type: ${B}Web application${N}, name: ${B}KoVault Web${N}
  b. Authorized JavaScript origins — add:
EOF
  for o in "${DEV_ORIGINS[@]}"; do printf '       %s\n' "$o"; done
  echo "     (plus your hosted URL later, if you deploy the web version)"
  echo "  c. Leave redirect URIs empty, click ${B}Create${N}, and copy the ${B}Client ID${N} (not the secret)."
  open_url "$(console "auth/clients/create")"
  while :; do
    CLIENT_ID="$(ask "Paste the Client ID")"
    CLIENT_ID="${CLIENT_ID//[[:space:]]/}"
    [[ "$CLIENT_ID" =~ ^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$ ]] && break
    warn "That doesn't look like a client ID (expected 123…-abc….apps.googleusercontent.com)."
  done
fi

if [ -f "$ENV_FILE" ] && grep -q '^VITE_GOOGLE_CLIENT_ID=' "$ENV_FILE"; then
  tmp="$(mktemp)"
  sed "s|^VITE_GOOGLE_CLIENT_ID=.*|VITE_GOOGLE_CLIENT_ID=$CLIENT_ID|" "$ENV_FILE" >"$tmp" && mv "$tmp" "$ENV_FILE"
else
  printf 'VITE_GOOGLE_CLIENT_ID=%s\n' "$CLIENT_ID" >>"$ENV_FILE"
fi
ok "Saved to .env.local (gitignored)"

# ---------- 5. android ----------
step "5/6  Android OAuth clients (one per signing key)"
declare -a SHA_LABELS=() SHA_VALUES=()

if ! have keytool; then
  warn "keytool not found (it ships with the JDK). Install JDK 21 to get SHA-1 fingerprints."
else
  debug_ks="$HOME/.android/debug.keystore"
  if [ -f "$debug_ks" ]; then
    export KOVAULT_DEBUG_PASS="android"
    s="$(sha1_of "$debug_ks" androiddebugkey KOVAULT_DEBUG_PASS)"
    unset KOVAULT_DEBUG_PASS
    if [ -n "$s" ]; then SHA_LABELS+=("Debug (this computer)"); SHA_VALUES+=("$s"); ok "Debug key SHA-1: $s"; fi
  else
    warn "No debug keystore yet ($debug_ks). Build the app once in Android Studio, then re-run this script."
  fi

  if [ -f "$KEYSTORE" ]; then
    ok "Upload keystore exists: $KEYSTORE"
    if confirm "Read its SHA-1 (needs the keystore password)?" Y; then
      read -r -s -p "Keystore password: " KOVAULT_KS_PASS </dev/tty; echo
      export KOVAULT_KS_PASS
      UPLOAD_SHA1="$(sha1_of "$KEYSTORE" "$KEY_ALIAS" KOVAULT_KS_PASS)" || true
      [ -n "$UPLOAD_SHA1" ] || warn "Could not read it — wrong password?"
    fi
  elif confirm "Create a Play Store upload keystore now (at $KEYSTORE, outside the repo)?" Y; then
    mkdir -p "$KEYSTORE_DIR" && chmod 700 "$KEYSTORE_DIR"
    while :; do
      read -r -s -p "New keystore password (min 6 chars): " KOVAULT_KS_PASS </dev/tty; echo
      read -r -s -p "Repeat password: " p2 </dev/tty; echo
      [ "${#KOVAULT_KS_PASS}" -ge 6 ] && [ "$KOVAULT_KS_PASS" = "$p2" ] && break
      warn "Passwords don't match or are too short."
    done
    export KOVAULT_KS_PASS
    owner="$(ask "Your name or organization (stored in the certificate)" "KoVault")"
    owner="${owner//,/ }"
    keytool -genkeypair -v -keystore "$KEYSTORE" -alias "$KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
      -storepass:env KOVAULT_KS_PASS -keypass:env KOVAULT_KS_PASS -dname "CN=$owner" >/dev/null 2>&1 ||
      die "keytool failed to create the keystore"
    chmod 600 "$KEYSTORE"
    UPLOAD_SHA1="$(sha1_of "$KEYSTORE" "$KEY_ALIAS" KOVAULT_KS_PASS)"
    ok "Created $KEYSTORE"
    warn "Back up this file and its password. If you lose them you must ask Google Play to reset your upload key."
  fi
  if [ -n "$UPLOAD_SHA1" ]; then SHA_LABELS+=("Upload key"); SHA_VALUES+=("$UPLOAD_SHA1"); ok "Upload key SHA-1: $UPLOAD_SHA1"; fi
fi

if [ "${#SHA_VALUES[@]}" -gt 0 ]; then
  echo
  echo "Create one ${B}Android${N} client for each fingerprint below (Clients → Create client → Android):"
  for i in "${!SHA_VALUES[@]}"; do
    printf '  %-22s package %s  SHA-1 %s%s%s\n' "${SHA_LABELS[$i]}:" "$PACKAGE_NAME" "$B" "${SHA_VALUES[$i]}" "$N"
  done
  open_url "$(console "auth/clients/create")"
  pause
fi
cat <<EOF
${Y}Later${N}: after your first upload to the Play Console, copy the SHA-1 from
  Test and release → App integrity → App signing  ("App signing key certificate")
and create one more Android client with it. Without it, sign-in fails for users who install from Google Play.
EOF

# ---------- 6. GitHub ----------
step "6/6  GitHub Actions (optional)"
if [ "$SKIP_GITHUB" = 1 ]; then
  echo "Skipped."
elif ! have gh || ! gh auth status >/dev/null 2>&1; then
  warn "GitHub CLI (gh) not installed or not signed in — skipping."
  echo "  Set these by hand under Settings → Secrets and variables → Actions:"
  echo "    variable VITE_GOOGLE_CLIENT_ID; secrets KOVAULT_KEYSTORE_BASE64, KOVAULT_KEYSTORE_PASSWORD, KOVAULT_KEY_ALIAS, KOVAULT_KEY_PASSWORD"
else
  repo="$(cd "$ROOT" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  if [ -z "$repo" ]; then
    warn "Could not detect the GitHub repository — skipping."
  else
    if confirm "Set variable VITE_GOOGLE_CLIENT_ID on $repo?" Y; then
      (cd "$ROOT" && gh variable set VITE_GOOGLE_CLIENT_ID --body "$CLIENT_ID") && ok "Variable set"
    fi
    if [ -f "$KEYSTORE" ] && confirm "Upload the keystore + password as secrets so CI builds a signed Play Store bundle?" N; then
      if [ -z "${KOVAULT_KS_PASS:-}" ]; then
        read -r -s -p "Keystore password: " KOVAULT_KS_PASS </dev/tty; echo
      fi
      (
        cd "$ROOT"
        base64 <"$KEYSTORE" | tr -d '\n' | gh secret set KOVAULT_KEYSTORE_BASE64
        printf '%s' "$KOVAULT_KS_PASS" | gh secret set KOVAULT_KEYSTORE_PASSWORD
        printf '%s' "$KOVAULT_KS_PASS" | gh secret set KOVAULT_KEY_PASSWORD
        printf '%s' "$KEY_ALIAS" | gh secret set KOVAULT_KEY_ALIAS
      ) && ok "Secrets set — the next CI run produces a signed .aab"
    fi
  fi
fi
unset KOVAULT_KS_PASS p2 2>/dev/null || true

# ---------- summary ----------
step "Done"
cat <<EOF
Project:     $PROJECT
Client ID:   $CLIENT_ID  (in .env.local)
Package:     $PACKAGE_NAME
${UPLOAD_SHA1:+Upload key:  $KEYSTORE
}
Test it:
  npm install && npm run dev      → http://localhost:5173 → "Sign in with Google"
  A ${B}KoVault${N} folder with ${B}kovault-vault.json.gz${N} should appear in your Google Drive.

Before going public: Audience → ${B}Publish app${N} (needs a privacy policy URL — host PRIVACY.md somewhere public).
New credentials can take a few minutes (occasionally hours) to start working.
EOF
