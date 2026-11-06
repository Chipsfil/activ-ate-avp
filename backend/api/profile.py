"""Profile details, onboarding, and activity targets."""

from datetime import date

from flask import Blueprint, g

from .common import auth_required, body, conn, current_weight, err, user_json

bp = Blueprint("profile", __name__)


def valid_sport_ids(connection, sports):
    # Custom sports keep their names, but only catalogue IDs can be foreign keys.
    ids = {sport.get("sport_id") for sport in sports if sport.get("sport_id")}
    if not ids:
        return set()
    # ANY checks the selected IDs against the sports catalogue in one query.
    rows = connection.execute(
        "SELECT id FROM sports WHERE id = ANY(%s)",
        (list(ids),),
    ).fetchall()
    return {row["id"] for row in rows}


def replace_preferences(connection, user_id, goals, sports):
    """Replace the complete goal and sport lists within the caller's transaction."""
    sport_ids = valid_sport_ids(connection, sports)
    # Replace the old goal list and store each new goal with its list position.
    connection.execute("DELETE FROM user_goals WHERE user_id=%s", (user_id,))
    with connection.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO user_goals(user_id,goal,position) VALUES(%s,%s,%s)",
            [(user_id, goal, index) for index, goal in enumerate(goals)],
        )
    # Replace selected sports too; custom names can be saved without a catalogue ID.
    connection.execute("DELETE FROM user_sports WHERE user_id=%s", (user_id,))
    sport_rows = []
    for sport in sports:
        sport_id = sport.get("sport_id")
        if sport_id not in sport_ids:
            sport_id = None
        sport_rows.append((user_id, sport_id, sport["name"]))
    with connection.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO user_sports(user_id,sport_id,name) VALUES(%s,%s,%s)",
            sport_rows,
        )


@bp.get("/api/v1/me")
@auth_required
def me():
    # Authentication has already placed the current user ID in g.user_id.
    with conn() as connection:
        return user_json(connection, g.user_id)


@bp.put("/api/v1/me/goals")
@auth_required
def save_goals():
    values = body()
    goals = values.get("goals", [])
    sports = values.get("sports", [])
    if not goals or not sports:
        return err("Choose at least one goal and one sport.")
    with conn() as connection:
        replace_preferences(connection, g.user_id, goals, sports)
        # Selecting goals and sports advances onboarding to the targets step.
        connection.execute(
            "UPDATE users SET onboarding_step='3' WHERE id=%s", (g.user_id,)
        )
        connection.commit()
    return {"goals": goals, "sports": sports}


@bp.get("/api/v1/me/targets")
@auth_required
def get_targets():
    with conn() as connection:
        user_goals = connection.execute(
            "SELECT goal FROM user_goals WHERE user_id=%s ORDER BY position",
            (g.user_id,),
        ).fetchall()
        user_sports = connection.execute(
            "SELECT name,sport_id FROM user_sports WHERE user_id=%s ORDER BY name",
            (g.user_id,),
        ).fetchall()
        goals = connection.execute(
            "SELECT id,sport_id,sport_name,minutes_per_session,sessions_per_week "
            "FROM activity_goals WHERE user_id=%s",
            (g.user_id,),
        ).fetchall()
        weight = current_weight(connection, g.user_id)
    # Nutrition and weight goals keep their current empty placeholder values.
    return {
        "goals": [row["goal"] for row in user_goals],
        "sports": [
            {"name": row["name"], "sport_id": row["sport_id"]} for row in user_sports
        ],
        "activity_goals": [
            {
                "id": str(row["id"]),
                "sport": row["sport_name"],
                "sport_id": row["sport_id"],
                "minutes_per_session": row["minutes_per_session"],
                "sessions_per_week": row["sessions_per_week"],
            }
            for row in goals
        ],
        "nutrition_goals": [],
        "weight_goal": None,
        "current_weight_kg": weight,
    }


@bp.put("/api/v1/me/targets")
@auth_required
def save_targets():
    values = body()
    goals = values.get("activity_goals", [])
    if values.get("nutrition_goals"):
        return err("Nutrition is not implemented in the backend", "not_implemented", 501)
    if values.get("weight_goal") is not None:
        return err("Weight goals are not implemented yet.", "not_implemented", 501)
    # Only validate weight when the request includes a new weight value.
    if "current_weight_kg" in values:
        try:
            weight = float(values["current_weight_kg"])
        except (TypeError, ValueError):
            return err(
                "Weight must be a number.", "validation_error", 422, "current_weight_kg"
            )
        if not 30 <= weight <= 300:
            return err(
                "Weight must be between 30 and 300 kg.",
                "validation_error",
                422,
                "current_weight_kg",
            )
    with conn() as connection:
        latest_weight = connection.execute(
            "SELECT weight_kg FROM body_weights "
            "WHERE user_id=%s ORDER BY measured_on DESC LIMIT 1",
            (g.user_id,),
        ).fetchone()
        # Compare with the selected latest entry before adding another measurement.
        if "current_weight_kg" in values and (
            latest_weight is None or weight != float(latest_weight["weight_kg"])
        ):
            connection.execute(
                "INSERT INTO body_weights(user_id,weight_kg,measured_on) "
                "VALUES(%s,%s,%s)",
                (g.user_id, weight, date.today()),
            )
        # Preferences are replaced only when both lists are included in the request.
        if "goals" in values and "sports" in values:
            replace_preferences(
                connection, g.user_id, values["goals"], values["sports"]
            )
        # The submitted activity goals replace the entire previous activity-goal list.
        activity_sport_ids = valid_sport_ids(connection, goals)
        connection.execute("DELETE FROM activity_goals WHERE user_id=%s", (g.user_id,))
        goal_rows = []
        for goal in goals:
            sport_id = goal.get("sport_id")
            if sport_id not in activity_sport_ids:
                sport_id = None
            goal_rows.append(
                (
                    g.user_id,
                    sport_id,
                    goal["sport"],
                    goal["minutes_per_session"],
                    goal["sessions_per_week"],
                )
            )
        with connection.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO activity_goals(user_id,sport_id,sport_name,minutes_per_session,sessions_per_week) "
                "VALUES(%s,%s,%s,%s,%s)",
                goal_rows,
            )
        # Advance onboarding without moving an already completed user back a step.
        connection.execute(
            "UPDATE users SET onboarding_step='4' "
            "WHERE id=%s AND onboarding_step <> 'done'",
            (g.user_id,),
        )
        connection.commit()
    # Read the saved data back using the same response format as GET /me/targets.
    return get_targets()


@bp.post("/api/v1/me/onboarding/complete")
@auth_required
def complete():
    with conn() as connection:
        connection.execute(
            "UPDATE users SET onboarding_step='done' WHERE id=%s", (g.user_id,)
        )
        connection.commit()
    # Keep the existing onboarding response for the shared community.
    return {"network": {"id": "all-users", "member_count": 1}}


@bp.post("/api/v1/goals/check")
@auth_required
def goal_check():
    # Automatic goal checks are not implemented yet.
    return {"checks": []}
