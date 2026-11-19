"""Study settings, participant visibility, and administrator CSV tools."""

import csv
import io
from datetime import date, datetime
from functools import wraps

from flask import Blueprint, g

from .common import auth_required, body, conn, err, iso

bp = Blueprint("admin", __name__)


def admin_required(view):
    @wraps(view)
    @auth_required
    def wrapped(*args, **kwargs):
        if g.role != "admin":
            return err("Admin access only.", "forbidden", 403)
        return view(*args, **kwargs)

    return wrapped


def participants(connection):
    return connection.execute(
        "SELECT * FROM users WHERE role='user' ORDER BY participant_no,id"
    ).fetchall()


def participant_by_number(connection, number):
    return connection.execute(
        "SELECT * FROM users WHERE role='user' AND participant_no=%s", (number,)
    ).fetchone()


def participant_output(connection, user):
    sees = connection.execute(
        "SELECT u.participant_no FROM networks v JOIN users u ON u.id=v.target_id "
        "WHERE v.viewer_id=%s ORDER BY u.participant_no", (user["id"],)
    ).fetchall()
    seen_by = connection.execute(
        "SELECT u.participant_no FROM networks v JOIN users u ON u.id=v.viewer_id "
        "WHERE v.target_id=%s ORDER BY u.participant_no", (user["id"],)
    ).fetchall()
    weight = connection.execute(
        "SELECT weight_kg FROM body_weights WHERE user_id=%s "
        "ORDER BY measured_on DESC,created_at DESC LIMIT 1", (user["id"],)
    ).fetchone()
    goals = connection.execute(
        "SELECT goal FROM user_goals WHERE user_id=%s ORDER BY position", (user["id"],)
    ).fetchall()
    sports = connection.execute(
        "SELECT name FROM user_sports WHERE user_id=%s ORDER BY name", (user["id"],)
    ).fetchall()
    age = date.today().year - user["date_of_birth"].year
    if (date.today().month, date.today().day) < (
        user["date_of_birth"].month,
        user["date_of_birth"].day,
    ):
        age -= 1
    sees_list = [row["participant_no"] for row in sees]
    return {
        "id": str(user["id"]),
        "participant_no": user["participant_no"],
        "username": user["username"],
        "email": user["email"],
        "first_name": user["first_name"],
        "last_name": user["last_name"],
        "gender": user["gender"],
        "date_of_birth": iso(user["date_of_birth"]),
        "age": age,
        "height_cm": float(user["height_cm"]),
        "weight_kg": float(weight["weight_kg"]) if weight else None,
        "goals": [row["goal"] for row in goals],
        "sports": [row["name"] for row in sports],
        "onboarding_complete": user["onboarding_step"] == "done",
        "registered_at": iso(user["created_at"]),
        "sees": sees_list,
        "seen_by": [row["participant_no"] for row in seen_by],
        "community_enabled": bool(user["community_enabled"]),
        "community_active": bool(user["community_enabled"] and sees_list),
    }


def overview_data(connection):
    users = [participant_output(connection, user) for user in participants(connection)]
    return {
        "settings": dict(
            connection.execute(
                "SELECT experiment_paused,community_default FROM app_settings WHERE id=true"
            ).fetchone()
            or {"experiment_paused": False, "community_default": True}
        ),
        "connections": sum(len(user["sees"]) for user in users),
        "users": users,
    }


@bp.get("/api/v1/admin/overview")
@admin_required
def overview():
    with conn() as connection:
        return overview_data(connection)


@bp.put("/api/v1/admin/settings")
@admin_required
def save_settings():
    values = body()
    allowed = ("experiment_paused", "community_default")
    if any(key in values and not isinstance(values[key], bool) for key in allowed):
        return err("Settings must be boolean values.")
    with conn() as connection:
        current = connection.execute(
            "SELECT experiment_paused,community_default FROM app_settings WHERE id=true"
        ).fetchone()
        paused = values.get("experiment_paused", current["experiment_paused"])
        default = values.get("community_default", current["community_default"])
        connection.execute(
            "UPDATE app_settings SET experiment_paused=%s,community_default=%s WHERE id=true",
            (paused, default),
        )
        connection.commit()
        return {"settings": {"experiment_paused": paused, "community_default": default}}


