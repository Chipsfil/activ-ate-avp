"""Profile details, onboarding, and activity targets."""

from datetime import date
import math

from flask import Blueprint, g

from .common import auth_required, body, conn, current_weight, err, user_json
from .target_history import preserve_baseline, snapshot

bp = Blueprint("profile", __name__)
NUTRIENT_UNITS = {"calories": "kcal", "protein": "g", "carbs": "g", "fat": "g", "water": "L"}


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
    # Replace the old goals with the new selection.
    connection.execute("DELETE FROM user_goals WHERE user_id=%s", (user_id,))
    with connection.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO user_goals(user_id,goal) VALUES(%s,%s)",
            [(user_id, goal) for goal in goals],
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
        user = connection.execute(
            "SELECT gender,date_of_birth,height_cm FROM users WHERE id=%s", (g.user_id,)
        ).fetchone()
        user_goals = connection.execute(
            "SELECT goal FROM user_goals WHERE user_id=%s ORDER BY goal",
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
        nutrition_goals = connection.execute("SELECT nutrient,amount FROM nutrition_goals WHERE user_id=%s ORDER BY nutrient", (g.user_id,)).fetchall()
        weight_goal = connection.execute("SELECT start_kg,target_kg,target_date FROM weight_goals WHERE user_id=%s", (g.user_id,)).fetchone()
        age = date.today().year - user["date_of_birth"].year - (
            (date.today().month, date.today().day)
            < (user["date_of_birth"].month, user["date_of_birth"].day)
        )
        sex_adjustment = {"male": 5, "female": -161}.get(user["gender"], -78)
        bmr = 10 * weight + 6.25 * float(user["height_cm"]) - 5 * age + sex_adjustment
        goals_set = {row["goal"] for row in user_goals}
        kcal = round((bmr * 1.55 + (250 if "gain_muscle" in goals_set else -400 if "lose_weight" in goals_set else 0)) / 50) * 50
        protein_default = round(weight * (1.8 if "gain_muscle" in goals_set else 1.4))
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
        "nutrition_goals": [{"nutrient": row["nutrient"], "amount": float(row["amount"]), "unit": NUTRIENT_UNITS[row["nutrient"]]} for row in nutrition_goals if row["nutrient"] in NUTRIENT_UNITS],
        "weight_goal": {"start_kg": float(weight_goal["start_kg"]), "target_kg": float(weight_goal["target_kg"]), "target_date": weight_goal["target_date"].isoformat() if weight_goal["target_date"] else None, "current_kg": weight} if weight_goal else None,
        "current_weight_kg": weight,
        "computed_defaults": {"kcal": kcal, "protein_g": protein_default},
    }


