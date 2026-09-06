#!/usr/bin/env python3
"""
F300 Speedhive result importer.

Pilot mode:
- Give it a Speedhive event URL/ID OR a public Speedhive search URL and F300 round.
- For a search URL, it reads the F300 Race Calendar to get the track/date,
  discovers the matching public Speedhive event automatically, then imports it.
- It reads public Speedhive Event Results data.
- It finds F300 Heat 1 / Heat 2 / Heat 3 / Final.
- It extracts kart number, driver name, finishing result and best lap.
- In dry-run mode it prints exactly what it found.
- In live mode it POSTs a signed batch to the F300 Apps Script backend.

This script intentionally refuses to guess ambiguous sessions or drivers.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Iterable
from urllib.parse import parse_qs, quote_plus, urlparse

import requests
from speedhive.wrapper import SpeedhiveClient

BOT_VERSION = "v1.2-speedhive-laps"


SESSION_PATTERNS = {
    "h1": [
        r"\bheat\s*1\b",
        r"\bh1\b",
        r"\brace\s*1\b",
    ],
    "h2": [
        r"\bheat\s*2\b",
        r"\bh2\b",
        r"\brace\s*2\b",
    ],
    "h3": [
        r"\bheat\s*3\b",
        r"\bh3\b",
        r"\brace\s*3\b",
    ],
    "final": [
        r"\bfinal\b",
    ],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--event",
        default="",
        help="Speedhive event URL/ID or public Speedhive search URL",
    )
    parser.add_argument(
        "--round",
        type=int,
        required=True,
        help="F300 championship round number",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print discovered data but do not write to Google Sheets",
    )
    return parser.parse_args()


def event_id_from_value(value: str) -> int | None:
    value = str(value or "").strip()

    if value.isdigit():
        return int(value)

    match = re.search(r"/events/(\d+)", value, flags=re.I)
    if match:
        return int(match.group(1))

    return None


def walk_scalars(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for child in value.values():
            yield from walk_scalars(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_scalars(child)
    elif value is not None and not isinstance(value, (bytes, bytearray)):
        yield str(value)


def text_blob(value: Any) -> str:
    return " ".join(walk_scalars(value)).lower()


def lookup_any(
    value: Any,
    keys: Iterable[str],
    *,
    max_depth: int = 4,
) -> Any:
    wanted = {key.lower() for key in keys}

    def visit(node: Any, depth: int) -> Any:
        if depth > max_depth:
            return None

        if isinstance(node, dict):
            for key, child in node.items():
                if str(key).lower() in wanted and child not in (None, ""):
                    return child

            for child in node.values():
                found = visit(child, depth + 1)
                if found not in (None, ""):
                    return found

        elif isinstance(node, list):
            for child in node:
                found = visit(child, depth + 1)
                if found not in (None, ""):
                    return found

        return None

    return visit(value, 0)


def normalize_name(value: Any) -> str:
    return re.sub(
        r"\s+",
        " ",
        re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()),
    ).strip()


def normalize_number(value: Any) -> str:
    text = str(value or "").strip()
    if re.fullmatch(r"\d+(?:\.0+)?", text):
        text = str(int(float(text)))
    return text.lstrip("0").lower()


def to_seconds(value: Any) -> float | None:
    if value in (None, "", "-"):
        return None

    if isinstance(value, (int, float)):
        number = float(value)
        return round(number, 3) if 10 <= number <= 300 else None

    text = str(value).strip().replace(",", ".")

    # Simple seconds, e.g. 37.783
    try:
        number = float(text)
        if 10 <= number <= 300:
            return round(number, 3)
    except ValueError:
        pass

    # mm:ss.mmm or hh:mm:ss.mmm
    parts = text.split(":")
    if 2 <= len(parts) <= 3:
        try:
            seconds = float(parts[-1])
            minutes = float(parts[-2])
            hours = float(parts[-3]) if len(parts) == 3 else 0.0
            total = hours * 3600 + minutes * 60 + seconds
            if 10 <= total <= 300:
                return round(total, 3)
        except ValueError:
            pass

    # Some APIs expose milliseconds.
    digits = re.fullmatch(r"\d{5,6}", text)
    if digits:
        number = float(text) / 1000.0
        if 10 <= number <= 300:
            return round(number, 3)

    return None


def result_number(row: dict[str, Any]) -> str:
    value = lookup_any(
        row,
        (
            "startNumber",
            "start_number",
            "kartNumber",
            "kart_number",
            "raceNumber",
            "race_number",
            "number",
        ),
    )
    return str(value or "").strip()


def result_name(row: dict[str, Any]) -> str:
    direct = lookup_any(
        row,
        (
            "driverName",
            "driver_name",
            "competitorName",
            "competitor_name",
            "participantName",
            "participant_name",
            "fullName",
            "full_name",
            "name",
        ),
    )

    if direct:
        return str(direct).strip()

    first = lookup_any(row, ("firstName", "first_name"))
    last = lookup_any(row, ("lastName", "last_name"))
    return " ".join(
        part for part in (str(first or "").strip(), str(last or "").strip())
        if part
    )


def result_position(row: dict[str, Any]) -> int | None:
    # Mixed Speedhive classes are common at Lydd. Prefer the driver's
    # position within their result class over the combined overall position.
    value = lookup_any(
        row,
        (
            "positionInClass",
            "position_in_class",
            "classPosition",
            "class_position",
            "position",
            "rank",
            "overallPosition",
            "overall_position",
        ),
    )

    try:
        number = int(float(str(value)))
    except (TypeError, ValueError):
        return None

    return number if 1 <= number <= 99 else None


def result_overall_position(row: dict[str, Any]) -> int | None:
    """
    Position used by Speedhive's /laptimes?pos=X page.

    This must be the combined session result position, not the F300
    positionInClass used for championship scoring.
    """
    value = lookup_any(
        row,
        (
            "position",
            "overallPosition",
            "overall_position",
            "rank",
        ),
        max_depth=3,
    )

    try:
        number = int(float(str(value)))
    except (TypeError, ValueError):
        return None

    return number if 1 <= number <= 999 else None



def result_status(row: dict[str, Any]) -> str:
    value = lookup_any(
        row,
        (
            "status",
            "resultStatus",
            "result_status",
            "classificationStatus",
            "classification_status",
            "state",
        ),
    )
    text = str(value or "").upper()

    if "DNS" in text or "DID NOT START" in text:
        return "DNS"
    if "DNF" in text or "DID NOT FINISH" in text:
        return "DNF"

    # Sometimes the status is embedded elsewhere in the row.
    whole = text_blob(row).upper()
    if "DNS" in whole or "DID NOT START" in whole:
        return "DNS"
    if "DNF" in whole or "DID NOT FINISH" in whole:
        return "DNF"

    return ""


def result_best_lap(row: dict[str, Any]) -> float | None:
    value = lookup_any(
        row,
        (
            "bestLapTime",
            "best_lap_time",
            "fastestLapTime",
            "fastest_lap_time",
            "bestLap",
            "best_lap",
            "fastestLap",
            "fastest_lap",
            "bestTime",
            "best_time",
        ),
    )
    return to_seconds(value)



def result_class(row: dict[str, Any]) -> str:
    value = lookup_any(
        row,
        (
            "resultClass",
            "result_class",
            "className",
            "class_name",
            "category",
        ),
        max_depth=3,
    )
    return str(value or "").strip()


def is_practice_session(name: str) -> bool:
    lowered = name.lower()
    return any(
        phrase in lowered
        for phrase in (
            "practice",
            "warm-up",
            "warm up",
            "warmup",
            "test session",
            "testing",
        )
    )


def is_actual_final_session(name: str) -> bool:
    lowered = name.lower()

    # Pre-Final / Semi-Final are scoring races before the real Final.
    if "pre-final" in lowered or "prefinal" in lowered:
        return False
    if "semi-final" in lowered or "semifinal" in lowered:
        return False

    # Speedhive may append text such as "- Provisional Result".
    # Any remaining session containing the standalone word Final is the actual Final.
    return bool(re.search(r"\bfinal\b", lowered, flags=re.I))


def session_sort_value(session: dict[str, Any]) -> tuple[int, str]:
    """
    Speedhive session IDs increase in event order for the meetings tested.
    Prefer an explicit session ID because it is stable even when labels vary.
    """
    sid = (
        session.get("id")
        or lookup_any(session, ("sessionId", "session_id", "id"), max_depth=1)
        or 0
    )

    try:
        number = int(sid)
    except (TypeError, ValueError):
        number = 0

    return (number, session_name(session).lower())


def likely_f300_result(
    row: dict[str, Any],
    by_number: dict[str, str],
    by_name: dict[str, str],
) -> bool:
    # When our F300 roster is available, exact roster matching is the safest
    # way to remove Rotax/177 competitors from combined Speedhive sessions.
    if by_number or by_name:
        return row_matches_roster(row, by_number, by_name)

    # Fallback if the public F300 feed is unavailable.
    return bool(re.search(r"\bf\s*300\b", result_class(row), flags=re.I))


def competitor_id(row: dict[str, Any]) -> str:
    value = lookup_any(
        row,
        (
            "competitorId",
            "competitor_id",
            "participantId",
            "participant_id",
        ),
    )
    return str(value or "").strip()



def group_label(group: dict[str, Any]) -> str:
    value = lookup_any(
        group,
        (
            "name",
            "groupName",
            "group_name",
            "displayName",
            "display_name",
            "title",
            "description",
            "classification",
            "className",
            "class_name",
        ),
        max_depth=1,
    )
    return str(value or "").strip()


def grouped_sessions_with_context(event: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Preserve Speedhive parent-group labels.

    Speedhive often has structures like:
        F300
          -> Heat 1
          -> Heat 2
          -> Heat 3
          -> Final

    The wrapper's normal get_sessions() deliberately flattens those sessions,
    which can discard the fact that a generic "Heat 1" belongs to F300.
    """
    found: list[dict[str, Any]] = []
    seen: set[str] = set()

    def visit(node: Any, parents: list[str]) -> None:
        if not isinstance(node, dict):
            return

        label = group_label(node)
        next_parents = parents + ([label] if label else [])

        for session in node.get("sessions") or []:
            if not isinstance(session, dict):
                continue

            sid = (
                session.get("id")
                or lookup_any(session, ("sessionId", "session_id", "id"), max_depth=1)
            )
            sid_key = str(sid or "")

            if sid_key and sid_key in seen:
                continue
            if sid_key:
                seen.add(sid_key)

            item = dict(session)
            item["_f300_parent_context"] = " · ".join(next_parents)
            found.append(item)

        for key in ("groups", "subGroups"):
            for child in node.get(key) or []:
                visit(child, next_parents)

    visit(event, [])
    return found


