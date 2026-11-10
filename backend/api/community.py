"""Community leaderboards, member comparisons, and weekly cheers."""

from datetime import date, timedelta

from flask import Blueprint, g, request

from .common import auth_required, body, conn, err, iso, week_start, weekly_target

bp = Blueprint("community", __name__)


def _habit():
    habit = (body().get("habit", "exercise") if request.method == "POST"
             else request.args.get("habit", "exercise"))
    if habit not in ("exercise", "water"):
        return None
    return habit


def _water_target(connection, user_id):
    row = connection.execute(
        "SELECT amount FROM nutrition_goals WHERE user_id=%s AND nutrient='water'",
        (user_id,),
    ).fetchone()
    return float(row["amount"]) if row else 2.0


def _water(connection, user_id, start, end):
    row = connection.execute(
        "SELECT COALESCE(SUM(water_l), 0) total FROM daily_logs "
        "WHERE user_id=%s AND log_date BETWEEN %s AND %s",
        (user_id, start, end),
    ).fetchone()
    return float(row["total"])


def _water_active(connection, user_id, day):
    return bool(connection.execute(
        "SELECT 1 FROM daily_logs WHERE user_id=%s AND log_date=%s AND water_l IS NOT NULL",
        (user_id, day),
    ).fetchone())


def _water_streak(connection, user_id, target):
    current = date.today()
    if not _water_active(connection, user_id, current):
        current -= timedelta(days=1)
    streak = 0
    while connection.execute(
        "SELECT 1 FROM daily_logs WHERE user_id=%s AND log_date=%s AND water_l >= %s",
        (user_id, current, target),
    ).fetchone():
        streak += 1
        current -= timedelta(days=1)
    return streak


def _minutes(connection, user_id, start, end):
    # Planned workouts do not contribute to community exercise minutes.
    row = connection.execute(
        "SELECT COALESCE(SUM(duration_min), 0) minutes FROM workouts "
        "WHERE user_id=%s AND status='done' AND performed_on BETWEEN %s AND %s",
        (user_id, start, end),
    ).fetchone()
    return int(row["minutes"])


def _active_today(connection, user_id):
    return bool(
        connection.execute(
            "SELECT 1 FROM workouts WHERE user_id=%s AND status='done' "
            "AND performed_on=%s LIMIT 1",
            (user_id, date.today()),
        ).fetchone()
    )


def _streak(connection, user_id):
    # Start from yesterday if no workout is completed today, then walk backwards.
    current = (
        date.today()
        if _active_today(connection, user_id)
        else date.today() - timedelta(days=1)
    )
    streak = 0
    while connection.execute(
        "SELECT 1 FROM workouts WHERE user_id=%s AND status='done' "
        "AND performed_on=%s LIMIT 1",
        (user_id, current),
    ).fetchone():
        streak += 1
        current -= timedelta(days=1)
    return streak


def _cheer_status(connection, from_user, to_user, week_start, habit):
    # Check this viewer's cheer separately from the total cheers the member received.
    row = connection.execute(
        "SELECT 1 FROM cheers WHERE from_user=%s AND to_user=%s "
        "AND habit=%s AND week_start=%s",
        (from_user, to_user, habit, week_start),
    ).fetchone()
    count = connection.execute(
        "SELECT COUNT(*) count FROM cheers WHERE to_user=%s "
        "AND habit=%s AND week_start=%s",
        (to_user, habit, week_start),
    ).fetchone()["count"]
    return bool(row), int(count)


def _member_stats(connection, user, start, end, elapsed, current_user_id, habit):
    user_id = user["id"]
    measure = _minutes if habit == "exercise" else _water
    value = measure(connection, user_id, start, end)
    if habit == "exercise":
        target = weekly_target(connection, user_id)
        daily_target = round(target / 7)
    else:
        daily_target = _water_target(connection, user_id)
        target = round(daily_target * elapsed, 2)
    # Compare the same number of days in each week.
    previous_start = start - timedelta(days=7)
    previous_end = previous_start + timedelta(days=elapsed - 1)
    previous = measure(connection, user_id, previous_start, previous_end)
    cheered, cheer_count = _cheer_status(connection, current_user_id, user_id, start, habit)
    # Database IDs may be UUID objects, while the token supplies the ID as text.
    is_me = str(user_id) == str(current_user_id)
    return {
        "member_id": "me" if is_me else str(user_id),
        "display_name": (
            "You" if is_me else user["username"]
        ),
        "initials": user["username"][:2].upper(),
        "is_me": is_me,
        "value": value,
        "target": target,
        "daily_target": daily_target,
        "streak": _streak(connection, user_id) if habit == "exercise" else _water_streak(connection, user_id, daily_target),
        "change_pct": round((value - previous) * 100 / previous) if previous else 0,
        "active_today": _active_today(connection, user_id) if habit == "exercise" else _water_active(connection, user_id, date.today()),
        "goal_reached": value >= target,
        "cheered_by_me": False if is_me else cheered,
        "cheer_count": cheer_count,
    }


