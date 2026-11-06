"""Shared helpers for the Activ-Ate API."""

import hashlib
import secrets
from datetime import date, datetime, timedelta, timezone
from functools import wraps

import jwt
import psycopg
from flask import g, jsonify, make_response, request
from config import (
    ACCESS_TOKEN_TTL_MINUTES,
    COOKIE_SAMESITE,
    COOKIE_SECURE,
    DATABASE_URL,
    JWT_SECRET,
)


def conn():
    """Return rows as dictionaries so queries can use column names."""
    return psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row)


def err(message, code="validation_error", status=422, field=None):
    # Use the same JSON error format for every endpoint.
    # Include the field name only when the error refers to a specific input.
    response = {"error": code, "message": message}
    if field:
        response["field"] = field
    return jsonify(response), status


def body():
    # Read the JSON request body; missing or invalid JSON falls back to an empty dict.
    return request.get_json(silent=True) or {}


def iso(value):
    # Convert dates to text such as "2026-10-23"; leave other values unchanged.
    return value.isoformat() if hasattr(value, "isoformat") else value


def token_hash(value):
    # Convert the token to bytes, hash it, and return the hash as text.
    return hashlib.sha256(value.encode()).hexdigest()


def access_token(user_id):
    # The token identifies the user (sub) and expires after the configured TTL.
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(timezone.utc)
        + timedelta(minutes=ACCESS_TOKEN_TTL_MINUTES),
    }
    # Sign the token so later requests can be checked with the same secret.
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def user_json(connection, user_id):
    # The profile is assembled from the user, goals, sports, and weight tables.
    user = connection.execute("SELECT * FROM users WHERE id=%s", (user_id,)).fetchone()
    # Keep goals in the order in which the user selected them.
    goal_rows = connection.execute(
        "SELECT goal FROM user_goals WHERE user_id=%s ORDER BY position",
        (user_id,),
    )
    goals = [row["goal"] for row in goal_rows]

    # Return both the display name and catalogue ID for each selected sport.
    sport_rows = connection.execute(
        "SELECT name,sport_id FROM user_sports WHERE user_id=%s ORDER BY name",
        (user_id,),
    )
    sports = [{"name": row["name"], "sport_id": row["sport_id"]} for row in sport_rows]

    # Use the weight entry with the most recent measurement date.
    weight = connection.execute(
        "SELECT weight_kg FROM body_weights "
        "WHERE user_id=%s ORDER BY measured_on DESC LIMIT 1",
        (user_id,),
    ).fetchone()

    # Convert database UUIDs, dates, and decimal numbers to API response values.
    return {
        "id": str(user["id"]),
        "username": user["username"],
        "email": user["email"],
        "first_name": user["first_name"],
        "last_name": user["last_name"],
        "initials": (user["first_name"][0] + user["last_name"][0]).upper(),
        "gender": user["gender"],
        "date_of_birth": iso(user["date_of_birth"]),
        "height_cm": float(user["height_cm"]),
        "onboarding_step": user["onboarding_step"],
        "goals": goals,
        "sports": sports,
        "current_weight_kg": float(weight["weight_kg"]) if weight else None,
        "created_at": user["created_at"].isoformat(),
    }


def auth_required(view_function):
    """Check the access token and make its user ID available to the route."""

    # Preserve the route function name when Flask registers this wrapper.
    @wraps(view_function)
    def wrapped(*args, **kwargs):
        # Protected requests must send an Authorization: Bearer <token> header.
        raw = request.headers.get("Authorization", "")
        if not raw.startswith("Bearer "):
            return err("Authentication is required.", "unauthorized", 401)

        # Remove "Bearer ", verify the signature and expiry, then read the user ID.
        try:
            user_id = jwt.decode(raw[7:], JWT_SECRET, algorithms=["HS256"])["sub"]
        except (jwt.InvalidTokenError, KeyError):
            return err("Your session has expired.", "unauthorized", 401)

        # A valid token may belong to a user whose account has since been deleted.
        with conn() as connection:
            user_exists = connection.execute(
                "SELECT 1 FROM users WHERE id=%s", (user_id,)
            ).fetchone()
            if not user_exists:
                return err("User not found.", "unauthorized", 401)

        # g stores values for this request, so the route can use the verified ID.
        g.user_id = user_id
        return view_function(*args, **kwargs)

    return wrapped


def refresh_response(connection, user_id):
    # Only the hash is stored in PostgreSQL; the browser receives the raw token.
    raw = secrets.token_urlsafe(48)
    connection.execute(
        "INSERT INTO refresh_sessions(user_id,token_hash,expires_at) "
        "VALUES(%s,%s,%s)",
        (
            user_id,
            token_hash(raw),
            datetime.now(timezone.utc) + timedelta(days=30),
        ),
    )

    # Return the access token and profile in the JSON response.
    response = make_response(
        jsonify(
            {
                "access_token": access_token(user_id),
                "user": user_json(connection, user_id),
            }
        )
    )
    # HttpOnly prevents browser JavaScript from reading the refresh cookie.
    # The cookie is sent only to auth endpoints and lasts for 30 days.
    response.set_cookie(
        "refresh_token",
        raw,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        path="/api/v1/auth",
        max_age=2592000,
    )
    return response


def parse_date(value, default=None):
    """Use the default for missing dates and return None for invalid dates."""
    try:
        if value:
            return date.fromisoformat(value)
        return default
    except (TypeError, ValueError):
        return None


def current_weight(connection, user_id):
    row = connection.execute(
        "SELECT weight_kg FROM body_weights "
        "WHERE user_id=%s ORDER BY measured_on DESC LIMIT 1",
        (user_id,),
    ).fetchone()
    if row:
        return float(row["weight_kg"])
    # Keep the calorie estimate available before a weight has been recorded.
    return 70.0


def week_start(day=None):
    """Return the Monday of the given day, or of today when no day is given."""
    day = day or date.today()
    # weekday() is 0 for Monday, 1 for Tuesday, and so on.
    return day - timedelta(days=day.weekday())


def weekly_target(connection, user_id):
    """Add the activity goals, using 150 minutes when their total is zero."""
    # For each goal, multiply session length by sessions per week, then add them.
    row = connection.execute(
        "SELECT COALESCE(SUM(minutes_per_session*sessions_per_week),0) target "
        "FROM activity_goals WHERE user_id=%s",
        (user_id,),
    ).fetchone()
    return int(row["target"]) or 150
