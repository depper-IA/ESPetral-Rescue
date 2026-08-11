#!/usr/bin/env bash
# upload-firmware.sh — sube binario ESP32 a S3 y actualiza manifest.json
# Uso: CALI_OTA_URL=https://cdn.example.com ./upload-firmware.sh <version> <bin>
#       ./upload-firmware.sh --placeholder <version> <bin>   (dry-run local)
# Variables opcionales: CALI_AWS_PROFILE, CALI_S3_BUCKET, CALI_CLOUDFRONT_ID

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_FILE="${SCRIPT_DIR}/firmware/manifest.json"
PLACEHOLDER_URL="https://example.invalid"

log()   { printf "[OTA] %s\n" "$*"; }
errlog(){ printf "[OTA] ERROR: %s\n" "$*" >&2; }

USE_PLACEHOLDER=0
[[ "${1:-}" == "--placeholder" ]] && { USE_PLACEHOLDER=1; shift; }

VERSION="${1:-}"; BIN_PATH="${2:-}"
[[ -z "$VERSION" ]]  && { errlog "Falta <version>"; exit 1; }
[[ -z "$BIN_PATH" ]] && { errlog "Falta <bin>"; exit 1; }
[[ ! -f "$BIN_PATH" ]] && { errlog "Binario no existe: $BIN_PATH"; exit 1; }
[[ ! -r "$BIN_PATH" ]] && { errlog "Binario no legible: $BIN_PATH"; exit 1; }
BIN_SIZE=$(wc -c < "$BIN_PATH" | tr -d '[:space:]')
[[ "$BIN_SIZE" -le 0 ]] && { errlog "Binario vacío"; exit 1; }

# Resolver OTA URL
OTA_URL="${CALI_OTA_URL:-}"
if [[ -z "$OTA_URL" ]]; then
    if [[ $USE_PLACEHOLDER -eq 1 ]]; then
        OTA_URL="$PLACEHOLDER_URL"
        errlog "Usando URL placeholder: $OTA_URL"
    else
        errlog "CALI_OTA_URL no definida. Define la variable o usa --placeholder."
        errlog "Ej: CALI_OTA_URL=https://cdn.example.com $0 $VERSION $BIN_PATH"
        exit 1
    fi
fi
OTA_URL="${OTA_URL%/}"

# SHA-256 del binario
log "Calculando SHA-256 de $BIN_PATH ($BIN_SIZE bytes)..."
if command -v sha256sum >/dev/null 2>&1; then
    SHA256=$(sha256sum "$BIN_PATH" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
    SHA256=$(shasum -a 256 "$BIN_PATH" | awk '{print $1}')
else
    errlog "No se encontró sha256sum ni shasum"; exit 1
fi
log "SHA-256: $SHA256"

BIN_FILENAME="firmware-${VERSION}.bin"
BINARY_URL="${OTA_URL}/firmware/${BIN_FILENAME}"

# Escribir manifest local (con escape básico de comillas/backslash)
mkdir -p "$(dirname "$MANIFEST_FILE")"
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
cat > "$MANIFEST_FILE" <<EOF
{
  "version": "$(esc "$VERSION")",
  "binary_url": "$(esc "$BINARY_URL")",
  "binary_size": ${BIN_SIZE},
  "sha256": "$(esc "$SHA256")"
}
EOF
log "Manifest local escrito: $MANIFEST_FILE"

# Subida a S3 (opcional). Sin bucket → dry-run local.
S3_BUCKET="${CALI_S3_BUCKET:-}"
if [[ -z "$S3_BUCKET" ]]; then
    log "dry-run local: no se subió a S3 (faltan CALI_S3_BUCKET)"
    log "Binario destino: $BINARY_URL"
    exit 0
fi

AWS_ARGS=()
[[ -n "${CALI_AWS_PROFILE:-}" ]] && AWS_ARGS+=(--profile "$CALI_AWS_PROFILE")
BIN_S3="s3://${S3_BUCKET}/firmware/${BIN_FILENAME}"
MANIFEST_S3="s3://${S3_BUCKET}/firmware/manifest.json"

log "Subiendo binario a $BIN_S3..."
aws "${AWS_ARGS[@]}" s3 cp "$BIN_PATH" "$BIN_S3" --cache-control no-cache \
    || { errlog "Subida de binario falló"; exit 2; }

log "Subiendo manifest a $MANIFEST_S3..."
aws "${AWS_ARGS[@]}" s3 cp "$MANIFEST_FILE" "$MANIFEST_S3" \
    --cache-control no-cache --content-type "application/json" \
    || { errlog "Subida de manifest falló"; exit 2; }

# Invalidación CloudFront (opcional)
CF_ID="${CALI_CLOUDFRONT_ID:-}"
if [[ -n "$CF_ID" ]]; then
    log "Invalidando CloudFront $CF_ID /firmware/*..."
    aws "${AWS_ARGS[@]}" cloudfront create-invalidation \
        --distribution-id "$CF_ID" --paths "/firmware/*" \
        || { errlog "Invalidación CF falló"; exit 2; }
else
    log "CALI_CLOUDFRONT_ID no definida, omitiendo invalidación"
fi

log "Versión desplegada: $VERSION"
exit 0