def _leaderboard(connection, current_user_id, habit="exercise"):
    start = week_start()
    today = date.today()
    elapsed = (today - start).days + 1
    users = connection.execute(
        "SELECT id,username FROM users ORDER BY username,id"
    ).fetchall()
    rows = [
        _member_stats(connection, user, start, today, elapsed, current_user_id, habit)
        for user in users
    ]
    # Rank by total first; use display name to break ties.
    rows.sort(key=lambda row: (-row["value"], row["display_name"]))
    me = next(row for row in rows if row["is_me"])
    # Add each rank, the difference from the viewer, and whether a cheer is allowed.
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank
        row["vs_me"] = None if row["is_me"] else round(row["value"] - me["value"], 2)
        row["can_cheer"] = (
            not row["is_me"] and row["goal_reached"] and not row["cheered_by_me"]
        )
    return start, rows


@bp.get("/api/v1/community/network")
@auth_required
def network():
    habit = _habit()
    if not habit:
        return err("Habit must be exercise or water.", "unsupported_habit", 422, "habit")
    with conn() as connection:
        # Every registered user belongs to the same community.
        member_count = connection.execute(
            "SELECT COUNT(*) count FROM users"
        ).fetchone()["count"]
    return {
        "id": "all-users",
        "member_count": int(member_count),
        "criteria": [{"label": "Habit", "value": "Exercise minutes and water"}],
        "explanation": "All registered users share exercise minutes and water intake in one community.",
        "shared_data": ["Exercise minutes", "Workout type and duration", "Water intake"],
    }


@bp.get("/api/v1/community/leaderboard")
@auth_required
def leaderboard():
    habit = _habit()
    if not habit:
        return err("Habit must be exercise or water.", "unsupported_habit", 422, "habit")
    with conn() as connection:
        _, rows = _leaderboard(connection, g.user_id, habit)
    first = rows[0]
    # Break ties for the longest streak using this week's total.
    top_streak = max(rows, key=lambda row: (row["streak"], row["value"]))
    me = next(row for row in rows if row["is_me"])
    return {
        "habit": habit,
        "unit": "min" if habit == "exercise" else "L",
        "period": "week",
        "target_label": "Weekly target" if habit == "exercise" else "Daily target",
        "rows": rows,
        "summary": {
            "my_rank": me["rank"],
            "member_count": len(rows),
            "top_streak": {
                "days": top_streak["streak"],
                "display_name": top_streak["display_name"],
            },
            "gap_to_first": max(0, round(first["value"] - me["value"], 2)),
            "gap_unit": "min" if habit == "exercise" else "L",
        },
    }


@bp.get("/api/v1/community/members/<member_id>")
@auth_required
def member(member_id):
    habit = _habit()
    if not habit:
        return err("Habit must be exercise or water.", "unsupported_habit", 422, "habit")
    period = request.args.get("period", "week")
    if period not in ("week", "month", "all"):
        return err(
            "Period must be week, month, or all.", "validation_error", 422, "period"
        )
    with conn() as connection:
        row = connection.execute(
            "SELECT id,username,created_at FROM users WHERE id=%s",
            (member_id,),
        ).fetchone()
        if not row:
            return err("Member not found.", "not_found", 404)
        start, rows = _leaderboard(connection, g.user_id, habit)
        stats = next(
            (item for item in rows if item["member_id"] == str(member_id)), None
        )
        if not stats:
            return err("Member not found.", "not_found", 404)
        # "month" means the last 30 days; "all" includes every date through today.
        if period == "week":
            range_start = start
        elif period == "month":
            range_start = date.today() - timedelta(days=29)
        else:
            range_start = date.min
        measure = _minutes if habit == "exercise" else _water
        total_member = measure(connection, member_id, range_start, date.today())
        total_me = measure(connection, g.user_id, range_start, date.today())
        # Show up to eight recent entries in the selected comparison period.
        if habit == "exercise":
            logs = connection.execute(
                "SELECT performed_on,sport_name,duration_min FROM workouts "
                "WHERE user_id=%s AND status='done' AND performed_on BETWEEN %s AND %s "
                "ORDER BY performed_on DESC, created_at DESC LIMIT 8",
                (member_id, range_start, date.today()),
            ).fetchall()
        else:
            logs = connection.execute(
                "SELECT log_date,water_l FROM daily_logs WHERE user_id=%s "
                "AND log_date BETWEEN %s AND %s AND water_l IS NOT NULL "
                "ORDER BY log_date DESC LIMIT 8",
                (member_id, range_start, date.today()),
            ).fetchall()
        sports = connection.execute(
            "SELECT name FROM user_sports WHERE user_id=%s ORDER BY name",
            (member_id,),
        ).fetchall()
        mine = next(item for item in rows if item["is_me"])
    return {
        "member": {
            "id": str(row["id"]),
            "display_name": row["username"],
            "initials": row["username"][:2].upper(),
            "joined": iso(row["created_at"].date()),
            "sports": [sport["name"] for sport in sports],
            "rank": stats["rank"],
            "streak": stats["streak"],
        },
        "habit": habit,
        "period": period,
        "unit": "min" if habit == "exercise" else "L",
        "targets": {
            "member": f"{stats['target']} min / week" if habit == "exercise" else f"{stats['daily_target']} L / day",
            "me": f"{mine['target']} min / week" if habit == "exercise" else f"{mine['daily_target']} L / day",
        },
        "totals": {"member": total_member, "me": total_me},
        "log": [
            ({"date": iso(log["performed_on"]), "label": log["sport_name"],
              "value": int(log["duration_min"]), "unit": "min", "met": None}
             if habit == "exercise" else
             {"date": iso(log["log_date"]), "label": None,
              "value": float(log["water_l"]), "unit": "L",
              "met": float(log["water_l"]) >= stats["daily_target"]})
            for log in logs
        ],
        "goal_reached": stats["goal_reached"],
        "cheered_by_me": stats["cheered_by_me"],
        "cheer_count": stats["cheer_count"],
        "can_cheer": stats["can_cheer"],
    }


