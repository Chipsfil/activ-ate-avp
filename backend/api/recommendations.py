"""Fixed recommendations used until recommendation generation is implemented."""

from datetime import datetime, timezone

from flask import Blueprint

from .common import auth_required

bp = Blueprint("recommendations", __name__)

# Preserve the original behavior: these timestamps describe backend startup.
DAILY_GENERATED_AT = datetime.now(timezone.utc).isoformat()
WORKOUT_GENERATED_AT = datetime.now(timezone.utc).isoformat()
NUTRITION_GENERATED_AT = datetime.now(timezone.utc).isoformat()


@bp.get("/api/v1/recommendations/daily")
@auth_required
def rec_daily():
    # Return the fixed daily advice, with no proposed workout session.
    return {
        "workout": "Keep moving toward your weekly target.",
        "nutrition": "Aim for balanced meals.",
        "suggested_session": None,
        "generated_at": DAILY_GENERATED_AT,
    }


@bp.get("/api/v1/recommendations/workout")
@auth_required
def rec_workout():
    # Return the current workout fallback; detailed tips are still empty.
    return {
        "text": "Follow your planned sessions consistently.",
        "tips": [],
        "generated_at": WORKOUT_GENERATED_AT,
    }


@bp.get("/api/v1/recommendations/nutrition")
@auth_required
def rec_nutrition():
    # Return the current nutrition fallback without specific food suggestions.
    return {
        "text": "Use your nutrition targets as a guide.",
        "more_of": [],
        "watch": [],
        "generated_at": NUTRITION_GENERATED_AT,
    }
