"""Application and database health check."""

import psycopg
from flask import Blueprint

from .common import conn, err

bp = Blueprint("system", __name__)


@bp.get("/api/v1/health")
def health():
    try:
        with conn() as connection:
            # Run a small query to confirm the database can answer requests.
            connection.execute("SELECT 1")
        return {"status": "ok", "database": "ok"}
    # Report HTTP 503 when the database cannot be reached or queried.
    except psycopg.Error:
        return err("Database unavailable.", "server_error", 503)
