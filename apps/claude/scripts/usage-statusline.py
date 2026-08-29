#!/usr/bin/env python3
"""Claude Code statusLine hook：把 Claude Code 推來的狀態 JSON 持久化到磁碟。

Claude Code 每次刷新 statusLine 時會把當前 session 的完整 JSON
（含 rate_limits.five_hour / seven_day、context_window、cost 等）
從 stdin 傳給這個 script。我們只負責落地到 usage-status.json，
不輸出任何 statusLine 文字，避免覆蓋使用者自訂版面。

usage 主程式會反向讀這個檔，呈現給 menubar / TUI。

刻意只用標準庫，方便用系統 python3 跑。
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from typing import Any

__version__ = "1.0"

STATUS_FILE = os.path.expanduser("~/.claude/usage-status.json")


def save(data: dict[str, Any], now: datetime) -> None:
    data["_received_at"] = now.isoformat()
    data["_received_at_ts"] = now.timestamp()
    target_dir = os.path.dirname(STATUS_FILE)
    os.makedirs(target_dir, exist_ok=True)
    tmp_path: str | None = None
    try:
        fd, tmp_path = tempfile.mkstemp(dir=target_dir, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp_path, STATUS_FILE)
        tmp_path = None
    finally:
        if tmp_path and os.path.exists(tmp_path):
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)


def _debug(message: str, exc: Exception | None = None) -> None:
    if os.environ.get("USAGE_DEBUG") != "1":
        return
    if exc is None:
        print(f"usage_statusline: {message}", file=sys.stderr)
        return
    print(f"usage_statusline: {message}: {exc}", file=sys.stderr)


def main() -> dict[str, Any] | None:
    try:
        raw = sys.stdin.read()
    except Exception as exc:
        _debug("stdin read failed", exc)
        return None
    if not raw.strip():
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        _debug("invalid stdin JSON", exc)
        return None
    if not isinstance(data, dict):
        _debug("stdin JSON root is not an object")
        return None
    save(data, datetime.now(timezone.utc))
    return data


def render(data: dict[str, Any]) -> str:
    RESET = "\033[0m"
    DIM = "\033[2m"
    CYAN = "\033[36m"
    YELLOW = "\033[33m"
    MAGENTA = "\033[35m"

    cwd = data.get("workspace", {}).get("current_dir") or data.get("cwd") or ""
    home = os.path.expanduser("~")
    if cwd.startswith(home):
        cwd = "~" + cwd[len(home):]

    branch = ""
    git_head = os.path.join(cwd if os.path.isabs(cwd) else os.path.expanduser(cwd), ".git", "HEAD")
    try:
        resolved_cwd = data.get("workspace", {}).get("current_dir") or data.get("cwd") or "."
        head_path = os.path.join(resolved_cwd, ".git", "HEAD")
        if os.path.exists(head_path):
            with open(head_path, "r", encoding="utf-8") as f:
                content = f.read().strip()
            if content.startswith("ref:"):
                branch = content.split("/")[-1]
            else:
                branch = content[:7]
    except OSError:
        branch = ""

    model = data.get("model", {}).get("display_name", "")

    ctx = data.get("context_window", {}) or {}
    used = ctx.get("used_percentage")
    ctx_str = f"{used:.0f}% ctx" if isinstance(used, (int, float)) else ""

    parts = [f"{CYAN}{cwd}{RESET}"]
    if branch:
        parts.append(f"{YELLOW}({branch}){RESET}")
    if model:
        parts.append(f"{MAGENTA}{model}{RESET}")
    if ctx_str:
        parts.append(f"{DIM}{ctx_str}{RESET}")

    return " ".join(parts)


if __name__ == "__main__":
    _data = main()
    if _data is not None:
        try:
            print(render(_data))
        except Exception:
            pass
