#!/usr/bin/env python3

import json
import sys
import urllib.parse
import urllib.request
import urllib.error

from inat_observation import InatObservation, fetch_observation, parse_observation_id


def _fetch_page(user_login: str, anchor_id: str, above: bool, n: int) -> list[dict]:
    params = {
        "user_login": user_login,
        "not_id": anchor_id,
        "order_by": "id",
        "order": "asc" if above else "desc",
        "per_page": n,
    }
    if above:
        params["id_above"] = anchor_id
    else:
        params["id_below"] = anchor_id

    url = "https://api.inaturalist.org/v1/observations?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read()).get("results", [])
    except urllib.error.HTTPError as e:
        raise ValueError(f"HTTP error {e.code} fetching observations for {user_login}")
    except urllib.error.URLError as e:
        raise ValueError(f"Network error: {e.reason}")


def find_nearby_observations(url: str, n: int = 2) -> list[InatObservation]:
    """Return up to 2*n observations by the same user with IDs closest to the anchor."""
    obs_id = parse_observation_id(url)
    data = fetch_observation(obs_id)
    results = data.get("results", [])
    if not results:
        raise ValueError(f"No observation found for URL: {url}")

    anchor = InatObservation(results[0])
    user_login = anchor.get_user()

    before = _fetch_page(user_login, obs_id, above=False, n=n)
    after = _fetch_page(user_login, obs_id, above=True, n=n)

    # before comes back highest-ID-first; reverse so the list is in ID order
    return [InatObservation(o) for o in reversed(before)] + [InatObservation(o) for o in after]


def build_inat_url(nearby: list) -> str:
    dates = [obs.get_date()[:10] for obs in nearby]
    earliest = min(dates)
    latest = max(dates)
    user_id = nearby[0].get_user()
    if earliest == latest:
        params = {"on": earliest, "subview": "map", "user_id": user_id, "verifiable": "any"}
    else:
        params = {"d1": earliest, "d2": latest, "subview": "map", "user_id": user_id, "verifiable": "any"}
    return "https://www.inaturalist.org/observations?" + urllib.parse.urlencode(params)


def main():
    if len(sys.argv) != 2:
        print("Usage: python find.py <iNaturalist observation URL>", file=sys.stderr)
        sys.exit(1)

    try:
        nearby = find_nearby_observations(sys.argv[1])
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    if not nearby:
        print("No nearby observations found.", file=sys.stderr)
        sys.exit(1)

    print(build_inat_url(nearby))
    print()
    for obs in nearby:
        print(f"https://www.inaturalist.org/observations/{obs.get_id()}")


if __name__ == "__main__":
    main()