def session_name(session: dict[str, Any]) -> str:
    for key in (
        "sessionName",
        "session_name",
        "displayName",
        "display_name",
        "name",
        "description",
        "title",
    ):
        value = session.get(key)
        if value not in (None, ""):
            return str(value).strip()

    return ""


def infer_session_key(name: str) -> str | None:
    lowered = name.lower()

    if "pre-final" in lowered or "prefinal" in lowered:
        return None

    aliases = {
        "h1": (r"\bheat\s*(?:1|one)\b", r"\bh1\b", r"\brace\s*(?:1|one)\b"),
        "h2": (r"\bheat\s*(?:2|two)\b", r"\bh2\b", r"\brace\s*(?:2|two)\b"),
        "h3": (r"\bheat\s*(?:3|three)\b", r"\bh3\b", r"\brace\s*(?:3|three)\b"),
        "final": (r"\bfinal\b",),
    }

    for key, patterns in aliases.items():
        for pattern in patterns:
            if re.search(pattern, lowered, flags=re.I):
                return key

    return None


def fetch_f300_feed() -> dict[str, Any]:
    data_url = os.environ.get("F300_DATA_URL", "").strip()

    if not data_url:
        return {}

    response = requests.get(data_url, timeout=30)
    response.raise_for_status()
    data = response.json()

    return data if isinstance(data, dict) else {}


