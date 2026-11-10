"""Personalized AI recommendations for the dashboard, workouts, and nutrition."""

import json
from datetime import datetime, timezone

from flask import Blueprint, g

from .ai import AIError, SYSTEM, context, get_response
from .common import auth_required, conn, err

bp = Blueprint("recommendations", __name__)


def recommendation(kind):
    # Use the signed-in user's goals, sports, and weekly activity target.
    with conn() as connection:
        profile = context(connection, g.user_id)

    # Each page expects different fields, so show the model the required format.
    formats = {
        "daily": '{"workout": "short advice", "nutrition": "short advice"}',
        "workout": '{"text": "short advice", "tips": ["short tip"]}',
        "nutrition": '{"text": "short advice", "more_of": ["suggestion"], "watch": ["suggestion"]}',
    }
    # Separate the instructions, output format, and profile as in the slides.
    prompt = f"""Give short {kind} recommendations for the user.
Use the profile in the JSON block below as context.
If details are missing, give general advice without inventing meals, workouts,
or health information. Return only a JSON object in this format:
{formats[kind]}

User profile:
```json
{json.dumps(profile)}
```
"""
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": prompt},
    ]
    try:
        # Ask for JSON so the response can be used by the frontend.
        result = get_response(messages, json_output=True)
        if not isinstance(result, dict):
            raise ValueError
        # Check that the model returned the fields and types each page needs.
        fields = {"daily": {"workout": str, "nutrition": str},
                  "workout": {"text": str, "tips": list},
                  "nutrition": {"text": str, "more_of": list, "watch": list}}[kind]
        if any(not isinstance(result.get(key), expected) for key, expected in fields.items()):
            raise ValueError
        if any(not all(isinstance(item, str) for item in result[key])
               for key, expected in fields.items() if expected is list):
            raise ValueError
        # Keep only the expected fields, even if the model added extra ones.
        result = {key: result[key] for key in fields}
    except (AIError, ValueError):
        return err("AI recommendations are unavailable. Please try again.", "ai_unavailable", 503)

    # The frontend expects these fields in addition to the generated advice.
    if kind == "daily":
        result["suggested_session"] = None
    result["generated_at"] = datetime.now(timezone.utc).isoformat()
    return result


@bp.get("/api/v1/recommendations/daily")
@auth_required
def rec_daily():
    return recommendation("daily")


@bp.get("/api/v1/recommendations/workout")
@auth_required
def rec_workout():
    return recommendation("workout")


@bp.get("/api/v1/recommendations/nutrition")
@auth_required
def rec_nutrition():
    return recommendation("nutrition")
