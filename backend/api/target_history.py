"""Dated snapshots of the targets shown on daily and weekly views."""

from datetime import date


def snapshot(connection, user_id, kind, effective_on, baseline=False):
    if kind == "activity":
        query = ("SELECT COALESCE(jsonb_agg(jsonb_build_object("
                 "'sport_id',sport_id,'sport_name',sport_name,"
                 "'minutes_per_session',minutes_per_session,'sessions_per_week',sessions_per_week) "
                 "ORDER BY sport_name), '[]'::jsonb) goals FROM activity_goals WHERE user_id=%s")
    else:
        query = ("SELECT COALESCE(jsonb_agg(jsonb_build_object("
                 "'nutrient',nutrient,'amount',amount) ORDER BY nutrient), '[]'::jsonb) "
                 "goals FROM nutrition_goals WHERE user_id=%s")
    goals = connection.execute(query, (user_id,)).fetchone()["goals"]
    from psycopg.types.json import Jsonb
    conflict = "DO NOTHING" if baseline else "DO UPDATE SET goals=EXCLUDED.goals"
    connection.execute(
        "INSERT INTO target_history(user_id,kind,effective_on,goals) VALUES(%s,%s,%s,%s) "
        "ON CONFLICT (user_id,kind,effective_on) " + conflict,
        (user_id, kind, effective_on, Jsonb(goals)),
    )


def preserve_baseline(connection, user_id, kind):
    # Serialize target updates for this user and preserve their pre-migration state.
    connection.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (user_id,))
    exists = connection.execute(
        "SELECT 1 FROM target_history WHERE user_id=%s AND kind=%s LIMIT 1", (user_id, kind)
    ).fetchone()
    if not exists:
        snapshot(connection, user_id, kind, date.min, baseline=True)


def goals_on(connection, user_id, kind, day):
    row = connection.execute(
        "SELECT goals FROM target_history WHERE user_id=%s AND kind=%s AND effective_on<=%s "
        "ORDER BY effective_on DESC LIMIT 1", (user_id, kind, day)
    ).fetchone()
    if row:
        return row["goals"]
    # Existing installations may not have been updated since the migration.
    table = "activity_goals" if kind == "activity" else "nutrition_goals"
    columns = ("sport_id,sport_name,minutes_per_session,sessions_per_week" if kind == "activity"
               else "nutrient,amount")
    return connection.execute(f"SELECT {columns} FROM {table} WHERE user_id=%s", (user_id,)).fetchall()
