import io
import json
import sys
import unittest
from typing import Optional
from unittest.mock import MagicMock, patch
import urllib.error

from inat_observation import fetch_observation, parse_observation_id, main, InatObservation


def make_response(obs: dict) -> dict:
    return {"results": [obs], "total_results": 1}


FULL_OBS = {
    "taxon": {
        "name": "Hentzia palmarum",
        "preferred_common_name": "Common Hentz Jumping Spider",
    },
    "location": "30.2702033333,-97.8080583333",
    "time_observed_at": "2026-06-26T08:24:13-05:00",
    "observed_on": "2026-06-26",
    "created_at": "2026-06-26T13:24:13+00:00",
    "geoprivacy": None,
    "user": {"login": "testuser"},
}


class TestParseObservationId(unittest.TestCase):
    def test_standard_url(self):
        self.assertEqual(
            parse_observation_id("https://www.inaturalist.org/observations/376305464"),
            "376305464",
        )

    def test_no_www(self):
        self.assertEqual(
            parse_observation_id("https://inaturalist.org/observations/123"),
            "123",
        )

    def test_trailing_slash(self):
        self.assertEqual(
            parse_observation_id("https://www.inaturalist.org/observations/99/"),
            "99",
        )

    def test_invalid_domain(self):
        with self.assertRaises(ValueError):
            parse_observation_id("https://www.example.com/observations/123")

    def test_non_url_string(self):
        with self.assertRaises(ValueError):
            parse_observation_id("not a url at all")

    def test_empty_string(self):
        with self.assertRaises(ValueError):
            parse_observation_id("")


class TestFetchObservation(unittest.TestCase):
    def _mock_urlopen(self, payload: dict):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(payload).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    @patch("urllib.request.urlopen")
    def test_returns_parsed_json(self, mock_urlopen):
        payload = make_response(FULL_OBS)
        mock_urlopen.return_value = self._mock_urlopen(payload)
        result = fetch_observation("376305464")
        self.assertEqual(result, payload)

    @patch("urllib.request.urlopen")
    def test_http_error_raises_value_error(self, mock_urlopen):
        mock_urlopen.side_effect = urllib.error.HTTPError(
            url=None, code=404, msg="Not Found", hdrs=None, fp=None
        )
        with self.assertRaises(ValueError) as ctx:
            fetch_observation("0")
        self.assertIn("404", str(ctx.exception))

    @patch("urllib.request.urlopen")
    def test_network_error_raises_value_error(self, mock_urlopen):
        mock_urlopen.side_effect = urllib.error.URLError("connection refused")
        with self.assertRaises(ValueError) as ctx:
            fetch_observation("123")
        self.assertIn("Network error", str(ctx.exception))


class TestInatObservation(unittest.TestCase):
    def test_get_species_with_common_name(self):
        obs = InatObservation(FULL_OBS)
        self.assertEqual(obs.get_species(), "Common Hentz Jumping Spider (Hentzia palmarum)")

    def test_get_species_without_common_name(self):
        obs = InatObservation({**FULL_OBS, "taxon": {"name": "Hentzia palmarum", "preferred_common_name": None}})
        self.assertEqual(obs.get_species(), "Hentzia palmarum")

    def test_get_species_no_taxon(self):
        obs = InatObservation({**FULL_OBS, "taxon": None})
        self.assertEqual(obs.get_species(), "Unknown")

    def test_get_coords_with_location(self):
        obs = InatObservation(FULL_OBS)
        self.assertEqual(obs.get_coords(), "30.2702033333, -97.8080583333")

    def test_get_coords_no_location(self):
        obs = InatObservation({**FULL_OBS, "location": None})
        self.assertEqual(obs.get_coords(), "obscured or not provided")

    def test_get_date_prefers_time_observed_at(self):
        obs = InatObservation(FULL_OBS)
        self.assertEqual(obs.get_date(), "2026-06-26T08:24:13-05:00")

    def test_get_date_falls_back_to_observed_on(self):
        obs = InatObservation({**FULL_OBS, "time_observed_at": None})
        self.assertEqual(obs.get_date(), "2026-06-26")

    def test_get_date_fully_obscured(self):
        obs = InatObservation({**FULL_OBS, "time_observed_at": None, "observed_on": None})
        self.assertEqual(obs.get_date(), "date obscured")

    def test_get_created(self):
        obs = InatObservation(FULL_OBS)
        self.assertEqual(obs.get_created(), "2026-06-26T13:24:13+00:00")

    def test_get_created_unknown(self):
        obs = InatObservation({**FULL_OBS, "created_at": None})
        self.assertEqual(obs.get_created(), "unknown")

    def test_get_geoprivacy_open(self):
        obs = InatObservation(FULL_OBS)
        self.assertEqual(obs.get_geoprivacy(), "open")

    def test_get_geoprivacy_obscured(self):
        obs = InatObservation({**FULL_OBS, "geoprivacy": "obscured"})
        self.assertEqual(obs.get_geoprivacy(), "obscured")

    def test_get_user(self):
        obs = InatObservation(FULL_OBS)
        self.assertEqual(obs.get_user(), "testuser")

    def test_get_user_missing(self):
        obs = InatObservation({**FULL_OBS, "user": None})
        self.assertEqual(obs.get_user(), "unknown")


