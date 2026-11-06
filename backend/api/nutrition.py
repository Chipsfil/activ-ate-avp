"""Nutrition endpoints currently return the same authenticated placeholder."""

from flask import Blueprint

from .common import auth_required

bp = Blueprint("nutrition", __name__)


# These routes share one response because nutrition is not implemented yet.
# The optional meal_id is supplied only by the DELETE route.
@bp.get("/api/v1/nutrition/summary", endpoint="nutrition_summary")
@bp.route("/api/v1/meals", methods=["GET", "POST"], endpoint="meals")
@bp.post("/api/v1/meals/estimate", endpoint="estimate")
@bp.delete("/api/v1/meals/<meal_id>", endpoint="delete_meal")
@auth_required
def not_implemented(meal_id=None):
    # Authentication still runs before returning HTTP 501 (not implemented).
    return {"message": "Nutrition is not implemented in the backend"}, 501
