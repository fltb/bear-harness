#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${RELEASE_GPG_PRIVATE_KEY:?Missing release private key}"
: "${RELEASE_GPG_PASSPHRASE:?Missing release passphrase}"
fingerprint=921C86924526C92ADB8924835151AEB0350CE3ED
checksum_file=${1:?Pass the checksum file}
[[ -s "$checksum_file" ]] || { echo 'Missing checksums' >&2; exit 1; }
signing_home=$(mktemp -d)
cleanup() {
  gpgconf --homedir "$signing_home" --kill all || true
  rm -rf -- "$signing_home"
}
trap cleanup EXIT
export GNUPGHOME="$signing_home"
printf '%s\n' "$RELEASE_GPG_PRIVATE_KEY" | gpg --batch --quiet --import
unset RELEASE_GPG_PRIVATE_KEY
gpg --batch --with-colons --list-secret-keys "$fingerprint" |
  awk -F: -v expected="$fingerprint" '$1 == "fpr" && $10 == expected { found=1 } END { exit !found }'
printf '%s' "$RELEASE_GPG_PASSPHRASE" |
  gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
    --local-user "$fingerprint!" --armor --detach-sign \
    --output "$checksum_file.asc" "$checksum_file"
unset RELEASE_GPG_PASSPHRASE
# Verify against the committed public key, independent of the imported private key.
gpg --batch --yes --dearmor --output "$signing_home/public.gpg" config/release-public.asc
gpgv --keyring "$signing_home/public.gpg" "$checksum_file.asc" "$checksum_file"