@bp.post("/api/v1/community/members/<member_id>/cheers")
@auth_required
def cheer(member_id):
    habit = _habit()
    if not habit:
        return err("Habit must be exercise or water.", "unsupported_habit", 422, "habit")
    with conn() as connection:
        _, rows = _leaderboard(connection, g.user_id, habit)
        row = next((item for item in rows if item["member_id"] == str(member_id)), None)
        if not row or row["is_me"]:
            return err("This member is not in your network.", "not_found", 404)
        # Cheers require a reached weekly goal and can be sent only once per member per week.
        if not row["goal_reached"]:
            return err(
                "You can cheer once this member has reached their goal.",
                "goal_not_reached",
                409,
            )
        if row["cheered_by_me"]:
            return err(
                "You already cheered for this goal this week.", "already_cheered", 409
            )
        connection.execute(
            "INSERT INTO cheers(from_user,to_user,habit,week_start) VALUES(%s,%s,%s,%s)",
            (g.user_id, member_id, habit, week_start()),
        )
        connection.commit()
        _, count = _cheer_status(connection, g.user_id, member_id, week_start(), habit)
    return {"cheered": True, "cheer_count": count}, 201


@bp.get("/api/v1/community/insights")
@auth_required
def insights():
    habit = _habit()
    if not habit:
        return err("Habit must be exercise or water.", "unsupported_habit", 422, "habit")
    with conn() as connection:
        _, rows = _leaderboard(connection, g.user_id, habit)
    me = next(row for row in rows if row["is_me"])
    first = rows[0]
    items = []
    # Start with a ranking message, then suggest members who can receive a cheer.
    if first["is_me"]:
        items.append(
            {
                "text": "You lead your network this week – keep the rhythm!",
                "action": None,
            }
        )
    else:
        items.append(
            {
                "text": f"{first['display_name']} is ahead by {round(first['value'] - me['value'], 2)} {'min' if habit == 'exercise' else 'L'} this week.",
                "action": None,
            }
        )
    for row in rows:
        if row["can_cheer"]:
            items.append(
                {
                    "text": f"{row['display_name']} reached the {'exercise minutes' if habit == 'exercise' else 'water'} goal. Send a cheer to keep the motivation up.",
                    "action": "cheer",
                    "member_id": row["member_id"],
                }
            )
    return {"habit": habit, "items": items[:5]}


@bp.get("/api/v1/feed")
@auth_required
def feed():
    habit = _habit()
    if not habit:
        return err("Habit must be exercise or water.", "unsupported_habit", 422, "habit")
    try:
        limit = min(max(int(request.args.get("limit", 10)), 1), 30)
    except (TypeError, ValueError):
        return err("Limit must be a number.", "validation_error", 422, "limit")
    with conn() as connection:
        boards = {h: _leaderboard(connection, g.user_id, h)[1] for h in ("exercise", "water")}
    items = [
        {
            "id": f"{row['member_id']}-{h}",
            "member_id": row["member_id"],
            "display_name": row["display_name"],
            "initials": row["initials"],
            "habit": h,
            "text": "reached the weekly exercise goal" if h == "exercise" else "reached the water target so far this week",
            "cheered_by_me": row["cheered_by_me"],
            "cheer_count": row["cheer_count"],
            "can_cheer": row["can_cheer"],
        }
        for h, rows in boards.items() for row in rows
        if not row["is_me"] and row["goal_reached"]
    ]
    return {"items": items[:limit]}
