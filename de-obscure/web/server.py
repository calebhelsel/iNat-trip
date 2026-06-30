#!/usr/bin/env python3
"""
Launch with:  python3 web/server.py
Then open:   http://localhost:5000  (or share your local IP on the network)
"""

from __future__ import annotations

import os
import sys
import threading
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask, request, render_template_string
from find import find_nearby_observations, build_inat_url

app = Flask(__name__)

_INDEX = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>iNat De-obscure</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f7f0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,.1);
      padding: 2.5rem;
      width: 100%;
      max-width: 560px;
    }
    h1 { font-size: 1.4rem; color: #2e5c1e; margin-bottom: .4rem; }
    p.sub { color: #666; font-size: .9rem; margin-bottom: 1.6rem; }
    label { font-size: .85rem; font-weight: 600; color: #333; display: block; margin-bottom: .4rem; }
    input[type=text] {
      width: 100%;
      padding: .65rem .9rem;
      border: 1.5px solid #ccc;
      border-radius: 8px;
      font-size: 1rem;
      outline: none;
      transition: border-color .15s;
    }
    input[type=text]:focus { border-color: #4a7c35; }
    button {
      margin-top: 1rem;
      width: 100%;
      padding: .75rem;
      background: #4a7c35;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background .15s;
    }
    button:hover { background: #3a6228; }
    .error {
      margin-top: 1rem;
      padding: .75rem 1rem;
      background: #fff0f0;
      border: 1.5px solid #f5a5a5;
      border-radius: 8px;
      color: #b00;
      font-size: .9rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>iNat De-obscure</h1>
    <p class="sub">Paste an iNaturalist observation URL to find nearby observations by the same user.</p>
    <form method="post" action="/lookup">
      <label for="url">Observation URL</label>
      <input type="text" id="url" name="url" placeholder="https://www.inaturalist.org/observations/…"
             value="{{ prefill }}" autofocus required>
      <button type="submit">Look up</button>
    </form>
    {% if error %}
    <div class="error">{{ error }}</div>
    {% endif %}
  </div>
</body>
</html>"""

_RESULTS = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Results – iNat De-obscure</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f7f0;
      padding: 2rem;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,.1);
      padding: 2.5rem;
      max-width: 700px;
      margin: 0 auto;
    }
    h1 { font-size: 1.4rem; color: #2e5c1e; margin-bottom: 1.4rem; }
    .section-label {
      font-size: .75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: #888;
      margin-bottom: .5rem;
    }
    .main-link {
      display: block;
      background: #eef5e8;
      border: 1.5px solid #b5d4a0;
      border-radius: 8px;
      padding: .75rem 1rem;
      color: #2e5c1e;
      font-weight: 600;
      font-size: .95rem;
      text-decoration: none;
      word-break: break-all;
      margin-bottom: 1.6rem;
    }
    .main-link:hover { background: #dff0d0; }
    ul { list-style: none; margin-bottom: 1.6rem; }
    ul li { margin-bottom: .45rem; }
    ul li a {
      color: #4a7c35;
      font-size: .9rem;
      text-decoration: none;
      word-break: break-all;
    }
    ul li a:hover { text-decoration: underline; }
    .maps-btn {
      display: inline-block;
      margin-bottom: 1.6rem;
      padding: .65rem 1.2rem;
      background: #4285f4;
      color: #fff;
      border-radius: 8px;
      font-size: .95rem;
      font-weight: 600;
      text-decoration: none;
    }
    .maps-btn:hover { background: #3367d6; }
    .back {
      display: inline-block;
      margin-top: 1.6rem;
      color: #4a7c35;
      font-size: .9rem;
      text-decoration: none;
    }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Nearby Observations</h1>

    <div class="section-label">iNaturalist map view (opened in new tab)</div>
    <a class="main-link" href="{{ inat_url }}" target="_blank">{{ inat_url }}</a>

    <div class="section-label">Individual observations</div>
    <ul>
      {% for obs_url in obs_urls %}
      <li><a href="{{ obs_url }}" target="_blank">{{ obs_url }}</a></li>
      {% endfor %}
    </ul>

    {% if maps_url %}
    <div class="section-label">Google Maps (opened in new tab)</div>
    <a class="maps-btn" href="{{ maps_url }}" target="_blank">Open in Google Maps</a>
    {% endif %}

    <!--
    Alternative: embedded map using Google Maps JS API (set GOOGLE_MAPS_API_KEY env var).
    Better suited when showing more than ~4 pins.

    {% if api_key %}
    <div class="section-label">Map</div>
    <div id="map" style="height:420px;border-radius:10px;overflow:hidden;margin-top:.5rem;"></div>
    {% endif %}

    In <head>, add:
    {% if api_key %}
    <script async src="https://maps.googleapis.com/maps/api/js?key={{ api_key }}&loading=async&libraries=marker&callback=initMap"></script>
    <script>
      function initMap() {
        const map = new google.maps.Map(document.getElementById("map"), {
          zoom: 10, center: { lat: {{ center_lat }}, lng: {{ center_lng }} }, mapId: "DEMO_MAP_ID",
        });
        {% for lat, lng, obs_id in markers %}
        new google.maps.marker.AdvancedMarkerElement({ map, position: { lat: {{ lat }}, lng: {{ lng }} }, title: "Observation {{ obs_id }}" });
        {% endfor %}
      }
    </script>
    {% endif %}
    -->

    <a class="back" href="/">&larr; Look up another</a>
  </div>

  <script>
    window.open("{{ inat_url }}", "_blank");
    {% if maps_url %}
    window.open("{{ maps_url }}", "_blank");
    {% endif %}
  </script>
</body>
</html>"""


@app.route("/", methods=["GET"])
def index():
    return render_template_string(_INDEX, error=None, prefill="")


@app.route("/lookup", methods=["POST"])
def lookup():
    url = request.form.get("url", "").strip()
    if not url:
        return render_template_string(_INDEX, error="Please enter a URL.", prefill="")

    try:
        nearby = find_nearby_observations(url)
    except ValueError as e:
        return render_template_string(_INDEX, error=str(e), prefill=url)

    if not nearby:
        return render_template_string(_INDEX, error="No nearby observations found.", prefill=url)

    inat_url = build_inat_url(nearby)
    obs_urls = [f"https://www.inaturalist.org/observations/{obs.get_id()}" for obs in nearby]

    coords = [ll for obs in nearby if (ll := obs.get_lat_lng()) is not None]
    maps_url = None
    if coords:
        stops = "/".join(f"{lat},{lng}" for lat, lng in coords)
        maps_url = f"https://www.google.com/maps/dir/{stops}"

    # Alternative: embedded Google Maps (requires GOOGLE_MAPS_API_KEY env var,
    # better suited when showing more than ~4 pins).
    # api_key = os.environ.get("GOOGLE_MAPS_API_KEY", "")
    # markers = []
    # center_lat, center_lng = 0.0, 0.0
    # if api_key:
    #     coord_pairs = [(ll, obs.get_id()) for obs in nearby if (ll := obs.get_lat_lng()) is not None]
    #     if coord_pairs:
    #         markers = [(ll[0], ll[1], obs_id) for ll, obs_id in coord_pairs]
    #         center_lat = sum(m[0] for m in markers) / len(markers)
    #         center_lng = sum(m[1] for m in markers) / len(markers)
    #     else:
    #         api_key = ""

    return render_template_string(
        _RESULTS,
        inat_url=inat_url,
        obs_urls=obs_urls,
        maps_url=maps_url,
    )


_IS_CLOUD = any(os.environ.get(v) for v in ("RENDER", "RAILWAY_ENVIRONMENT", "DYNO", "K_SERVICE"))

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    url = f"http://localhost:{port}"
    if not _IS_CLOUD:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    print(f"Starting server at {url}")
    app.run(host="0.0.0.0", port=port, debug=False)
