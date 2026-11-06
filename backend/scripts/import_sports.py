"""Import frontend/assets/data/sports.json into PostgreSQL.

Run from the repository root after applying schema.sql:
    python backend/scripts/import_sports.py
"""

import json
import sys
from pathlib import Path

import psycopg

# Make backend/config.py importable when this script is run directly.
sys.path.insert(0, str(Path(__file__).parents[1]))
from config import DATABASE_URL

# Read the same sports catalogue that the frontend uses.
source = Path(__file__).parents[2] / "frontend/assets/data/sports.json"
with source.open(encoding="utf-8") as handle:
    items = json.load(handle)["items"]

# The connection commits on success and rolls back if any import fails.
with psycopg.connect(DATABASE_URL) as connection:
    for item in items:
        # Insert new sports or update existing IDs, so the import can be run again.
        connection.execute(
            """INSERT INTO sports(id,name,category,met,aliases)
               VALUES(%s,%s,%s,%s,%s)
               ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,
                 category=EXCLUDED.category, met=EXCLUDED.met,
                 aliases=EXCLUDED.aliases""",
            (
                item["id"],
                item["name"],
                item.get("category"),
                item.get("met", 6),
                item.get("aliases", []),
            ),
        )
print(f"Imported {len(items)} sports.")