@bp.put("/api/v1/me/targets")
@auth_required
def save_targets():
    values = body()
    goals = values.get("activity_goals", [])
    if "nutrition_goals" in values:
        nutrition = values["nutrition_goals"]
        if not isinstance(nutrition, list):
            return err("Nutrition goals must be a list.", field="nutrition_goals")
        seen = set()
        for goal in nutrition:
            if not isinstance(goal, dict) or goal.get("nutrient") not in NUTRIENT_UNITS or goal["nutrient"] in seen:
                return err("Invalid or duplicate nutrition goal.", field="nutrition_goals")
            amount = goal.get("amount")
            if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount) or not 0 < amount <= 999999.99:
                return err("Nutrition goal amounts must be positive numbers.", field="nutrition_goals")
            seen.add(goal["nutrient"])
    weight_goal = values.get("weight_goal")
    target_date = None
    if weight_goal is not None:
        if not isinstance(weight_goal, dict):
            return err("Weight goal must be an object or null.", field="weight_goal")
        target = weight_goal.get("target_kg")
        if isinstance(target, bool) or not isinstance(target, (int, float)) or not math.isfinite(target) or not 30 <= target <= 300:
            return err("Target weight must be between 30 and 300 kg.", field="target_kg")
        if weight_goal.get("target_date") is not None:
            try:
                target_date = date.fromisoformat(weight_goal["target_date"])
            except (TypeError, ValueError):
                return err("Target date must be a valid date.", field="target_date")
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
            "WHERE user_id=%s ORDER BY measured_on DESC, created_at DESC LIMIT 1",
            (g.user_id,),
        ).fetchone()
        if "weight_goal" in values and weight_goal is not None:
            start = weight if "current_weight_kg" in values else (float(latest_weight["weight_kg"]) if latest_weight else None)
            if start is None:
                return err("Set a current weight before creating a weight goal.", field="current_weight_kg")
            existing_goal = connection.execute(
                "SELECT target_date FROM weight_goals WHERE user_id=%s", (g.user_id,)
            ).fetchone()
            if target_date and target_date <= date.today() and (not existing_goal or target_date != existing_goal["target_date"]):
                return err("The target date must be in the future.", field="target_date")
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
        if "activity_goals" in values:
            preserve_baseline(connection, g.user_id, "activity")
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
            snapshot(connection, g.user_id, "activity", date.today())
        if "nutrition_goals" in values:
            preserve_baseline(connection, g.user_id, "nutrition")
            connection.execute("DELETE FROM nutrition_goals WHERE user_id=%s", (g.user_id,))
            with connection.cursor() as cursor:
                cursor.executemany("INSERT INTO nutrition_goals(user_id,nutrient,amount) VALUES(%s,%s,%s)", [(g.user_id, goal["nutrient"], goal["amount"]) for goal in nutrition])
            snapshot(connection, g.user_id, "nutrition", date.today())
        if "weight_goal" in values:
            if weight_goal is None:
                connection.execute("DELETE FROM weight_goals WHERE user_id=%s", (g.user_id,))
            else:
                connection.execute(
                    "INSERT INTO weight_goals(user_id,start_kg,target_kg,target_date) VALUES(%s,%s,%s,%s) "
                    "ON CONFLICT (user_id) DO UPDATE SET target_kg=EXCLUDED.target_kg,target_date=EXCLUDED.target_date",
                    (g.user_id, start, target, target_date),
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
    return {"network": {"id": "my-network", "member_count": 1, "criteria": []}}


@bp.post("/api/v1/goals/check")
@auth_required
def goal_check():
    values = body()
    activity_goals = values.get("activity_goals") or []
    planned = sum(
        int(goal.get("minutes_per_session", 0)) * int(goal.get("sessions_per_week", 0))
        for goal in activity_goals
        if isinstance(goal, dict)
    )
    checks = [{
        "status": "ok" if planned >= 150 else "warning",
        "text": (
            f"{planned} exercise minutes per week planned – meets the WHO recommendation of 150 min."
            if planned >= 150
            else f"{planned} exercise minutes per week planned – below the WHO recommendation of 150 min."
        ),
    }]
    weight_goal = values.get("weight_goal")
    if weight_goal and weight_goal.get("target_date") and weight_goal.get("target_kg") is not None:
        try:
            target_date = date.fromisoformat(weight_goal["target_date"])
            current = float(values.get("current_weight_kg"))
            weeks = max((target_date - date.today()).days / 7, 1 / 7)
            rate = abs(float(weight_goal["target_kg"]) - current) / weeks
            checks.append({
                "status": "ok" if rate <= 0.5 else "warning",
                "text": f"Weight change of {rate:.1f} kg per week is {'within' if rate <= 0.5 else 'above'} the recommended maximum of 0.5 kg.",
            })
        except (TypeError, ValueError):
            pass
    nutrition = {
        item.get("nutrient"): item.get("amount")
        for item in values.get("nutrition_goals", [])
        if isinstance(item, dict)
    }
    if "protein" in nutrition:
        try:
            weight = float(values.get("current_weight_kg"))
            protein_per_kg = float(nutrition["protein"]) / weight
            goals = values.get("goals") or []
            low = 1.6 if "gain_muscle" in goals else 0.8
            status = "ok" if low <= protein_per_kg <= 2.4 else "warning"
            checks.append({
                "status": status,
                "text": f"Protein target is {protein_per_kg:.1f} g/kg – {'within' if status == 'ok' else 'outside'} the recommended range.",
            })
        except (TypeError, ValueError, ZeroDivisionError):
            pass
    return {"checks": checks}