def f300_roster_from_feed(
    data: dict[str, Any],
) -> tuple[dict[str, str], dict[str, str]]:
    by_number: dict[str, str] = {}
    by_name: dict[str, str] = {}

    for row in data.get("standings", []):
        name = str(row.get("driver", "")).strip()
        number = normalize_number(row.get("number", ""))

        if not name:
            continue

        by_name[normalize_name(name)] = name
        if number:
            by_number[number] = name

    return by_number, by_name


def f300_race_context(
    data: dict[str, Any],
    round_number: int,
) -> dict[str, str]:
    for item in data.get("calendar", []):
        try:
            item_round = int(item.get("round"))
        except (TypeError, ValueError):
            continue

        if item_round != round_number:
            continue

        track = str(item.get("track", "")).strip()
        date_key = str(item.get("dateKey", "")).strip()

        if not track:
            raise RuntimeError(
                f"Round {round_number} has no track in the F300 Race Calendar."
            )

        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_key):
            raise RuntimeError(
                f"Round {round_number} does not have a usable dateKey in the "
                "published F300 Race Calendar."
            )

        date_text = str(item.get("date", "")).strip()
        date_keys = [date_key]

        # F300 calendar weekends such as "9th-10th May" may appear on
        # Speedhive under either the Saturday or Sunday date. Keep the exact
        # calendar start date, and include the rest of a short displayed date
        # range when one is present.
        range_match = re.search(
            r"(\d{1,2})(?:st|nd|rd|th)?\s*[-–]\s*(\d{1,2})(?:st|nd|rd|th)?",
            date_text,
            flags=re.I,
        )

        if range_match:
            start_date = date.fromisoformat(date_key)
            end_day = int(range_match.group(2))

            try:
                if end_day >= start_date.day:
                    end_date = start_date.replace(day=end_day)
                else:
                    # Rare month-crossing weekend, e.g. 31st-1st.
                    probe = start_date + timedelta(days=1)
                    while probe.day != end_day and (probe - start_date).days <= 7:
                        probe += timedelta(days=1)
                    end_date = probe

                probe = start_date + timedelta(days=1)
                while probe <= end_date and (probe - start_date).days <= 7:
                    date_keys.append(probe.isoformat())
                    probe += timedelta(days=1)
            except ValueError:
                pass

        return {
            "track": track,
            "dateKey": date_key,
            "dateKeys": date_keys,
            "dateText": date_text,
        }

    raise RuntimeError(
        f"Round {round_number} could not be found in the published F300 Race Calendar."
    )




def row_matches_roster(
    row: dict[str, Any],
    by_number: dict[str, str],
    by_name: dict[str, str],
) -> bool:
    number = normalize_number(result_number(row))
    name = normalize_name(result_name(row))

    # Kart/driver number is the authoritative F300 identity.
    # Speedhive display names can vary between meetings, so a known number
    # must still match even when the shown name is different.
    if number and number in by_number:
        return True

    # Only fall back to name when Speedhive has no usable known number.
    return bool(name and name in by_name)


def is_f300_session(
    session: dict[str, Any],
    rows: list[dict[str, Any]],
    by_number: dict[str, str],
    by_name: dict[str, str],
) -> bool:
    parent_context = str(session.get("_f300_parent_context") or "")
    combined = f"{parent_context} {text_blob(session)} {text_blob(rows[:8])}"

    if re.search(r"\bf\s*300\b", combined, flags=re.I):
        return True

    # Fallback: if several competitors exactly match our known F300 roster,
    # it is almost certainly the F300 class even if Speedhive omitted the label.
    exact_matches = sum(
        1 for row in rows
        if row_matches_roster(row, by_number, by_name)
    )
    return exact_matches >= 2


