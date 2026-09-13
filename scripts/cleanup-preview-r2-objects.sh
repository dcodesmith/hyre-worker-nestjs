#!/usr/bin/env bash
# Delete only the isolated preview R2 prefix from both development buckets.
# Missing objects are success; unexpected errors fail after both buckets.
set -u

PREVIEW_PREFIX="${PREVIEW_PREFIX:-}"
if [[ ! "$PREVIEW_PREFIX" =~ ^previews/pr-[1-9][0-9]*/$ ]]; then
  echo "Invalid preview storage prefix."
  exit 1
fi

required_keys=(
  R2_ACCOUNT_ID
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_IMAGES_BUCKET_NAME
  R2_DOCS_BUCKET_NAME
)
for key in "${required_keys[@]}"; do
  if [ -z "${!key:-}" ]; then
    echo "Failed to delete preview R2 objects: ${key} is unset."
    exit 1
  fi
done

if ! command -v rclone >/dev/null 2>&1; then
  echo "Failed to delete preview R2 objects: rclone is not installed."
  exit 1
fi

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION AWS_SESSION_TOKEN AWS_EC2_METADATA_DISABLED

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

failed=0
for bucket in "${R2_IMAGES_BUCKET_NAME}" "${R2_DOCS_BUCKET_NAME}"; do
  output=""
  status=0
  output="$(rclone delete "r2:${bucket}/${PREVIEW_PREFIX}" 2>&1)" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "Deleted preview objects from '${bucket}'."
    continue
  fi

  echo "Failed to delete preview objects from '${bucket}':"
  echo "$output"
  failed=1
done

exit "$failed"
