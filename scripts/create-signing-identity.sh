#!/bin/bash
# Run manually on the build Mac only. Never run with bash -x.
set +x
set +a
unset backup_password confirmation
set -euo pipefail
umask 077

name='Quota Widgets Code Signing'
keychain="$HOME/Library/Keychains/login.keychain-db"
backup_dir="$HOME/Documents/quota-signing"
[[ $(uname -s) == Darwin ]] || { echo '此腳本僅限 macOS 建置機。' >&2; exit 1; }
[[ -t 0 && -t 1 ]] || { echo '請在互動式終端機執行，以安全輸入密碼及完成 GUI 授權。' >&2; exit 1; }
[[ -f "$keychain" ]] || { echo "找不到登入鑰匙圈：$keychain" >&2; exit 1; }

# A certificate without a private key or without trust still counts as existing.
# Include login explicitly even if it is absent from the search list.
if security find-certificate -c "$name" >/dev/null 2>&1 ||
   security find-certificate -c "$name" "$keychain" >/dev/null 2>&1; then
  echo "已存在同名憑證／身分：${name}。停止，不覆蓋、不重建。" >&2
  echo '若前次中斷，請在「鑰匙圈存取」檢查私鑰與僅限程式碼簽章的信任；備份可用於還原原身分。' >&2
  exit 1
fi

work=$(mktemp -d /private/tmp/quota-signing.XXXXXX)
trap 'unset backup_password confirmation; rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$work/openssl.cnf" <<'CONFIG'
[req]
prompt = no
distinguished_name = subject
x509_extensions = signing
[subject]
CN = Quota Widgets Code Signing
[signing]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = codeSigning
CONFIG
openssl req -new -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
  -config "$work/openssl.cnf" -keyout "$work/key.pem" -out "$work/cert.pem"

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup="$backup_dir/quota-signing-$(date +%Y%m%d-%H%M%S)-$$.p12"
[[ ! -e "$backup" ]] || { echo '備份檔已存在，停止。' >&2; exit 1; }
while :; do
  IFS= read -r -s -p '設定 .p12 備份密碼（不可空白）：' backup_password
  printf '\n'
  IFS= read -r -s -p '再次輸入備份密碼：' confirmation
  printf '\n'
  if [[ -n "$backup_password" && "$backup_password" == "$confirmation" ]]; then break; fi
  echo '密碼不可空白，且兩次必須相同。'
done
# Password travels through an anonymous pipe, never argv, environment or logs.
printf '%s\n' "$backup_password" | openssl pkcs12 -export \
  -inkey "$work/key.pem" -in "$work/cert.pem" -name "$name" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha256 \
  -passout stdin -out "$backup"
unset backup_password confirmation
chmod 600 "$backup"
echo "已建立加密備份：${backup}（請另存至安全離線位置）"
echo '接下來由 macOS GUI 詢問剛才的備份密碼；登入鑰匙圈如需解鎖，也請在 GUI 完成。'
security import "$backup" -k "$keychain" -f pkcs12 -T /usr/bin/codesign

echo '僅在本建置機設定 user-domain 的 codeSign 信任；請親手完成 macOS GUI 授權。'
security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$work/cert.pem"
# No explicit root override here: verify the trust settings actually took effect.
security verify-cert -c "$work/cert.pem" -p codeSign -k "$keychain" -L
expected=$(openssl x509 -in "$work/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')
identities=$(security find-identity -v -p codesigning "$keychain")
sha1=$(printf '%s\n' "$identities" | awk -v hash="$expected" -v cn="\"$name\"" '$2 == hash && index($0, cn) { print $2 }')
[[ "$sha1" == "$expected" ]] || { echo '信任或私鑰尚未生效，找不到有效 codesigning 身分；未完成。請檢查鑰匙圈，勿重建憑證。' >&2; exit 1; }
printf '信任已生效。%s\nSHA-1: %s\n' "$name" "$sha1"
echo '後續建置會使用此固定身分。請保留此憑證／私鑰，切勿每次發布重新產生。'