def scrape_personal_lap_rows_from_page(page: Any) -> list[dict[str, Any]]:
    """
    Read the rendered Personal Results lap table from a Speedhive driver page.

    Speedhive renders the cells as separate DIVs rather than conventional
    HTML table rows. The browser's body.innerText is stable and preserves the
    visible table cell order, so parse the table from that rendered text.

    Qualifying-style table:
      Lap | Lap Time | Diff to Last Lap | Diff to Best Lap | Speed

    Race-style table:
      Lap | Pos | Lap Time | Diff to Last Lap | Diff to Best Lap |
      Gap in Front | Diff to P1 | Speed
    """
    body_text = page.locator("body").inner_text(timeout=15000)

    lines = [
        line.strip().replace("−", "-").replace("–", "-")
        for line in body_text.splitlines()
        if line.strip()
    ]

    # Locate the actual Personal Results header. Chart axis labels appear
    # earlier on the page, so anchor on "Lap Time" with a nearby "Lap".
    candidates: list[tuple[int, int]] = []

    for index, value in enumerate(lines):
        if value != "Lap Time":
            continue

        lap_index = None
        for probe in range(index - 1, max(-1, index - 5), -1):
            if lines[probe] == "Lap":
                lap_index = probe
                break

        if lap_index is not None:
            candidates.append((lap_index, index))

    if not candidates:
        return []

    header_start, lap_time_index = candidates[-1]

    speed_index = None
    for probe in range(lap_time_index + 1, min(len(lines), lap_time_index + 12)):
        if lines[probe] == "Speed":
            speed_index = probe
            break

    if speed_index is None:
        return []

    headers = lines[header_start:speed_index + 1]
    has_position = "Pos" in headers

    # The visible table ends before the standard Speedhive footer.
    end_index = len(lines)
    for probe in range(speed_index + 1, len(lines)):
        if lines[probe] == "About Speedhive":
            end_index = probe
            break

    cells = lines[speed_index + 1:end_index]

    # Speedhive supplies a value/dash for each displayed column. Chunking by
    # the visible header count is therefore more reliable than looking for
    # CSS row elements.
    column_count = len(headers)
    laps: dict[int, dict[str, Any]] = {}

    if column_count >= 4:
        cursor = 0

        while cursor + column_count <= len(cells):
            chunk = cells[cursor:cursor + column_count]
            cursor += column_count

            try:
                lap_number = int(float(chunk[0]))
            except (TypeError, ValueError):
                continue

            if lap_number < 1:
                continue

            time_index = 2 if has_position else 1

            try:
                lap_time = float(chunk[time_index])
            except (TypeError, ValueError, IndexError):
                continue

            if not 10 <= lap_time <= 300:
                continue

            speed = None
            speed_cell = chunk[-1]

            speed_match = re.search(
                r"(\d{1,3}(?:\.\d{1,3})?)\s*km/h",
                speed_cell,
                flags=re.I,
            )

            if speed_match:
                try:
                    speed = round(float(speed_match.group(1)), 3)
                except ValueError:
                    speed = None

            laps[lap_number] = {
                "lap": lap_number,
                "time": round(lap_time, 3),
                "speed": speed,
                "inPit": any(
                    re.search(r"\bPIT\b", cell, flags=re.I)
                    for cell in chunk
                ),
            }

    # Fallback for a future Speedhive layout that does not preserve a fixed
    # number of cells. Each visible row normally ends with its km/h speed.
    if not laps:
        chunk: list[str] = []
        speed_pattern = re.compile(
            r"^(\d{1,3}(?:\.\d{1,3})?)\s*km/h$",
            flags=re.I,
        )

        for cell in cells:
            chunk.append(cell)
            speed_match = speed_pattern.match(cell)

            if not speed_match:
                continue

            try:
                lap_number = int(float(chunk[0]))
                time_index = 2 if has_position else 1
                lap_time = float(chunk[time_index])
            except (TypeError, ValueError, IndexError):
                chunk = []
                continue

            if lap_number >= 1 and 10 <= lap_time <= 300:
                laps[lap_number] = {
                    "lap": lap_number,
                    "time": round(lap_time, 3),
                    "speed": round(float(speed_match.group(1)), 3),
                    "inPit": any(
                        re.search(r"\bPIT\b", value, flags=re.I)
                        for value in chunk
                    ),
                }

            chunk = []

    return [laps[key] for key in sorted(laps)]


