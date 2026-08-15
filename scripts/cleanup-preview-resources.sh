#!/usr/bin/env bash
# Destroy PR preview resources. Missing resources are success; unexpected
# errors fail the script after attempting every resource.
# Keep missing-resource needles in sync with scripts/preview-cleanup.ts.
set -u

is_missing() {
  local output="$1"
  printf '%s' "$output" | grep -Eiq 'not found|could not find app|could not find|does not exist|no app found|app not found'
}

destroy_neon_branch() {
  local branch="${NEON_BRANCH:-}"
  local project_id="${NEON_PROJECT_ID:-}"

  if [ -z "$branch" ] || [ -z "$project_id" ]; then
    echo "Skipping Neon delete: NEON_BRANCH or NEON_PROJECT_ID is unset."
    return 0
  fi

  if ! command -v neonctl >/dev/null 2>&1; then
    echo "Skipping Neon delete: neonctl is not installed."
    return 0
  fi

  local output=""
  local status=0
  output="$(neonctl branches delete "$branch" --project-id "$project_id" 2>&1)" || status=$?

  if [ "$status" -eq 0 ]; then
    echo "Destroyed Neon branch '$branch'."
    return 0
  fi

  if is_missing "$output"; then
    echo "Neon branch '$branch' already gone."
    return 0
  fi

  echo "Failed to destroy Neon branch '$branch':"
  echo "$output"
  return 1
}

destroy_fly_app() {
  local app="$1"

  if [ -z "$app" ]; then
    echo "Skipping Fly destroy: app name is empty."
    return 0
  fi

  if ! command -v flyctl >/dev/null 2>&1; then
    echo "Failed to destroy Fly app '$app': flyctl is not installed."
    return 1
  fi

  local output=""
  local status=0
  output="$(flyctl apps destroy "$app" --yes 2>&1)" || status=$?

  if [ "$status" -eq 0 ]; then
    echo "Destroyed Fly app '$app'."
    return 0
  fi

  if is_missing "$output"; then
    echo "Fly app '$app' already gone."
    return 0
  fi

  echo "Failed to destroy Fly app '$app':"
  echo "$output"
  return 1
}

failed=0
destroy_neon_branch || failed=1
destroy_fly_app "${PREVIEW_APP:-}" || failed=1
destroy_fly_app "${REDIS_APP:-}" || failed=1
exit "$failed"
