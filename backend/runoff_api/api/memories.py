from fastapi import APIRouter

# Blueprint-scoped memory reads live in api/blueprints.py; this router carries the
# memory write routes, added in Task 7.
router = APIRouter()