class TestMain(unittest.TestCase):
    def _run_main(self, url: str, api_payload: Optional[dict] = None) -> tuple:
        """Run main() with the given URL, mocking the API. Returns (stdout, stderr, exit_code)."""
        with patch("sys.argv", ["inat_observation.py", url]), \
             patch("sys.stdout", new_callable=io.StringIO) as mock_out, \
             patch("sys.stderr", new_callable=io.StringIO) as mock_err:
            if api_payload is not None:
                mock_resp = MagicMock()
                mock_resp.read.return_value = json.dumps(api_payload).encode()
                mock_resp.__enter__ = lambda s: s
                mock_resp.__exit__ = MagicMock(return_value=False)
                with patch("urllib.request.urlopen", return_value=mock_resp):
                    try:
                        main()
                        code = 0
                    except SystemExit as e:
                        code = e.code
            else:
                try:
                    main()
                    code = 0
                except SystemExit as e:
                    code = e.code
            return mock_out.getvalue(), mock_err.getvalue(), code

    def test_full_observation_output(self):
        stdout, _, code = self._run_main(
            "https://www.inaturalist.org/observations/376305464",
            make_response(FULL_OBS),
        )
        self.assertEqual(code, 0)
        self.assertIn("Common Hentz Jumping Spider (Hentzia palmarum)", stdout)
        self.assertIn("30.2702033333", stdout)
        self.assertIn("2026-06-26T08:24:13-05:00", stdout)
        self.assertIn("open", stdout)
        self.assertIn("testuser", stdout)
        self.assertIn("2026-06-26T13:24:13+00:00", stdout)

    def test_geoprivacy_obscured(self):
        obs = {**FULL_OBS, "geoprivacy": "obscured", "location": None}
        stdout, _, code = self._run_main(
            "https://www.inaturalist.org/observations/1",
            make_response(obs),
        )
        self.assertEqual(code, 0)
        self.assertIn("obscured", stdout)
        self.assertIn("obscured or not provided", stdout)

    def test_no_common_name(self):
        obs = {**FULL_OBS, "taxon": {"name": "Hentzia palmarum", "preferred_common_name": None}}
        stdout, _, code = self._run_main(
            "https://www.inaturalist.org/observations/1",
            make_response(obs),
        )
        self.assertEqual(code, 0)
        self.assertIn("Hentzia palmarum", stdout)
        self.assertNotIn("(", stdout)

    def test_no_taxon(self):
        obs = {**FULL_OBS, "taxon": None}
        stdout, _, code = self._run_main(
            "https://www.inaturalist.org/observations/1",
            make_response(obs),
        )
        self.assertEqual(code, 0)
        self.assertIn("Unknown", stdout)

    def test_falls_back_to_observed_on_when_no_time(self):
        obs = {**FULL_OBS, "time_observed_at": None}
        stdout, _, code = self._run_main(
            "https://www.inaturalist.org/observations/1",
            make_response(obs),
        )
        self.assertEqual(code, 0)
        self.assertIn("2026-06-26", stdout)

    def test_invalid_url_exits_nonzero(self):
        _, stderr, code = self._run_main("https://www.example.com/foo")
        self.assertNotEqual(code, 0)
        self.assertIn("Error", stderr)

    def test_empty_results_exits_nonzero(self):
        _, stderr, code = self._run_main(
            "https://www.inaturalist.org/observations/99999999999",
            {"results": [], "total_results": 0},
        )
        self.assertNotEqual(code, 0)
        self.assertIn("Error", stderr)

    def test_missing_argument_exits_nonzero(self):
        with patch("sys.argv", ["inat_observation.py"]), \
             patch("sys.stderr", new_callable=io.StringIO) as mock_err:
            try:
                main()
                code = 0
            except SystemExit as e:
                code = e.code
        self.assertNotEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
