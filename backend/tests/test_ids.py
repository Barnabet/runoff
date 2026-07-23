import re

from runoff_api.core.ids import new_id


def test_new_id_format():
    got = new_id("bp")
    assert re.fullmatch(r"bp_[0-9a-f]{12}", got)
    assert new_id("bp") != new_id("bp")
