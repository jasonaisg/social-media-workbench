#!/usr/bin/env python3
"""Reject local runtime data and likely credentials from the Git candidate set."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
MAX_FILE_SIZE = 20 * 1024 * 1024

DENIED_BASENAMES = {
    ".env",
    "config.yaml",
    "config.yml",
    "master.json",
    "cookies.json",
    "session.key",
    "session.crt",
    "AGENTS.md",
    "DEVELOPMENT.md",
    "INTEGRATION.md",
    "STORAGE_DESIGN.md",
    "handoff.md",
    "HANDOFF.md",
}

DENIED_SUFFIXES = {
    ".db",
    ".sqlite",
    ".sqlite3",
    ".log",
    ".p8",
    ".p12",
    ".pfx",
    ".pem",
    ".key",
    ".keystore",
    ".mobileprovision",
}

DENIED_PARTS = {
    "__pycache__",
    "cache",
    "certs",
    "dist",
    "downloads",
    "node_modules",
    "runtime",
    "tmp",
    "vendor",
    "workdir",
}

ALLOWED_CONFIG_PATHS = {
    ".github/ISSUE_TEMPLATE/config.yml",
    "internal/config/config.template.yaml",
}


def git_candidates() -> list[str]:
    result = subprocess.run(
        [
            "git",
            "-C",
            str(ROOT),
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"cannot inspect Git candidate set: {message}")
    return sorted(item for item in result.stdout.decode().split("\0") if item)


def path_problems(relative: str) -> list[str]:
    if relative in ALLOWED_CONFIG_PATHS:
        return []
    if relative.startswith("pkg/cache/"):
        return []
    path = PurePosixPath(relative)
    problems: list[str] = []
    if path.name in DENIED_BASENAMES or path.name.startswith(".env."):
        problems.append("local configuration or operational note")
    if path.suffix.lower() in DENIED_SUFFIXES:
        problems.append(f"sensitive/runtime extension {path.suffix}")
    if set(path.parts) & DENIED_PARTS:
        problems.append("runtime, dependency, or build-output directory")
    return problems


def content_problems(relative: str, data: bytes) -> list[str]:
    problems: list[str] = []
    text = data.decode("utf-8", errors="ignore")

    private_key_marker = "-----BEGIN " + "PRIVATE KEY-----"
    rsa_key_marker = "-----BEGIN RSA " + "PRIVATE KEY-----"
    if private_key_marker in text or rsa_key_marker in text:
        problems.append("private key material")

    personal_home = "/Users/" + "jason" + "aisi"
    production_root = "JAi" + "Work/"
    if personal_home in text or production_root in text:
        problems.append("machine-specific production path")

    token_patterns = [
        re.compile("gh" + r"[opsu]_[A-Za-z0-9]{30,}"),
        re.compile(r"(?<![A-Za-z0-9])" + "sk-" + r"[A-Za-z0-9]{32,}"),
        re.compile(r"(?<![A-Za-z0-9])" + "sk-" + "proj-" + r"[A-Za-z0-9_-]{20,}"),
        re.compile("AK" + r"IA[0-9A-Z]{16}"),
    ]
    if any(pattern.search(text) for pattern in token_patterns):
        problems.append("high-confidence credential pattern")
    return problems


def main() -> int:
    try:
        candidates = git_candidates()
    except RuntimeError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2

    failures: list[tuple[str, str]] = []
    for relative in candidates:
        path = ROOT / relative
        if not path.is_file():
            continue
        for problem in path_problems(relative):
            failures.append((relative, problem))
        size = path.stat().st_size
        if size > MAX_FILE_SIZE:
            failures.append((relative, f"file is larger than {MAX_FILE_SIZE // 1024 // 1024} MiB"))
            continue
        data = path.read_bytes()
        for problem in content_problems(relative, data):
            failures.append((relative, problem))

    if failures:
        print("Public-tree audit failed:", file=sys.stderr)
        for relative, problem in failures:
            print(f"  - {relative}: {problem}", file=sys.stderr)
        return 1

    print(f"Public-tree audit passed: {len(candidates)} Git candidate files checked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
