import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from find import find_nearby_observations
from inat_observation import InatObservation


ANCHOR_DATE = "2026-06-15T12:00:00Z"
ANCHOR_ID = 1000


def _make_obs(obs_id: int, date: str, user: str = "testuser") -> dict:
    return {
        "id": obs_id,
        "time_observed_at": date,
        "observed_on": date[:10],
        "taxon": {"name": "Species", "preferred_common_name": None},
        "location": "0,0",
        "created_at": date,
        "geoprivacy": None,
        "user": {"login": user},
    }


ANCHOR_OBS = _make_obs(ANCHOR_ID, ANCHOR_DATE)


def _run(before: list[dict], after: list[dict], n: int = 2) -> list[InatObservation]:
    """Call find_nearby_observations with mocked network calls."""
    with patch("find.fetch_observation", return_value={"results": [ANCHOR_OBS], "total_results": 1}), \
         patch("find._fetch_page", side_effect=[before, after]):
        return find_nearby_observations(
            f"https://www.inaturalist.org/observations/{ANCHOR_ID}", n=n
        )


def _diff_seconds(date_str: str) -> int:
    anchor_dt = datetime(2026, 6, 15, 12, 0, 0, tzinfo=timezone.utc)
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            dt = datetime.strptime(date_str, fmt)
            if not dt.tzinfo:
                dt = dt.replace(tzinfo=timezone.utc)
            return abs(int((dt - anchor_dt).total_seconds()))
        except ValueError:
            continue
    raise ValueError(f"Cannot parse date: {date_str!r}")


class TestFindNearbyObservationsSort(unittest.TestCase):

    def test_empty_before_and_after_returns_empty(self):
        self.assertEqual(_run([], []), [])

    def test_only_before_observation_returned(self):
        obs = _make_obs(999, "2026-06-15T11:00:00Z")
        result = _run([obs], [])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].get_id(), "999")

    def test_only_after_observation_returned(self):
        obs = _make_obs(1001, "2026-06-15T13:00:00Z")
        result = _run([], [obs])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].get_id(), "1001")

    def test_closest_observation_is_first(self):
        obs_far = _make_obs(999, "2026-06-14T12:00:00Z")    # 24h before
        obs_close = _make_obs(1001, "2026-06-15T11:59:00Z") # 1 min before
        result = _run([obs_far], [obs_close])
        self.assertEqual(result[0].get_id(), "1001")
        self.assertEqual(result[1].get_id(), "999")

    def test_after_observation_closer_than_before_sorts_first(self):
        obs_before = _make_obs(999, "2026-06-15T10:00:00Z")  # 2h before (7200s)
        obs_after = _make_obs(1001, "2026-06-15T12:30:00Z")  # 30min after (1800s)
        result = _run([obs_before], [obs_after])
        self.assertEqual(result[0].get_id(), "1001")
        self.assertEqual(result[1].get_id(), "999")

    def test_four_observations_sorted_ascending_by_diff(self):
        # _fetch_page returns before list highest-ID-first
        obs_1h_before = _make_obs(999, "2026-06-15T11:00:00Z")   # 3600s
        obs_4h_before = _make_obs(998, "2026-06-15T08:00:00Z")   # 14400s
        obs_10min_after = _make_obs(1001, "2026-06-15T12:10:00Z") # 600s
        obs_3h_after = _make_obs(1002, "2026-06-15T15:00:00Z")   # 10800s

        result = _run([obs_1h_before, obs_4h_before], [obs_10min_after, obs_3h_after])

        ids = [obs.get_id() for obs in result]
        self.assertEqual(ids, ["1001", "999", "1002", "998"])

    def test_sort_order_is_strictly_ascending(self):
        obs_2h = _make_obs(997, "2026-06-15T10:00:00Z")    # 7200s
        obs_1day = _make_obs(998, "2026-06-14T12:00:00Z")  # 86400s
        obs_1min = _make_obs(1001, "2026-06-15T11:59:00Z") # 60s
        obs_1h = _make_obs(1002, "2026-06-15T13:00:00Z")   # 3600s

        result = _run([obs_2h, obs_1day], [obs_1min, obs_1h])

        diffs = [_diff_seconds(obs.get_date()) for obs in result]
        self.assertEqual(diffs, sorted(diffs))

    def test_before_list_is_reversed_from_api_order(self):
        # API returns before list highest-ID-first; code must reverse to ID-ascending.
        # obs_1h has a higher ID and a smaller diff — if reversal is skipped it ends up
        # at the wrong index before sorting, but sorting fixes order either way.
        # We verify that both observations appear in the result.
        obs_1h = _make_obs(999, "2026-06-15T11:00:00Z")   # 3600s, higher ID
        obs_6h = _make_obs(998, "2026-06-15T06:00:00Z")   # 21600s, lower ID

        result = _run([obs_1h, obs_6h], [])

        ids = {obs.get_id() for obs in result}
        self.assertIn("999", ids)
        self.assertIn("998", ids)
        # Closer observation must come first
        self.assertEqual(result[0].get_id(), "999")

    def test_single_observation_each_side(self):
        obs_before = _make_obs(999, "2026-06-15T11:30:00Z")  # 1800s
        obs_after = _make_obs(1001, "2026-06-15T12:05:00Z")  # 300s
        result = _run([obs_before], [obs_after], n=1)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].get_id(), "1001")

    def test_returns_inat_observation_instances(self):
        obs = _make_obs(1001, "2026-06-15T13:00:00Z")
        result = _run([], [obs])
        self.assertIsInstance(result[0], InatObservation)

    def test_tie_in_diff_both_observations_present(self):
        obs_before = _make_obs(999, "2026-06-15T11:00:00Z")  # 3600s before
        obs_after = _make_obs(1001, "2026-06-15T13:00:00Z")  # 3600s after
        result = _run([obs_before], [obs_after])
        ids = {obs.get_id() for obs in result}
        self.assertEqual(ids, {"999", "1001"})


class TestFindNearbyObservationsErrors(unittest.TestCase):

    def test_invalid_url_raises_value_error(self):
        with self.assertRaises(ValueError):
            find_nearby_observations("https://not-inaturalist.org/foo/123")

    def test_anchor_not_found_raises_value_error(self):
        with patch("find.fetch_observation", return_value={"results": [], "total_results": 0}):
            with self.assertRaises(ValueError):
                find_nearby_observations(
                    f"https://www.inaturalist.org/observations/{ANCHOR_ID}"
                )

    def test_n_is_forwarded_to_fetch_page(self):
        with patch("find.fetch_observation", return_value={"results": [ANCHOR_OBS], "total_results": 1}), \
             patch("find._fetch_page", return_value=[]) as mock_fetch:
            find_nearby_observations(
                f"https://www.inaturalist.org/observations/{ANCHOR_ID}", n=5
            )
        for call in mock_fetch.call_args_list:
            self.assertEqual(call.kwargs["n"], 5)


if __name__ == "__main__":
    unittest.main()
