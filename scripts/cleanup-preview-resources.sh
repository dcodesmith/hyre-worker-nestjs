#!/usr/bin/env bash
# Destroy PR preview resources. Missing resources are success; unexpected
# errors fail the script after attempting every resource.
set -u

is_missing_neon_branch() {
  local output="$1"
  local branch="$2"
  printf '%s' "$output" | grep -Fqi "Branch $branch not found" ||
    printf '%s' "$output" | grep -Fqi "Branch '$branch' not found in project"
}

is_missing_fly_app() {
  local output="$1"
  local app="$2"
  printf '%s' "$output" | grep -Fqi "Could not find App \"$app\""
}

destroy_neon_branch() {
  local branch="${NEON_BRANCH:-}"
  local project_id="${NEON_PROJECT_ID:-}"

  if [ -z "$branch" ] || [ -z "$project_id" ]; then
    echo "Failed to destroy Neon branch: NEON_BRANCH or NEON_PROJECT_ID is unset."
    return 1
  fi

  if ! command -v neonctl >/dev/null 2>&1; then
    echo "Failed to destroy Neon branch '$branch': neonctl is not installed."
    return 1
  fi

  local output=""
  local status=0
  output="$(neonctl branches delete "$branch" --project-id "$project_id" 2>&1)" || status=$?

  if [ "$status" -eq 0 ]; then
    echo "Destroyed Neon branch '$branch'."
    return 0
  fi

  if is_missing_neon_branch "$output" "$branch"; then
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
    echo "Failed to destroy Fly app: app name is empty."
    return 1
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

  if is_missing_fly_app "$output" "$app"; then
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
