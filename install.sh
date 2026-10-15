#!/usr/bin/env bash
# Claude & Codex Usage — installer for the GNOME Shell top-bar indicator (Ubuntu, GNOME Shell 45+).
#
#   curl -fsSL https://raw.githubusercontent.com/SuKiWSN/claude-codex-usage/main/install.sh | bash
#
#   ./install.sh               install or upgrade (from this checkout, or downloads the repo)
#   ./install.sh --dev         symlink this checkout instead of copying (for development)
#   ./install.sh --uninstall   remove the extension (add --purge to also delete cached usage data)
#
# Environment: CCU_REPO=owner/name and CCU_REF=branch-or-tag pick what to download.
set -euo pipefail

UUID="claude-usage@claude-toolkit"
REPO="${CCU_REPO:-SuKiWSN/claude-codex-usage}"
REF="${CCU_REF:-main}"
EXT_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
DEST="$EXT_ROOT/$UUID"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/claude-usage-indicator"
FILES=(metadata.json extension.js stylesheet.css)
MIN_SHELL=45
MAX_TESTED_SHELL=48

if [[ -t 1 ]]; then
    BOLD=$'\e[1m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m' DIM=$'\e[2m' RESET=$'\e[0m'
else
    BOLD='' GREEN='' YELLOW='' RED='' DIM='' RESET=''
fi
info() { printf '%s==>%s %s\n' "$GREEN$BOLD" "$RESET" "$*"; }
warn() { printf '%s注意：%s%s\n' "$YELLOW$BOLD" "$RESET" "$*" >&2; }
die() { printf '%s错误：%s%s\n' "$RED$BOLD" "$RESET" "$*" >&2; exit 1; }

usage() {
    cat <<EOF
Claude & Codex Usage 安装脚本

用法：
  install.sh               安装或升级
  install.sh --dev         以软链接方式安装当前仓库（开发用）
  install.sh --uninstall   卸载（加 --purge 同时删除缓存）
  install.sh --help        显示本帮助

通过管道运行时这样传参数：
  curl -fsSL https://raw.githubusercontent.com/$REPO/$REF/install.sh | bash -s -- --uninstall
EOF
}

MODE=install DEV=0 PURGE=0
for arg in "$@"; do
    case $arg in
        --uninstall | -u) MODE=uninstall ;;
        --dev) DEV=1 ;;
        --purge) PURGE=1 ;;
        -h | --help) usage; exit 0 ;;
        *) die "未知参数：$arg（用 --help 查看用法）" ;;
    esac
done

# edit_list KEY add|remove — add/remove $UUID in a string-array key of org.gnome.shell
edit_list() {
    local key=$1 op=$2 cur new
    cur=$(gsettings get org.gnome.shell "$key")
    new=$(python3 - "$cur" "$op" "$UUID" <<'PY'
import ast, sys
cur, op, uuid = sys.argv[1:4]
items = ast.literal_eval(cur.strip().removeprefix("@as").strip())
if op == "add" and uuid not in items:
    items.append(uuid)
elif op == "remove":
    items = [i for i in items if i != uuid]
print("[" + ", ".join(repr(i) for i in items) + "]")
PY
)
    if [[ $new != "$cur" ]]; then
        gsettings set org.gnome.shell "$key" "$new"
    fi
}

remove_dest() {
    if [[ -L $DEST ]]; then
        rm -f -- "$DEST"
    elif [[ -d $DEST ]]; then
        rm -rf -- "$DEST"
    fi
}

preflight() {
    [[ $EUID -ne 0 ]] || die "请用普通用户运行（不要加 sudo）：扩展安装在当前用户的目录下。"
    command -v gnome-shell >/dev/null || die "没有找到 GNOME Shell。本工具只支持 GNOME 桌面（Ubuntu 默认桌面）。"
    command -v gsettings >/dev/null || die "缺少 gsettings，请先安装：sudo apt install libglib2.0-bin"
    command -v python3 >/dev/null || die "缺少 python3，请先安装：sudo apt install python3"
    SHELL_MAJOR=$(gnome-shell --version | grep -oE '[0-9]+' | head -n1)
    [[ -n $SHELL_MAJOR ]] || die "无法识别 GNOME Shell 版本。"
    if ((SHELL_MAJOR < MIN_SHELL)); then
        die "GNOME Shell $SHELL_MAJOR 太旧，需要 $MIN_SHELL 或更新（Ubuntu 23.10 / 24.04 及以后）。"
    fi
    if ((SHELL_MAJOR > MAX_TESTED_SHELL)); then
        warn "GNOME Shell $SHELL_MAJOR 尚未测试（已测试到 $MAX_TESTED_SHELL），仍会尝试安装。"
    fi
    info "检测到 GNOME Shell $SHELL_MAJOR（${XDG_SESSION_TYPE:-未知}会话）"
}

# Sets SRC to the extension directory: this checkout if we're in one, else a downloaded copy.
fetch_source() {
    local here=""
    if [[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]]; then
        here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
    fi
    if [[ -n $here && -f $here/$UUID/metadata.json ]]; then
        SRC=$here/$UUID
        return
    fi
    ((DEV == 0)) || die "--dev 只能在克隆下来的仓库里使用。"

    local url="https://codeload.github.com/$REPO/tar.gz/$REF"
    TMP=$(mktemp -d)
    trap 'rm -rf -- "$TMP"' EXIT
    info "下载 $REPO（$REF）…"
    if command -v curl >/dev/null; then
        curl -fsSL "$url" | tar -xz -C "$TMP" || die "下载失败：$url"
    elif command -v wget >/dev/null; then
        wget -qO- "$url" | tar -xz -C "$TMP" || die "下载失败：$url"
    else
        die "需要 curl 或 wget 来下载，请先安装：sudo apt install curl"
    fi
    SRC=$(find "$TMP" -mindepth 2 -maxdepth 2 -type d -name "$UUID" | head -n1)
    [[ -n $SRC && -f $SRC/metadata.json ]] || die "下载的压缩包里没有找到 $UUID。"
}

