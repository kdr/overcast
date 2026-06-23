#!/usr/bin/env python3
"""overcast exec/http provider: listen (local whisper sketch).

Bind with:
    overcast setup provider listen "exec:python3 examples/providers/python/listen.py"
    overcast provider init listen

Implements the overcast exec wire contract:
    <provider> init                 -> setup/cred check (exit 13 = needs creds)
    <provider> describe             -> capabilities JSON on stdout
    <provider> run --input <ref>    -> an audio.analysis record JSON on stdout
"""
import json
import shutil
import sys


def describe():
    print(json.dumps({
        "verb": "listen",
        "kind": "audio.analysis",
        "payload": ["transcript", "segments", "language"],
    }))


def init():
    if shutil.which("whisper") is None:
        sys.stderr.write("install whisper (pip install openai-whisper) to use this provider\n")
        sys.exit(13)


def run(input_ref: str):
    # Replace with a real whisper call; this stub emits the record SHAPE so the
    # binding round-trips (overcast maps it to the loose record verbatim).
    record = {
        "verb": "listen",
        "format": "json",
        "payload": {"transcript": "", "segments": [], "language": None},
        "media": {"ref": input_ref},
        "meta": {"provider": "whisper-local"},
        "state": "needs_credentials",
        "error": "whisper not wired in this sample",
    }
    print(json.dumps(record))


def main(argv):
    op = argv[1] if len(argv) > 1 else "run"
    if op == "describe":
        return describe()
    if op == "init":
        return init()
    # run --input <ref>
    ref = ""
    for i, a in enumerate(argv):
        if a == "--input" and i + 1 < len(argv):
            ref = argv[i + 1]
    if not ref and len(argv) > 1 and not argv[1].startswith("-"):
        ref = argv[-1]
    run(ref)


if __name__ == "__main__":
    main(sys.argv)
