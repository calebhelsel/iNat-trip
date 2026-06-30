#!/usr/bin/env python3

from __future__ import annotations

import sys
import re
import json
import urllib.request
import urllib.error


def fetch_observation(obs_id: str) -> dict:
    url = f"https://api.inaturalist.org/v1/observations/{obs_id}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise ValueError(f"HTTP error {e.code} fetching observation {obs_id}")
    except urllib.error.URLError as e:
        raise ValueError(f"Network error: {e.reason}")


def parse_observation_id(url: str) -> str:
    match = re.search(r"inaturalist\.org/observations/(\d+)", url)
    if not match:
        raise ValueError(f"Not a valid iNaturalist observation URL: {url}")
    return match.group(1)


class InatObservation:
    def __init__(self, obs: dict):
        self._id = obs.get("id")
        self._taxon = obs.get("taxon") or {}
        self._location = obs.get("location")
        self._time_observed_at = obs.get("time_observed_at")
        self._observed_on = obs.get("observed_on")
        self._created_at = obs.get("created_at")
        self._geoprivacy = obs.get("geoprivacy")
        self._user = obs.get("user") or {}

    def get_id(self) -> str:
        return str(self._id) if self._id is not None else "unknown"

    def get_lat_lng(self) -> tuple[float, float] | None:
        if self._location:
            lat, lng = self._location.split(",")
            return float(lat), float(lng)
        return None

    def get_species(self) -> str:
        name = self._taxon.get("name") or "Unknown"
        common = self._taxon.get("preferred_common_name")
        return f"{common} ({name})" if common else name

    def get_coords(self) -> str:
        if self._location:
            lat, lng = self._location.split(",")
            return f"{lat}, {lng}"
        return "obscured or not provided"

    def get_date(self) -> str:
        return self._time_observed_at or self._observed_on or "date obscured"

    def get_created(self) -> str:
        return self._created_at or "unknown"

    def get_geoprivacy(self) -> str:
        return self._geoprivacy or "open"

    def get_user(self) -> str:
        return self._user.get("login", "unknown")


def main():
    if len(sys.argv) != 2:
        print("Usage: python inat_observation.py <iNaturalist observation URL>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]

    try:
        obs_id = parse_observation_id(url)
        data = fetch_observation(obs_id)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    results = data.get("results", [])
    if not results:
        print(f"Error: No observation found for ID {obs_id}", file=sys.stderr)
        sys.exit(1)

    obs = InatObservation(results[0])

    print(f"Species:     {obs.get_species()}")
    print(f"Coordinates: {obs.get_coords()}")
    print(f"Date:        {obs.get_date()}")
    print(f"Uploaded:    {obs.get_created()}")
    print(f"Geoprivacy:  {obs.get_geoprivacy()}")
    print(f"User:        {obs.get_user()}")


if __name__ == "__main__":
    main()

# python3 -m pytest test_inat_observation.py -v 2>&1
