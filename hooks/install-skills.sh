#!/bin/sh
# Behind the Skills tab's Install Recommended Skills button. It needs only curl and tar, so
# nobody has to have git, the GitHub CLI or a GitHub account, and it downloads each author's
# own repository at a commit the hub was tested with.
#
#   install-skills.sh copy <owner/repo> <commit> <path in repo> <skill>...
#     Copies skills into the skills folder, with the repository's license and notice. A skill
#     already there is left exactly as it is. ON_DEMAND lists skills that run only when asked.
#
#   install-skills.sh plugin <owner/repo> <commit> <marketplace> <plugin>
#     Keeps the repository in a folder and installs its plugin from there.

set -eu

config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$config"
work="$(mktemp -d "$config/.mods-hub-XXXXXX")"
trap 'rm -rf "$work"' EXIT

download() {
  mkdir -p "$work/repo"
  curl -fsSL --retry 2 --max-time 180 "https://codeload.github.com/$1/tar.gz/$2" -o "$work/repo.tar.gz"
  tar -xzf "$work/repo.tar.gz" -C "$work/repo" --strip-components=1
}

# The desktop app keeps its own copy of the command line, which may not be on the PATH.
find_claude() {
  if [ -n "${CLAUDE_CODE_EXECPATH:-}" ] && [ -x "$CLAUDE_CODE_EXECPATH" ]; then
    printf '%s\n' "$CLAUDE_CODE_EXECPATH"
    return 0
  fi
  if command -v claude >/dev/null 2>&1; then
    command -v claude
    return 0
  fi
  found=""
  for candidate in \
    "$HOME/.local/bin/claude" \
    "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude \
    "$HOME/Library/Application Support/Claude/claude-code/"*/claude; do
    if [ -x "$candidate" ]; then found="$candidate"; fi
  done
  if [ -n "$found" ]; then
    printf '%s\n' "$found"
    return 0
  fi
  echo "Couldn't find Claude Code's command line" >&2
  return 1
}

is_on_demand() {
  for name in ${ON_DEMAND:-}; do
    if [ "$name" = "$1" ]; then return 0; fi
  done
  return 1
}

copy_skills() {
  repo="$1"; commit="$2"; path="$3"; shift 3
  skills="$config/skills"
  mkdir -p "$skills"
  download "$repo" "$commit"
  for skill in "$@"; do
    target="$skills/$skill"
    if [ -e "$target" ] || [ -L "$target" ]; then
      echo "kept $skill"
      continue
    fi
    source="$work/repo/$path/$skill"
    if [ ! -f "$source/SKILL.md" ]; then
      echo "$skill isn't in $repo" >&2
      exit 1
    fi
    staged="$work/staged-$skill"
    cp -R "$source" "$staged"
    for notice in "$work/repo"/LICENSE* "$work/repo/NOTICE.md"; do
      if [ -f "$notice" ]; then cp "$notice" "$staged/"; fi
    done
    if is_on_demand "$skill"; then
      awk 'NR == 1 { print; if ($0 == "---") print "disable-model-invocation: true"; next } { print }' \
        "$staged/SKILL.md" >"$staged/SKILL.md.new"
      mv "$staged/SKILL.md.new" "$staged/SKILL.md"
    fi
    mv "$staged" "$target"
    echo "installed $skill"
  done
}

install_plugin() {
  repo="$1"; commit="$2"; marketplace="$3"; plugin="$4"
  claude_cli="$(find_claude)"
  home="$config/mods-hub/$plugin"
  download "$repo" "$commit"
  mkdir -p "$config/mods-hub"
  rm -rf "$home"
  mv "$work/repo" "$home"
  "$claude_cli" plugin marketplace add "$home"
  "$claude_cli" plugin install "$plugin@$marketplace"
  echo "installed $plugin"
}

case "${1:-}" in
  copy) shift; copy_skills "$@" ;;
  plugin) shift; install_plugin "$@" ;;
  *) echo "Unknown install step: ${1:-none}" >&2; exit 2 ;;
esac