@bp.put("/api/v1/admin/users/<user_id>/visibility")
@admin_required
def set_visibility(user_id):
    values = body()
    sees = values.get("sees")
    if not isinstance(sees, list) or not all(isinstance(value, int) and not isinstance(value, bool) for value in sees):
        return err("Send sees as a list of participant IDs.", field="sees")
    with conn() as connection:
        user = connection.execute(
            "SELECT id,participant_no FROM users WHERE id=%s AND role='user'", (user_id,)
        ).fetchone()
        if not user:
            return err("Participant not found.", "not_found", 404)
        if user["participant_no"] in sees:
            return err("A participant cannot see themselves.", field="sees")
        targets = connection.execute(
            "SELECT participant_no,id FROM users WHERE role='user' AND participant_no = ANY(%s)",
            (list(set(sees)),),
        ).fetchall()
        if len(targets) != len(set(sees)):
            return err("One or more participant IDs are unknown.", field="sees")
        connection.execute("DELETE FROM networks WHERE viewer_id=%s", (user["id"],))
        if targets:
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO networks(viewer_id,target_id) VALUES(%s,%s)",
                    [(user["id"], target["id"]) for target in targets],
                )
        connection.commit()
        return overview_data(connection)


@bp.put("/api/v1/admin/users/<user_id>/community")
@admin_required
def set_community(user_id):
    enabled = body().get("enabled")
    if not isinstance(enabled, bool):
        return err("Send enabled as true or false.", field="enabled")
    with conn() as connection:
        row = connection.execute(
            "UPDATE users SET community_enabled=%s WHERE id=%s AND role='user' RETURNING id",
            (enabled, user_id),
        ).fetchone()
        if not row:
            return err("Participant not found.", "not_found", 404)
        connection.commit()
    return {"user_id": str(row["id"]), "community_enabled": enabled}


@bp.post("/api/v1/admin/community")
@admin_required
def set_community_many():
    values = body()
    enabled = values.get("enabled")
    user_ids = values.get("user_ids")
    if not isinstance(enabled, bool):
        return err("Send enabled as true or false.", field="enabled")
    if user_ids is not None and (not isinstance(user_ids, list) or not all(isinstance(value, str) for value in user_ids)):
        return err("user_ids must be a list of participant IDs.", field="user_ids")
    with conn() as connection:
        if user_ids is None:
            result = connection.execute(
                "UPDATE users SET community_enabled=%s WHERE role='user'", (enabled,)
            )
        else:
            result = connection.execute(
                "UPDATE users SET community_enabled=%s WHERE role='user' AND id::text = ANY(%s)",
                (enabled, user_ids),
            )
        connection.commit()
        result_data = overview_data(connection)
    result_data["message"] = f"Community {'allowed' if enabled else 'switched off'} for {result.rowcount} participant(s)."
    return result_data


def csv_response(filename, rows, fieldnames):
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames, delimiter=";", lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return {"filename": filename, "csv": output.getvalue(), "rows": len(rows)}


@bp.get("/api/v1/admin/export/participants")
@admin_required
def export_participants():
    with conn() as connection:
        users = [participant_output(connection, user) for user in participants(connection)]
    rows = []
    for user in users:
        rows.append({
            "id": f"ID {user['participant_no']}",
            "username": user["username"],
            "first_name": user["first_name"],
            "last_name": user["last_name"],
            "email": user["email"],
            "gender": user["gender"],
            "date_of_birth": user["date_of_birth"],
            "height_cm": user["height_cm"],
            "weight_kg": user["weight_kg"] or "",
            "community": "yes" if user["community_enabled"] else "no",
            "sees": " | ".join(map(str, user["sees"])),
            "seen_by": " | ".join(map(str, user["seen_by"])),
        })
    return csv_response("activ-ate-participants.csv", rows, list(rows[0]) if rows else ["id"])


