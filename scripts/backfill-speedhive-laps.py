#!/usr/bin/env python3
"""Try to backfill past/current F300 rounds from public Speedhive search."""

from __future__ import annotations

import argparse
from datetime import date
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

import requests


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--rounds",
        default="",
        help="Optional comma-separated F300 rounds. Blank = all non-cancelled rounds up to today.",
    )
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def fetch_feed() -> dict[str, Any]:
    url = os.environ.get("F300_DATA_URL", "").strip()
    if not url:
        raise RuntimeError("F300_DATA_URL is not configured.")

    response = requests.get(url, timeout=30)
    response.raise_for_status()
    data = response.json()
    return data if isinstance(data, dict) else {}


def requested_rounds(value: str) -> set[int]:
    result: set[int] = set()
    for chunk in str(value or "").split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        result.add(int(chunk))
    return result


def main() -> int:
    args = parse_args()
    feed = fetch_feed()
    selected = requested_rounds(args.rounds)
    today = date.today().isoformat()

    rounds: list[tuple[int, str, str]] = []

    for item in feed.get("calendar", []):
        try:
            round_number = int(item.get("round"))
        except (TypeError, ValueError):
            continue

        if selected and round_number not in selected:
            continue

        status = str(item.get("status", "")).strip().lower()
        date_key = str(item.get("dateKey", "")).strip()
        track = str(item.get("track", "")).strip()

        if status == "cancelled" or not track or not date_key:
            continue

        if not selected and date_key > today:
            continue

        rounds.append((round_number, track, date_key))

    rounds.sort()

    if not rounds:
        print("No eligible F300 rounds were found for backfill.")
        return 0

    importer = Path(__file__).with_name("import-speedhive-results.py")
    successes: list[int] = []
    misses: list[int] = []

    print("F300 Speedhive historical lap backfill")
    print("Rounds to try:")
    for round_number, track, date_key in rounds:
        print(f"  Round {round_number}: {track} · {date_key}")

    for round_number, track, date_key in rounds:
        print("\n" + "=" * 72)
        print(f"TRYING ROUND {round_number}: {track} · {date_key}")
        print("=" * 72)

        command = [
            sys.executable,
            "-u",
            str(importer),
            "--event",
            "auto",
            "--round",
            str(round_number),
        ]
        if args.dry_run:
            command.append("--dry-run")

        completed = subprocess.run(command, check=False)

        if completed.returncode == 0:
            successes.append(round_number)
        else:
            misses.append(round_number)
            print(
                f"Round {round_number} could not be imported from Speedhive. "
                "This is allowed during backfill; the app will leave that round unavailable."
            )

    print("\n" + "=" * 72)
    print("BACKFILL SUMMARY")
    print("=" * 72)
    print("Matched/imported:", ", ".join(f"R{r}" for r in successes) or "none")
    print("No usable Speedhive match:", ", ".join(f"R{r}" for r in misses) or "none")
    print("Mode:", "DRY RUN" if args.dry_run else "LIVE WRITE")

    # Some circuits are expected to use another provider. Do not fail the
    # whole historical run just because Speedhive has no match for them.
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
