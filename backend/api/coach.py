"""Coach context and fixed replies to the suggested questions."""

from datetime import datetime, timezone
from uuid import uuid4

from flask import Blueprint, g

from .common import auth_required, body, conn, user_json, weekly_target

bp = Blueprint("coach", __name__)

# Each suggested question has a fixed reply; this does not call an AI service.
PROMPTS = {
    "Build my training plan for next week": "Start with three sessions next week: one easy cardio session, one strength session, and one session for your favorite sport.",
    "What should I eat before my run?": "Have a light meal with carbohydrates and some protein one to two hours before running, and drink water.",
    "How can I get more protein?": "Add a protein source to each main meal, such as eggs, yogurt, beans, fish, chicken, or tofu.",
    "How do I compare to my network?": "Open Community to compare your exercise minutes with the other members this week.",
    "I feel tired – how can I sleep and recover better?": "Keep a regular sleep schedule, drink enough water, and add easy recovery days between harder workouts.",
}


@bp.get("/api/v1/coach/context")
@auth_required
def coach_context():
    # Load the profile and weekly target used by the coach context cards.
    with conn() as connection:
        user = user_json(connection, g.user_id)
        target = weekly_target(connection, g.user_id)
    return {
        "items": [
            {"label": "Name", "value": f"{user['first_name']} {user['last_name']}"},
            {"label": "Height", "value": f"{user['height_cm']:g} cm"},
            {
                "label": "Weight",
                "value": (
                    f"{user['current_weight_kg']:g} kg"
                    if user["current_weight_kg"] is not None
                    else "Not recorded"
                ),
            },
            {
                "label": "Sports",
                "value": ", ".join(sport["name"] for sport in user["sports"])
                or "No sports selected",
            },
            {"label": "Weekly activity target", "value": f"{target} minutes"},
        ]
    }


@bp.get("/api/v1/coach/conversations/latest")
@auth_required
def latest_chat():
    # Conversations are not persisted yet; keep the current empty response.
    return {"conversation_id": None, "messages": []}


@bp.post("/api/v1/coach/conversations")
@auth_required
def new_chat():
    # Create a unique conversation ID; no conversation row is saved yet.
    return {"conversation_id": str(uuid4()), "messages": []}, 201


@bp.post("/api/v1/coach/messages")
@auth_required
def chat_message():
    values = body()
    text = values.get("text", "").strip()
    # Look up the exact suggested question, or use the default reply.
    answer = PROMPTS.get(
        text, "Choose one of the suggested questions to get a quick training tip."
    )
    # Reuse the supplied conversation ID or generate one for this response.
    return {
        "conversation_id": values.get("conversation_id") or str(uuid4()),
        "message": {
            "role": "assistant",
            "content": answer,
            "created_at": datetime.now(timezone.utc).isoformat(),
        },
        "proposed_sessions": [],
    }
