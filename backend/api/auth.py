"""Registration, access tokens, and refresh-cookie sessions."""

import psycopg
from flask import Blueprint, make_response, request
from werkzeug.security import check_password_hash, generate_password_hash

from .common import (
    body,
    conn,
    err,
    parse_date,
    refresh_response,
    token_hash,
)

bp = Blueprint("auth", __name__)


@bp.get("/api/v1/auth/username-available")
def username_available():
    # Read the username from the URL query and compare it in lowercase.
    name = request.args.get("username", "").lower()
    if len(name) < 3:
        return {"available": False, "reason": "too_short"}

    with conn() as connection:
        exists = connection.execute(
            "SELECT 1 FROM users WHERE username=%s", (name,)
        ).fetchone()
    return {"available": not exists}


@bp.post("/api/v1/auth/register")
def register():
    values = body()
    # Check that all registration inputs are present before creating an account.
    required = (
        "first_name",
        "last_name",
        "username",
        "email",
        "password",
        "gender",
        "date_of_birth",
        "weight_kg",
        "height_cm",
    )
    if any(key not in values for key in required):
        return err("All registration fields are required.")
    if len(values["password"]) < 8:
        return err(
            "Password must be at least 8 characters.",
            "validation_error",
            422,
            "password",
        )

    date_of_birth = parse_date(values["date_of_birth"])
    if not date_of_birth:
        return err(
            "Date of birth must be a valid date.",
            "validation_error",
            422,
            "date_of_birth",
        )

    with conn() as connection:
        # Normalize account identifiers and reject duplicates before inserting.
        username = values["username"].lower()
        email = values["email"].lower()
        if connection.execute(
            "SELECT 1 FROM users WHERE username=%s", (username,)
        ).fetchone():
            return err("Username is already taken.", "conflict", 409, "username")
        if connection.execute(
            "SELECT 1 FROM users WHERE email=%s", (email,)
        ).fetchone():
            return err("Email is already registered.", "conflict", 409, "email")
        # Store a password hash, not the original password; get the new user ID.
        try:
            user = connection.execute(
                """INSERT INTO users(
                    username, email, password_hash, first_name, last_name,
                    gender, date_of_birth, height_cm
                ) VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                (
                    username,
                    email,
                    generate_password_hash(values["password"]),
                    values["first_name"],
                    values["last_name"],
                    values["gender"],
                    date_of_birth,
                    values["height_cm"],
                ),
            ).fetchone()
            # Save the starting weight as a separate measurement linked to the user.
            connection.execute(
                "INSERT INTO body_weights(user_id,weight_kg,measured_on) "
                "VALUES(%s,%s,CURRENT_DATE)",
                (user["id"], values["weight_kg"]),
            )
            connection.commit()
            return refresh_response(connection, user["id"]), 201
        # A failed height or weight constraint must undo the registration writes.
        except psycopg.errors.CheckViolation:
            connection.rollback()
            return err("Height and weight are outside allowed ranges.")


@bp.post("/api/v1/auth/login")
def login():
    values = body()
    username = values.get("username", "").lower()
    with conn() as connection:
        user = connection.execute(
            "SELECT id,password_hash FROM users " "WHERE username=%s OR email=%s",
            (username, username),
        ).fetchone()
        # Accept either username or email, then verify the supplied password.
        if not user or not check_password_hash(
            user["password_hash"], values.get("password", "")
        ):
            return err("Invalid username or password.", "invalid_credentials", 401)
        return refresh_response(connection, user["id"])


@bp.post("/api/v1/auth/refresh")
def refresh():
    # A refresh cookie can issue a new access token without another password login.
    raw = request.cookies.get("refresh_token")
    with conn() as connection:
        session = None
        # Match the stored hash and accept only unrevoked, unexpired sessions.
        if raw:
            session = connection.execute(
                "SELECT user_id FROM refresh_sessions "
                "WHERE token_hash=%s AND revoked_at IS NULL AND expires_at>now()",
                (token_hash(raw),),
            ).fetchone()
        if not session:
            return err("Your session has expired.", "unauthorized", 401)
        # Revoke the old token before creating its replacement.
        connection.execute(
            "UPDATE refresh_sessions SET revoked_at=now() WHERE token_hash=%s",
            (token_hash(raw),),
        )
        connection.commit()
        return refresh_response(connection, session["user_id"])


@bp.post("/api/v1/auth/logout")
def logout():
    raw = request.cookies.get("refresh_token")
    with conn() as connection:
        if raw:
            connection.execute(
                "UPDATE refresh_sessions SET revoked_at=now() WHERE token_hash=%s",
                (token_hash(raw),),
            )
            connection.commit()
    # Clear the browser cookie as well as revoking the stored session above.
    response = make_response("", 204)
    response.delete_cookie("refresh_token", path="/api/v1/auth")
    return response