# GNOME refuses extensions whose metadata doesn't list the running shell version.
allow_shell_version() {
    ((SHELL_MAJOR > MAX_TESTED_SHELL)) || return 0
    if ((DEV)); then
        warn "开发模式不会修改 metadata.json；如果扩展没有加载，请把 \"$SHELL_MAJOR\" 加进 shell-version。"
        return 0
    fi
    python3 - "$DEST/metadata.json" "$SHELL_MAJOR" <<'PY'
import json, sys
path, major = sys.argv[1], sys.argv[2]
with open(path) as f:
    meta = json.load(f)
if major not in meta["shell-version"]:
    meta["shell-version"].append(major)
with open(path, "w") as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
}

enable_extension() {
    edit_list disabled-extensions remove
    edit_list enabled-extensions add
    # only succeeds if the running shell already knows the extension (i.e. an upgrade)
    gnome-extensions enable "$UUID" >/dev/null 2>&1 || true
    if [[ $(gsettings get org.gnome.shell disable-user-extensions) == true ]]; then
        warn "系统关闭了所有用户扩展，扩展不会显示。可以这样打开：gsettings set org.gnome.shell disable-user-extensions false"
    fi
}

# Same search order as the extension: per-user installs first, snap last.
find_codex() {
    local -a candidates nvm
    mapfile -t nvm < <(printf '%s\n' "$HOME"/.nvm/versions/node/*/bin/codex | sort -rV)
    candidates=("${nvm[@]}")
    candidates+=("$HOME/.local/bin/codex" "$HOME/.npm-global/bin/codex" "$HOME/.volta/bin/codex"
        "$HOME/.bun/bin/codex" "$HOME/.cargo/bin/codex")
    local in_path
    in_path=$(command -v codex 2>/dev/null || true)
    [[ $in_path == /snap/* ]] || candidates+=("$in_path")
    candidates+=(/usr/local/bin/codex /usr/bin/codex /snap/bin/codex)
    local c
    for c in "${candidates[@]}"; do
        if [[ -n $c && -x $c ]]; then
            printf '%s\n' "$c"
            return
        fi
    done
}

report_sources() {
    if [[ -f $HOME/.claude/.credentials.json ]]; then
        info "Claude：已找到 Claude Code 登录信息"
    else
        warn "Claude：没找到 ~/.claude/.credentials.json。安装 Claude Code 并运行 claude 登录后会自动显示。"
    fi
    local codex version
    codex=$(find_codex)
    if [[ -n $codex ]]; then
        version=$(PATH="$(dirname -- "$codex"):$PATH" timeout 20 "$codex" --version 2>/dev/null | head -n1 || true)
        info "Codex：将使用 $codex${version:+（$version）}"
        if [[ $codex == /snap/* ]]; then
            warn "Codex：只找到 snap 版，它可能较旧；推荐用 npm 安装官方版：npm install -g @openai/codex"
        fi
    else
        warn "Codex：没找到 codex 命令。安装（npm install -g @openai/codex）并运行 codex login 后会自动显示。"
    fi
}

do_install() {
    preflight
    fetch_source
    mkdir -p -- "$EXT_ROOT"
    remove_dest
    if ((DEV)); then
        ln -s -- "$SRC" "$DEST"
        info "已链接 $DEST → $SRC"
    else
        mkdir -p -- "$DEST"
        local f
        for f in "${FILES[@]}"; do
            install -m 644 -- "$SRC/$f" "$DEST/$f"
        done
        info "已安装到 $DEST"
    fi
    allow_shell_version
    enable_extension
    report_sources

    echo
    if [[ ${XDG_SESSION_TYPE:-} == x11 ]]; then
        info "${BOLD}完成！${RESET}按 Alt+F2，输入 r 回车重启 GNOME Shell（或注销后重新登录），顶栏日期右侧就会出现用量指示器。"
    else
        info "${BOLD}完成！${RESET}请${BOLD}注销并重新登录${RESET}（Wayland 下 GNOME Shell 只在登录时加载新扩展），顶栏日期右侧就会出现用量指示器。"
    fi
    printf '%s    卸载：curl -fsSL https://raw.githubusercontent.com/%s/%s/install.sh | bash -s -- --uninstall%s\n' \
        "$DIM" "$REPO" "$REF" "$RESET"
}

do_uninstall() {
    command -v gsettings >/dev/null || die "缺少 gsettings。"
    command -v python3 >/dev/null || die "缺少 python3。"
    # unloads it from the running shell (this also lists it under disabled-extensions)
    gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
    edit_list enabled-extensions remove
    edit_list disabled-extensions remove
    remove_dest
    if ((PURGE)); then
        rm -rf -- "$CACHE_DIR"
        info "已删除缓存 $CACHE_DIR"
    fi
    info "已卸载 Claude & Codex Usage。顶栏的指示器会立即消失（如果没有，注销重新登录即可）。"
}

if [[ $MODE == uninstall ]]; then
    do_uninstall
else
    do_install
fi