def parse_csv(text):
    if not isinstance(text, str) or not text.strip():
        return [], ["CSV content is required."]
    try:
        reader = csv.DictReader(io.StringIO(text), delimiter=";")
        return list(reader), []
    except csv.Error as error:
        return [], [f"Invalid CSV: {error}"]


def find_csv_user(connection, identifier):
    identifier = (identifier or "").strip()
    if identifier.lower().startswith("id "):
        identifier = identifier[3:].strip()
    if identifier.isdigit():
        return participant_by_number(connection, int(identifier))
    return connection.execute(
        "SELECT * FROM users WHERE role='user' AND username=%s", (identifier,)
    ).fetchone()


@bp.post("/api/v1/admin/import/participants")
@admin_required
def import_participants():
    values = body()
    rows, errors = parse_csv(values.get("csv"))
    dry_run = values.get("dry_run", True)
    if not isinstance(dry_run, bool):
        return err("dry_run must be boolean.", field="dry_run")
    changes = []
    with conn() as connection:
        for index, row in enumerate(rows, 2):
            user = find_csv_user(connection, row.get("id") or row.get("username"))
            if not user:
                errors.append(f"Row {index}: participant not found.")
                continue
            fields = {}
            for field in ("first_name", "last_name", "email", "gender"):
                if row.get(field, "").strip() and row[field].strip() != str(user[field]):
                    fields[field] = {"from": str(user[field]), "to": row[field].strip()}
            if row.get("date_of_birth", "").strip():
                try:
                    value = date.fromisoformat(row["date_of_birth"].strip())
                except ValueError:
                    try:
                        value = datetime.strptime(row["date_of_birth"].strip(), "%d.%m.%Y").date()
                    except ValueError:
                        errors.append(f"Row {index}: invalid date_of_birth.")
                        value = None
                if value and value != user["date_of_birth"]:
                    fields["date_of_birth"] = {"from": str(user["date_of_birth"]), "to": value.isoformat()}
            if row.get("height_cm", "").strip():
                try:
                    value = float(row["height_cm"])
                    if not 100 <= value <= 250:
                        raise ValueError
                except ValueError:
                    errors.append(f"Row {index}: height_cm must be between 100 and 250.")
                    value = None
                if value is not None and value != float(user["height_cm"]):
                    fields["height_cm"] = {"from": float(user["height_cm"]), "to": value}
            if row.get("weight_kg", "").strip():
                try:
                    value = float(row["weight_kg"])
                    if not 30 <= value <= 300:
                        raise ValueError
                except ValueError:
                    errors.append(f"Row {index}: weight_kg must be between 30 and 300.")
                    value = None
                if value is not None:
                    fields["weight_kg"] = {"from": None, "to": value}
            if row.get("community", "").strip():
                value = row["community"].strip().lower() in ("yes", "y", "true", "1", "on")
                if value != user["community_enabled"]:
                    fields["community"] = {"from": user["community_enabled"], "to": value}
            if fields:
                changes.append({"participant_no": user["participant_no"], "name": f"{user['first_name']} {user['last_name']}", "fields": fields, "_user_id": user["id"]})
        if errors:
            return err("CSV contains errors.", "validation_error", 422)
        if not dry_run:
            for change in changes:
                user_id = change.pop("_user_id")
                fields = {field: values["to"] for field, values in change["fields"].items()}
                updates = {key: value for key, value in fields.items() if key not in ("community", "weight_kg")}
                if updates:
                    assignments = ", ".join(f"{key}=%s" for key in updates)
                    connection.execute(
                        f"UPDATE users SET {assignments} WHERE id=%s",
                        (*updates.values(), user_id),
                    )
                if "community" in fields:
                    connection.execute("UPDATE users SET community_enabled=%s WHERE id=%s", (fields["community"], user_id))
                if "weight_kg" in fields:
                    connection.execute(
                        "INSERT INTO body_weights(user_id,weight_kg,measured_on) VALUES(%s,%s,CURRENT_DATE)",
                        (user_id, fields["weight_kg"]),
                    )
            connection.commit()
    return {"changes": changes, "unchanged": 0, "not_in_file": [], "errors": errors, "applied": not dry_run}