def scrape_personal_laps_for_results(
    session_id: int,
    rows: list[dict[str, Any]],
) -> dict[int, list[dict[str, Any]]]:
    """
    Visit Speedhive's per-driver Personal Results page for each result row.

    URL format confirmed from the public site:
      /sessions/<session-id>/laptimes?pos=<overall-result-position>
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "Personal lap-page scraping requires Playwright. "
            "Use the current GitHub workflow that installs Chromium."
        ) from exc

    wanted_positions = []

    for row in rows:
        overall_pos = result_overall_position(row)
        if overall_pos is not None:
            wanted_positions.append(
                (
                    overall_pos,
                    result_number(row),
                    result_name(row),
                )
            )

    if not wanted_positions:
        return {}

    found: dict[int, list[dict[str, Any]]] = {}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )

        page = browser.new_page(
            viewport={"width": 1440, "height": 1000},
            locale="en-GB",
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/152.0.0.0 Safari/537.36"
            ),
        )

        try:
            for overall_pos, number, name in wanted_positions:
                url = (
                    f"https://speedhive.mylaps.com/sessions/"
                    f"{session_id}/laptimes?pos={overall_pos}"
                )

                print(
                    f"        Personal laps: session={session_id} "
                    f"pos={overall_pos} #{number or '?'} {name or 'Unknown'}",
                    flush=True,
                )

                try:
                    page.goto(
                        url,
                        wait_until="domcontentloaded",
                        timeout=60000,
                    )
                    page.wait_for_timeout(1800)

                    # Personal Results / Lap Time is rendered client-side.
                    try:
                        page.get_by_text(
                            "Lap Time",
                            exact=True,
                        ).first.wait_for(timeout=12000)
                    except Exception:
                        page.wait_for_timeout(1800)

                    body_text = " ".join(
                        page.locator("body").inner_text(timeout=10000).split()
                    )

                    normalized_expected_name = normalize_name(name)
                    normalized_body = normalize_name(body_text)

                    if (
                        normalized_expected_name
                        and normalized_expected_name not in normalized_body
                    ):
                        print(
                            f"          Warning: expected driver name "
                            f'"{name}" was not visible on the lap page.',
                            file=sys.stderr,
                        )

                    laps = scrape_personal_lap_rows_from_page(page)
                    found[overall_pos] = laps

                    print(
                        f"          Found {len(laps)} personal lap rows.",
                        flush=True,
                    )

                    if not laps:
                        # Useful diagnostic if Speedhive changes its DOM again.
                        preview_lines = [
                            line.strip()
                            for line in page.locator("body")
                            .inner_text(timeout=10000)
                            .splitlines()
                            if line.strip()
                        ][:120]

                        print(
                            "          Personal lap page diagnostic:",
                            flush=True,
                        )
                        for line in preview_lines:
                            print(f"            {line}", flush=True)

                except Exception as exc:
                    print(
                        f"          Warning: could not read {url}: {exc}",
                        file=sys.stderr,
                    )
                    found[overall_pos] = []
        finally:
            browser.close()

    return found


def build_session_payload(
    client: SpeedhiveClient,
    session: dict[str, Any],
    rows: list[dict[str, Any]],
    key: str,
    by_number: dict[str, str],
    by_name: dict[str, str],
    mapping_reason: str,
) -> dict[str, Any]:
    sid_raw = session.get("id") or lookup_any(session, ("id", "sessionId", "session_id"))
    session_id = int(sid_raw)

    eligible_rows = [
        row
        for row in rows
        if isinstance(row, dict)
        and likely_f300_result(row, by_number, by_name)
    ]

    personal_laps = scrape_personal_laps_for_results(
        session_id,
        eligible_rows,
    )

    results: list[dict[str, Any]] = []

    for row in eligible_rows:

        number = result_number(row)
        name = result_name(row)
        position = result_position(row)
        status = result_status(row)
        best_lap = result_best_lap(row)
        cid = competitor_id(row)
        overall_position = result_overall_position(row)
        driver_laps = (
            personal_laps.get(overall_position, [])
            if overall_position is not None
            else []
        )

        if best_lap is None and driver_laps:
            best_lap = min(
                (lap["time"] for lap in driver_laps if lap.get("time") is not None),
                default=None,
            )

        if not number and not name:
            continue

        results.append(
            {
                "number": number,
                "name": name,
                "position": position,
                "status": status,
                "bestLap": best_lap,
                "resultClass": result_class(row),
                "competitorId": cid,
                "lapPagePos": overall_position,
                "laps": driver_laps,
            }
        )

    context = str(session.get("_f300_parent_context") or "").strip()
    display_name = session_name(session) or f"Session {session_id}"
    if context and context.lower() not in display_name.lower():
        display_name = f"{context} · {display_name}"

    return {
        "key": key,
        "name": display_name,
        "sessionId": session_id,
        "mappingReason": mapping_reason,
        "results": results,
    }


def is_speedhive_search_url(value: str) -> bool:
    try:
        parsed = urlparse(str(value or "").strip())
    except Exception:
        return False

    return (
        parsed.scheme in ("http", "https")
        and parsed.netloc.lower().endswith("speedhive.mylaps.com")
        and parsed.path.rstrip("/").lower() == "/search"
    )


def search_term_from_url(search_url: str) -> str:
    parsed = urlparse(search_url)
    values = parse_qs(parsed.query).get("term") or []
    return str(values[0] if values else "").strip()


def speedhive_date_variants(date_key: str) -> list[str]:
    target = date.fromisoformat(date_key)

    month_short = target.strftime("%b")
    month_long = target.strftime("%B")

    # Speedhive currently displays dates like "Sep 6, 2026", but keep
    # several public-display variants so this is not tied to one layout.
    return [
        f"{month_short} {target.day}, {target.year}",
        f"{month_long} {target.day}, {target.year}",
        f"{target.day} {month_short} {target.year}",
        f"{target.day} {month_long} {target.year}",
        f"{target.day:02d} {month_short} {target.year}",
        f"{target.day:02d} {month_long} {target.year}",
    ]


def discover_event_id_from_search(
    search_url: str,
    race_context: dict[str, str],
) -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "Search-page discovery requires Playwright. "
            "Use the updated GitHub workflow that installs Chromium."
        ) from exc

    track = race_context["track"]
    date_key = race_context["dateKey"]
    date_keys = race_context.get("dateKeys") or [date_key]
    search_term = search_term_from_url(search_url)
    date_variants = [
        variant
        for key in date_keys
        for variant in speedhive_date_variants(key)
    ]

    print("\nSpeedhive public-search discovery:", flush=True)
    print(f"  Search URL: {search_url}")
    print(f"  F300 calendar track: {track}")
    print(f"  F300 calendar date(s): {', '.join(date_keys)}")
    if search_term:
        print(f"  Search term in URL: {search_term}")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )

        page = browser.new_page(
            viewport={"width": 1440, "height": 1000},
            locale="en-GB",
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/152.0.0.0 Safari/537.36"
            ),
        )

        try:
            page.goto(
                search_url,
                wait_until="domcontentloaded",
                timeout=60000,
            )
            page.wait_for_timeout(4500)

            def current_body_text() -> str:
                try:
                    return " ".join(
                        page.locator("body").inner_text(timeout=10000).split()
                    )
                except Exception:
                    return ""

            body_text = current_body_text()

            # Some Speedhive builds do not automatically execute the query
            # from ?term= when loaded headlessly. If the result date is not
            # visible yet, explicitly submit the same public search.
            if (
                search_term
                and not any(
                    variant.lower() in body_text.lower()
                    for variant in date_variants
                )
            ):
                inputs = page.locator("input")
                filled = False

                for index in range(inputs.count()):
                    field = inputs.nth(index)
                    try:
                        if not field.is_visible():
                            continue

                        value = str(field.input_value() or "").strip().lower()
                        placeholder = str(
                            field.get_attribute("placeholder") or ""
                        ).lower()

                        if (
                            value == search_term.lower()
                            or "search" in placeholder
                            or index == 0
                        ):
                            field.fill(search_term)
                            filled = True
                            break
                    except Exception:
                        continue

                if filled:
                    search_buttons = page.get_by_text("Search", exact=True)

                    for index in range(search_buttons.count()):
                        button = search_buttons.nth(index)
                        try:
                            if button.is_visible():
                                button.click()
                                break
                        except Exception:
                            continue

                    page.wait_for_timeout(5000)
                    body_text = current_body_text()

            # Return the smallest DOM rows that contain both our track/search
            # term and the exact race date. This works even when Speedhive
            # uses JS click handlers instead of ordinary href links.
            candidate_rows = page.evaluate(
                """({ track, searchTerm, dates }) => {
                  const norm = value =>
                    String(value || "")
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, " ")
                      .trim()
                      .replace(/\\s+/g, " ");

                  const wantedTerms = [track, searchTerm]
                    .map(norm)
                    .filter(Boolean);

                  const wantedDates = dates.map(value =>
                    String(value || "").toLowerCase()
                  );

                  const matches = el => {
                    const text = String(el.innerText || "")
                      .replace(/\\s+/g, " ")
                      .trim();

                    if (!text) return false;

                    const normalized = norm(text);
                    const trackOk = wantedTerms.some(term =>
                      normalized.includes(term)
                    );
                    const dateOk = wantedDates.some(value =>
                      text.toLowerCase().includes(value)
                    );

                    return trackOk && dateOk;
                  };

                  return Array.from(document.querySelectorAll("body *"))
                    .filter(el => matches(el))
                    .filter(el =>
                      !Array.from(el.children || []).some(child => matches(child))
                    )
                    .map((el, index) => ({
                      index,
                      text: String(el.innerText || "")
                        .replace(/\\s+/g, " ")
                        .trim(),
                      tag: el.tagName,
                      role: el.getAttribute("role") || "",
                      className:
                        typeof el.className === "string"
                          ? el.className.slice(0, 180)
                          : "",
                    }));
                }""",
                {
                    "track": track,
                    "searchTerm": search_term,
                    "dates": date_variants,
                },
            )

            print(
                f"  Visible rows matching track + exact date: "
                f"{len(candidate_rows)}"
            )

            for row in candidate_rows[:10]:
                print(
                    f"    {row.get('tag','?')} | "
                    f"{str(row.get('text',''))[:220]}"
                )

            if not candidate_rows:
                preview = body_text[:1500]
                raise RuntimeError(
                    f"No visible Speedhive result matched {track} on the F300 weekend ({', '.join(date_keys)}). "
                    "The event may not have been created yet, or Speedhive did "
                    f"not return search results to the runner. Page text: {preview}"
                )

            # De-duplicate equivalent visible row text.
            unique_rows = []
            seen_text = set()

            for row in candidate_rows:
                key = " ".join(str(row.get("text", "")).split()).lower()
                if not key or key in seen_text:
                    continue
                seen_text.add(key)
                unique_rows.append(row)

            if len(unique_rows) > 1:
                options = " | ".join(
                    str(row.get("text", ""))[:180]
                    for row in unique_rows[:6]
                )
                raise RuntimeError(
                    f"More than one Speedhive result matched {track} on the F300 weekend "
                    f"({', '.join(date_keys)}). The bot will not guess. Matches: {options}"
                )

            target_text = unique_rows[0]["text"]

            print(f"\n  Clicking matched public result: {target_text}")

            clicked = page.evaluate(
                """({ track, searchTerm, dates, targetText }) => {
                  const norm = value =>
                    String(value || "")
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, " ")
                      .trim()
                      .replace(/\\s+/g, " ");

                  const wantedTerms = [track, searchTerm]
                    .map(norm)
                    .filter(Boolean);

                  const wantedDates = dates.map(value =>
                    String(value || "").toLowerCase()
                  );

                  const matches = el => {
                    const text = String(el.innerText || "")
                      .replace(/\\s+/g, " ")
                      .trim();

                    if (!text) return false;

                    const normalized = norm(text);
                    return (
                      wantedTerms.some(term => normalized.includes(term)) &&
                      wantedDates.some(value =>
                        text.toLowerCase().includes(value)
                      )
                    );
                  };

                  const rows = Array.from(
                    document.querySelectorAll("body *")
                  )
                    .filter(el => matches(el))
                    .filter(el =>
                      !Array.from(el.children || []).some(child => matches(child))
                    );

                  const row = rows.find(el =>
                    String(el.innerText || "")
                      .replace(/\\s+/g, " ")
                      .trim() === targetText
                  );

                  if (!row) return false;

                  // Click the visible row first. React/Angular click handlers
                  // attached to a parent still receive this bubbled click.
                  row.click();
                  return true;
                }""",
                {
                    "track": track,
                    "searchTerm": search_term,
                    "dates": date_variants,
                    "targetText": target_text,
                },
            )

            if not clicked:
                raise RuntimeError(
                    "The matching Speedhive row disappeared before it could "
                    "be opened."
                )

            try:
                page.wait_for_url(
                    re.compile(r".*/events/\d+.*", flags=re.I),
                    timeout=15000,
                )
            except Exception:
                # Some rows put the click target on a parent/button rather
                # than the text container. Try clicking the closest clickable
                # ancestor or descendant before giving up.
                page.evaluate(
                    """({ track, searchTerm, dates, targetText }) => {
                      const norm = value =>
                        String(value || "")
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, " ")
                          .trim()
                          .replace(/\\s+/g, " ");

                      const wantedTerms = [track, searchTerm]
                        .map(norm)
                        .filter(Boolean);
                      const wantedDates = dates.map(value =>
                        String(value || "").toLowerCase()
                      );

                      const matches = el => {
                        const text = String(el.innerText || "")
                          .replace(/\\s+/g, " ")
                          .trim();

                        if (!text) return false;

                        const normalized = norm(text);
                        return (
                          wantedTerms.some(term =>
                            normalized.includes(term)
                          ) &&
                          wantedDates.some(value =>
                            text.toLowerCase().includes(value)
                          )
                        );
                      };

                      const rows = Array.from(
                        document.querySelectorAll("body *")
                      )
                        .filter(el => matches(el))
                        .filter(el =>
                          !Array.from(el.children || [])
                            .some(child => matches(child))
                        );

                      const row = rows.find(el =>
                        String(el.innerText || "")
                          .replace(/\\s+/g, " ")
                          .trim() === targetText
                      );

                      if (!row) return false;

                      let node = row;
                      for (let i = 0; i < 6 && node; i += 1) {
                        const role = node.getAttribute?.("role") || "";
                        const style = window.getComputedStyle(node);
                        if (
                          node.tagName === "A" ||
                          node.tagName === "BUTTON" ||
                          role === "link" ||
                          role === "button" ||
                          style.cursor === "pointer"
                        ) {
                          node.click();
                          return true;
                        }
                        node = node.parentElement;
                      }

                      const child = row.querySelector(
                        'a,button,[role="link"],[role="button"],svg'
                      );

                      if (child) {
                        child.click();
                        return true;
                      }

                      return false;
                    }""",
                    {
                        "track": track,
                        "searchTerm": search_term,
                        "dates": date_variants,
                        "targetText": target_text,
                    },
                )

                try:
                    page.wait_for_url(
                        re.compile(r".*/events/\d+.*", flags=re.I),
                        timeout=12000,
                    )
                except Exception as exc:
                    raise RuntimeError(
                        "Speedhive showed the correct dated event row, but "
                        "the automated browser could not open it. "
                        f"Current URL remained: {page.url}"
                    ) from exc

            match = re.search(
                r"/events/(\d+)",
                page.url,
                flags=re.I,
            )

            if not match:
                raise RuntimeError(
                    f"Speedhive opened the result but no event ID was present "
                    f"in the URL: {page.url}"
                )

            event_id = int(match.group(1))

            print(
                f"Automatically discovered Speedhive event ID: {event_id}"
            )

            return event_id
        finally:
            browser.close()


def pick_event_id(
    client: SpeedhiveClient,
    requested: str,
    race_context: dict[str, str] | None = None,
) -> int:
    explicit = event_id_from_value(requested)
    if explicit:
        return explicit

    requested_clean = str(requested or "").strip().lower()
    if requested_clean in {"", "auto", "speedhive"}:
        if not race_context:
            raise RuntimeError(
                "The F300 Race Calendar is required for automatic Speedhive discovery."
            )

        auto_url = (
            "https://speedhive.mylaps.com/search?term="
            f"{quote_plus(race_context['track'])}&source="
        )
        print(f"Auto-built Speedhive search URL: {auto_url}")
        return discover_event_id_from_search(auto_url, race_context)

    if is_speedhive_search_url(requested):
        if not race_context:
            raise RuntimeError(
                "The F300 Race Calendar is required when using a Speedhive search URL."
            )

        return discover_event_id_from_search(
            requested,
            race_context,
        )

    org_text = os.environ.get("SPEEDHIVE_ORG_ID", "").strip()
    if not org_text.isdigit():
        raise RuntimeError(
            "The Event value was neither a Speedhive event URL/ID nor a supported "
            "public Speedhive search URL, and SPEEDHIVE_ORG_ID is not configured."
        )

    org_id = int(org_text)
    events = client.get_events(org_id, limit=25)

    if not events:
        raise RuntimeError(f"No recent Speedhive events were found for organization {org_id}.")

    # Newest item is normally first. Prefer an event that looks like Lydd/LIKC
    # or today's date, otherwise use the newest and print what was selected.
    for event in events:
        blob = text_blob(event)
        if "lydd" in blob or "likc" in blob:
            event_id = event.get("id") or lookup_any(event, ("eventId", "event_id", "id"))
            if event_id:
                print(f"Auto-selected Speedhive event: {event_id} ({session_name(event)})")
                return int(event_id)

    event = events[0]
    event_id = event.get("id") or lookup_any(event, ("eventId", "event_id", "id"))

    if not event_id:
        raise RuntimeError("Could not determine the newest Speedhive event ID.")

    print(f"Auto-selected newest Speedhive event: {event_id}")
    return int(event_id)


def main() -> int:
    print(f"F300 Speedhive bot version: {BOT_VERSION}", flush=True)
    args = parse_args()

    print(
        f"Requested event/search: {args.event} | F300 round: {args.round} | dry_run={args.dry_run}",
        flush=True,
    )

    if args.round < 1:
        raise RuntimeError("Round must be 1 or greater.")

    f300_feed = fetch_f300_feed()
    race_context = f300_race_context(f300_feed, args.round)

    client = SpeedhiveClient.create(timeout=30)
    event_id = pick_event_id(
        client,
        args.event,
        race_context=race_context,
    )

    event = client.get_event(event_id, include_sessions=True) or {}
    event_title = (
        lookup_any(event, ("name", "eventName", "event_name", "title"), max_depth=2)
        or f"Speedhive event {event_id}"
    )

    print(f"Event: {event_title}")
    print(f"Event ID: {event_id}")
    print(f"F300 round: {args.round}")
    print(
        f"F300 calendar: {race_context['track']} · "
        f"{', '.join(race_context.get('dateKeys') or [race_context['dateKey']])}"
    )

    by_number, by_name = f300_roster_from_feed(f300_feed)
    if by_name:
        print(f"Loaded {len(by_name)} F300 drivers for session matching.")
    else:
        print("Warning: F300 roster could not be loaded; relying on F300 text labels only.")

    sessions = grouped_sessions_with_context(event)

    if not sessions:
        sessions = client.get_sessions(event_id)

    print(f"Speedhive sessions found: {len(sessions)}")

    diagnostics: list[dict[str, Any]] = []
    f300_candidates: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []

    for session in sessions:
        sid = session.get("id") or lookup_any(
            session,
            ("id", "sessionId", "session_id"),
        )
        if not sid:
            continue

        name = session_name(session) or f"Session {sid}"
        context = str(session.get("_f300_parent_context") or "").strip()
        rows = client.get_results(int(sid))
        looks_f300 = is_f300_session(
            session,
            rows,
            by_number,
            by_name,
        )

        diagnostics.append(
            {
                "id": sid,
                "context": context,
                "name": name,
                "results": len(rows),
                "looks_f300": looks_f300,
                "practice": is_practice_session(f"{context} {name}"),
                "actual_final": is_actual_final_session(f"{context} {name}"),
                "sample_keys": (
                    sorted(rows[0].keys())
                    if rows and isinstance(rows[0], dict)
                    else []
                ),
            }
        )

        if looks_f300:
            f300_candidates.append((session, rows))

    f300_candidates.sort(key=lambda item: session_sort_value(item[0]))

    warnings: list[str] = []
    scoring_before_final: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    final_candidates: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []

    for session, rows in f300_candidates:
        name = session_name(session)
        context = str(session.get("_f300_parent_context") or "")
        label = f"{context} {name}".strip()

        if is_practice_session(label):
            continue

        if is_actual_final_session(label):
            final_candidates.append((session, rows))
            continue

        scoring_before_final.append((session, rows))

    if len(scoring_before_final) > 3:
        extras = [
            session_name(item[0]) or str(item[0].get("id") or "?")
            for item in scoring_before_final[3:]
        ]
        warnings.append(
            "More than three non-practice sessions were found before the Final. "
            "The first three were mapped to H1/H2/H3 and these extra sessions "
            f"were not imported: {', '.join(extras)}"
        )

    if final_candidates and len(scoring_before_final) < 3:
        warnings.append(
            f"A Final was found but only {len(scoring_before_final)} scoring "
            "session(s) were found before it."
        )

    if len(final_candidates) > 1:
        warnings.append(
            "More than one Final-like session was found. "
            "The latest Final was used."
        )

    mapped: dict[str, tuple[dict[str, Any], list[dict[str, Any]], str]] = {}

    for index, item in enumerate(scoring_before_final[:3]):
        key = ("h1", "h2", "h3")[index]
        session, rows = item
        mapped[key] = (
            session,
            rows,
            (
                f"Mapped by race-day order: non-practice scoring session "
                f"{index + 1} → {key.upper()}."
            ),
        )

    if final_candidates:
        session, rows = final_candidates[-1]
        mapped["final"] = (
            session,
            rows,
            "Mapped because this is the actual Final (Pre-Final is not treated as Final).",
        )

    ordered_keys = ["h1", "h2", "h3", "final"]
    session_payloads: list[dict[str, Any]] = []

    for key in ordered_keys:
        if key not in mapped:
            continue

        session, rows, reason = mapped[key]
        payload = build_session_payload(
            client,
            session,
            rows,
            key,
            by_number,
            by_name,
            reason,
        )

        if not payload["results"]:
            warnings.append(
                f"{payload['name']} mapped to {key.upper()} but no drivers "
                "matched the current F300 roster."
            )

        session_payloads.append(payload)

    print("\nRecognized F300 sessions:")
    if not session_payloads:
        print("  NONE")
        print("\nSpeedhive session diagnostic:")
        for item in diagnostics:
            print(
                f"  id={item['id']} | "
                f"context={item['context'] or '-'} | "
                f"name={item['name']} | "
                f"practice={item['practice']} | "
                f"actual_final={item['actual_final']} | "
                f"results={item['result_count']} | "
                f"looks_f300={item['looks_f300']} | "
                f"sample_keys={','.join(item['sample_keys'][:20]) or '-'}"
            )

        print(
            "\nNothing was written. This diagnostic run succeeded; "
            "the output above tells us exactly how Speedhive labels this event."
        )
        return 0

    for session in session_payloads:
        print(
            f"  {session['key']:>5} | {session['name']} | "
            f"{len(session['results'])} results"
        )
        for row in session["results"][:30]:
            result_text = row["status"] or row["position"] or "-"
            lap_text = (
                f"{row['bestLap']:.3f}"
                if isinstance(row["bestLap"], (int, float))
                else "-"
            )
            print(
                f"        #{row['number'] or '?':<4} "
                f"{row['name'] or 'Unknown':<28} "
                f"P={result_text!s:<4} best={lap_text} "
                f"webpos={row.get('lapPagePos') or '-'} "
                f"laps={len(row.get('laps') or [])}"
            )

            if args.dry_run:
                for lap in row.get("laps") or []:
                    pit = " PIT" if lap.get("inPit") else ""
                    speed = (
                        f" speed={lap['speed']:.3f}"
                        if isinstance(lap.get("speed"), (int, float))
                        else ""
                    )
                    print(
                        f"              Lap {int(lap['lap']):>2}: "
                        f"{float(lap['time']):.3f}{pit}{speed}"
                    )

    if warnings:
        print("\nImporter warnings:")
        for warning in warnings:
            print(f"  - {warning}")

    outgoing = {
        "action": "timingImport",
        "secret": os.environ.get("F300_TIMING_BOT_SECRET", ""),
        "source": "Speedhive",
        "eventId": str(event_id),
        "round": args.round,
        "warnings": warnings,
        "sessions": session_payloads,
    }

    if args.dry_run:
        print("\nDRY RUN: Google Sheet was not changed.")
        return 0

    data_url = os.environ.get("F300_DATA_URL", "").strip()
    secret = os.environ.get("F300_TIMING_BOT_SECRET", "").strip()

    if not data_url:
        raise RuntimeError("F300_DATA_URL GitHub secret is missing.")
    if not secret:
        raise RuntimeError("F300_TIMING_BOT_SECRET GitHub secret is missing.")

    response = requests.post(
        data_url,
        json=outgoing,
        timeout=60,
        allow_redirects=True,
    )
    response.raise_for_status()

    try:
        result = response.json()
    except ValueError as exc:
        raise RuntimeError(
            f"F300 backend returned non-JSON: {response.text[:500]}"
        ) from exc

    if not result.get("ok"):
        raise RuntimeError(result.get("error") or f"F300 import failed: {result}")

    print("\nGoogle Sheet import complete:")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
