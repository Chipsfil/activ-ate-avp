"""Exercise leaderboard, member comparisons, and weekly cheers."""

from datetime import date, timedelta

from flask import Blueprint, g, request

from .common import auth_required, body, conn, err, iso, week_start, weekly_target

bp = Blueprint("community", __name__)


def _exercise_only():
    # GET requests use the URL query; POST requests use the JSON body.
    habit = request.args.get("habit")
    if request.method == "POST":
        habit = body().get("habit", "exercise")
    if habit not in (None, "", "exercise"):
        return err(
            "Only exercise minutes are available in the community.",
            "unsupported_habit",
            422,
            "habit",
        )
    return None


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


def _cheer_status(connection, from_user, to_user, week_start):
    # Check this viewer's cheer separately from the total cheers the member received.
    row = connection.execute(
        "SELECT 1 FROM cheers WHERE from_user=%s AND to_user=%s "
        "AND habit='exercise' AND week_start=%s",
        (from_user, to_user, week_start),
    ).fetchone()
    count = connection.execute(
        "SELECT COUNT(*) count FROM cheers WHERE to_user=%s "
        "AND habit='exercise' AND week_start=%s",
        (to_user, week_start),
    ).fetchone()["count"]
    return bool(row), int(count)


def _member_stats(connection, user, start, end, elapsed, current_user_id):
    user_id = user["id"]
    value = _minutes(connection, user_id, start, end)
    target = weekly_target(connection, user_id)
    # Compare the same number of days in each week.
    previous_start = start - timedelta(days=7)
    previous_end = previous_start + timedelta(days=elapsed - 1)
    previous = _minutes(connection, user_id, previous_start, previous_end)
    cheered, cheer_count = _cheer_status(connection, current_user_id, user_id, start)
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
        "daily_target": round(target / 7),
        "streak": _streak(connection, user_id),
        "change_pct": round((value - previous) * 100 / previous) if previous else 0,
        "active_today": _active_today(connection, user_id),
        "goal_reached": value >= target,
        "cheered_by_me": False if is_me else cheered,
        "cheer_count": cheer_count,
    }


def _leaderboard(connection, current_user_id):
    start = week_start()
    today = date.today()
    elapsed = (today - start).days + 1
    users = connection.execute(
        "SELECT id,username FROM users ORDER BY username,id"
    ).fetchall()
    rows = [
        _member_stats(connection, user, start, today, elapsed, current_user_id)
        for user in users
    ]
    # Rank by most minutes first; use display name to break ties.
    rows.sort(key=lambda row: (-row["value"], row["display_name"]))
    me = next(row for row in rows if row["is_me"])
    # Add each rank, the difference from the viewer, and whether a cheer is allowed.
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank
        row["vs_me"] = None if row["is_me"] else row["value"] - me["value"]
        row["can_cheer"] = (
            not row["is_me"] and row["goal_reached"] and not row["cheered_by_me"]
        )
    return start, rows


@bp.get("/api/v1/community/network")
@auth_required
def network():
    failure = _exercise_only()
    if failure:
        return failure
    with conn() as connection:
        # Every registered user belongs to the same community.
        member_count = connection.execute(
            "SELECT COUNT(*) count FROM users"
        ).fetchone()["count"]
    return {
        "id": "all-users",
        "member_count": int(member_count),
        "criteria": [{"label": "Habit", "value": "Exercise minutes"}],
        "explanation": "All registered users share exercise minutes in one community.",
        "shared_data": ["Exercise minutes", "Workout type and duration"],
    }


@bp.get("/api/v1/community/leaderboard")
@auth_required
def leaderboard():
    failure = _exercise_only()
    if failure:
        return failure
    with conn() as connection:
        _, rows = _leaderboard(connection, g.user_id)
    first = rows[0]
    # Break ties for the longest streak using this week's exercise minutes.
    top_streak = max(rows, key=lambda row: (row["streak"], row["value"]))
    me = next(row for row in rows if row["is_me"])
    return {
        "habit": "exercise",
        "unit": "min",
        "period": "week",
        "target_label": "Weekly target",
        "rows": rows,
        "summary": {
            "my_rank": me["rank"],
            "member_count": len(rows),
            "top_streak": {
                "days": top_streak["streak"],
                "display_name": top_streak["display_name"],
            },
            "gap_to_first": max(0, first["value"] - me["value"]),
            "gap_unit": "min",
        },
    }


@bp.get("/api/v1/community/members/<member_id>")
@auth_required
def member(member_id):
    failure = _exercise_only()
    if failure:
        return failure
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
        start, rows = _leaderboard(connection, g.user_id)
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
        total_member = _minutes(connection, member_id, range_start, date.today())
        me_id = g.user_id
        total_me = _minutes(connection, me_id, range_start, date.today())
        # Show up to eight recent completed workouts in the selected comparison period.
        logs = connection.execute(
            "SELECT performed_on,sport_name,duration_min FROM workouts "
            "WHERE user_id=%s AND status='done' AND performed_on BETWEEN %s AND %s "
            "ORDER BY performed_on DESC, created_at DESC LIMIT 8",
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
        "habit": "exercise",
        "period": period,
        "unit": "min",
        "targets": {
            "member": f"{stats['target']} min / week",
            "me": f"{mine['target']} min / week",
        },
        "totals": {"member": total_member, "me": total_me},
        "log": [
            {
                "date": iso(log["performed_on"]),
                "label": log["sport_name"],
                "value": int(log["duration_min"]),
                "unit": "min",
                "met": None,
            }
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
    failure = _exercise_only()
    if failure:
        return failure
    with conn() as connection:
        _, rows = _leaderboard(connection, g.user_id)
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
            "INSERT INTO cheers(from_user,to_user,habit,week_start) VALUES(%s,%s,'exercise',%s)",
            (g.user_id, member_id, week_start()),
        )
        connection.commit()
        _, count = _cheer_status(connection, g.user_id, member_id, week_start())
    return {"cheered": True, "cheer_count": count}, 201


@bp.get("/api/v1/community/insights")
@auth_required
def insights():
    failure = _exercise_only()
    if failure:
        return failure
    with conn() as connection:
        _, rows = _leaderboard(connection, g.user_id)
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
                "text": f"{first['display_name']} is ahead by {first['value'] - me['value']} min this week. One more session brings you closer to first place.",
                "action": None,
            }
        )
    for row in rows:
        if row["can_cheer"]:
            items.append(
                {
                    "text": f"{row['display_name']} reached the exercise minutes goal. Send a cheer to keep the motivation up.",
                    "action": "cheer",
                    "member_id": row["member_id"],
                }
            )
    return {"habit": "exercise", "items": items[:5]}


@bp.get("/api/v1/feed")
@auth_required
def feed():
    failure = _exercise_only()
    if failure:
        return failure
    try:
        limit = min(max(int(request.args.get("limit", 10)), 1), 30)
    except (TypeError, ValueError):
        return err("Limit must be a number.", "validation_error", 422, "limit")
    with conn() as connection:
        _, rows = _leaderboard(connection, g.user_id)
    # The feed shows other members who reached their weekly exercise goal.
    items = [
        {
            "id": f"{row['member_id']}-exercise",
            "member_id": row["member_id"],
            "display_name": row["display_name"],
            "initials": row["initials"],
            "habit": "exercise",
            "text": "reached the weekly exercise goal",
            "cheered_by_me": row["cheered_by_me"],
            "cheer_count": row["cheer_count"],
            "can_cheer": row["can_cheer"],
        }
        for row in rows
        if not row["is_me"] and row["goal_reached"]
    ]
    return {"items": items[:limit]}