@bp.get("/api/v1/admin/export/network")
@admin_required
def export_network():
    with conn() as connection:
        rows = connection.execute(
            "SELECT v.participant_no viewer_id,t.participant_no sees_id,"
            "v.first_name||' '||v.last_name viewer_name,t.first_name||' '||t.last_name sees_name "
            "FROM networks x JOIN users v ON v.id=x.viewer_id JOIN users t ON t.id=x.target_id "
            "ORDER BY v.participant_no,t.participant_no"
        ).fetchall()
    return csv_response("activ-ate-network.csv", [dict(row) for row in rows], ["viewer_id", "sees_id", "viewer_name", "sees_name"])


def csv_number(value):
    text = (value or "").strip()
    if text.lower().startswith("id "):
        text = text[3:].strip()
    return int(text) if text.isdigit() else None


@bp.post("/api/v1/admin/import/network")
@admin_required
def import_network():
    values = body()
    text = values.get("csv")
    dry_run = values.get("dry_run", True)
    if not isinstance(dry_run, bool):
        return err("dry_run must be boolean.", field="dry_run")
    if not isinstance(text, str) or not text.strip():
        return err("CSV content is required.", "validation_error", 422)
    first_line = text.splitlines()[0] if text.splitlines() else ""
    delimiter = ";"
    if "," in first_line and ";" not in first_line:
        delimiter = ","
    elif "\t" in first_line and ";" not in first_line:
        delimiter = "\t"
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    pairs = set()
    errors = []
    with conn() as connection:
        known = {row["participant_no"]: row for row in participants(connection)}
        for index, row in enumerate(reader, 1):
            if not row or not any(cell.strip() for cell in row):
                continue
            header = row[0].strip().lower()
            if index == 1 and header in ("viewer_id", "viewer", "id", "viewer id"):
                continue
            if len(row) < 2:
                errors.append(f"Row {index}: expected viewer and seen IDs.")
                continue
            viewer, target = csv_number(row[0]), csv_number(row[1])
            if viewer not in known or target not in known:
                errors.append(f"Row {index}: unknown participant ID.")
            elif viewer == target:
                errors.append(f"Row {index}: a participant cannot see themselves.")
            else:
                pairs.add((viewer, target))
        current = {
            (row["viewer"], row["target"])
            for row in connection.execute(
                "SELECT v.participant_no viewer,t.participant_no target FROM networks x "
                "JOIN users v ON v.id=x.viewer_id JOIN users t ON t.id=x.target_id"
            )
        }
        added = sorted(pairs - current)
        removed = sorted(current - pairs)
        if errors:
            return {"pairs": len(pairs), "added": [], "removed": [], "unchanged": len(pairs & current), "mutual": 0, "sees_nobody": [], "warnings": [], "errors": errors, "applied": False}, 422
        if not dry_run:
            connection.execute("DELETE FROM networks")
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO networks(viewer_id,target_id) VALUES(%s,%s)",
                    [(known[viewer]["id"], known[target]["id"]) for viewer, target in pairs],
                )
            connection.commit()
        sees_nobody = sorted(set(known) - {viewer for viewer, _ in pairs})
        mutual = sum((target, viewer) in pairs for viewer, target in pairs) // 2
    return {
        "pairs": len(pairs),
        "added": [{"viewer": viewer, "target": target} for viewer, target in added],
        "removed": [{"viewer": viewer, "target": target} for viewer, target in removed],
        "unchanged": len(pairs & current),
        "mutual": mutual,
        "sees_nobody": sees_nobody,
        "warnings": [],
        "errors": [],
        "applied": not dry_run,
    }
