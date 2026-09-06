#!/usr/bin/env python3
"""
F300 Speedhive result importer.

Pilot mode:
- Give it a Speedhive event URL/ID and F300 round.
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
from typing import Any, Iterable

import requests
from speedhive.wrapper import SpeedhiveClient


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
        help="Speedhive event URL or numeric event ID",
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


def fetch_f300_roster() -> tuple[dict[str, str], dict[str, str]]:
    data_url = os.environ.get("F300_DATA_URL", "").strip()

    if not data_url:
        return {}, {}

    response = requests.get(data_url, timeout=30)
    response.raise_for_status()
    data = response.json()

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


def lap_lookup(
    client: SpeedhiveClient,
    session_id: int,
) -> tuple[dict[str, float], dict[str, float]]:
    by_competitor: dict[str, list[float]] = defaultdict(list)
    by_number: dict[str, list[float]] = defaultdict(list)

    try:
        laps = client.get_laps(session_id)
    except Exception:
        return {}, {}

    for lap in laps:
        if not isinstance(lap, dict):
            continue

        seconds = to_seconds(
            lookup_any(
                lap,
                ("lapTime", "lap_time", "time", "duration"),
                max_depth=2,
            )
        )
        if seconds is None:
            continue

        comp_id = str(
            lookup_any(
                lap,
                ("competitorId", "competitor_id"),
                max_depth=2,
            )
            or ""
        ).strip()

        number = normalize_number(
            lookup_any(
                lap,
                ("startNumber", "start_number", "number"),
                max_depth=2,
            )
        )

        if comp_id:
            by_competitor[comp_id].append(seconds)
        if number:
            by_number[number].append(seconds)

    return (
        {key: min(values) for key, values in by_competitor.items() if values},
        {key: min(values) for key, values in by_number.items() if values},
    )


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
    comp_laps, number_laps = lap_lookup(client, session_id)

    results: list[dict[str, Any]] = []

    for row in rows:
        if not isinstance(row, dict):
            continue

        if not likely_f300_result(row, by_number, by_name):
            continue

        number = result_number(row)
        name = result_name(row)
        position = result_position(row)
        status = result_status(row)
        best_lap = result_best_lap(row)

        if best_lap is None:
            cid = competitor_id(row)
            if cid and cid in comp_laps:
                best_lap = comp_laps[cid]
            else:
                normalized_number = normalize_number(number)
                if normalized_number in number_laps:
                    best_lap = number_laps[normalized_number]

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


def pick_event_id(
    client: SpeedhiveClient,
    requested: str,
) -> int:
    explicit = event_id_from_value(requested)
    if explicit:
        return explicit

    org_text = os.environ.get("SPEEDHIVE_ORG_ID", "").strip()
    if not org_text.isdigit():
        raise RuntimeError(
            "No Speedhive event ID was supplied and SPEEDHIVE_ORG_ID is not configured."
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
    args = parse_args()

    if args.round < 1:
        raise RuntimeError("Round must be 1 or greater.")

    client = SpeedhiveClient.create(timeout=30)
    event_id = pick_event_id(client, args.event)

    event = client.get_event(event_id, include_sessions=True) or {}
    event_title = (
        lookup_any(event, ("name", "eventName", "event_name", "title"), max_depth=2)
        or f"Speedhive event {event_id}"
    )

    print(f"Event: {event_title}")
    print(f"Event ID: {event_id}")
    print(f"F300 round: {args.round}")

    by_number, by_name = fetch_f300_roster()
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
                f"P={result_text!s:<4} best={lap_text}"
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
