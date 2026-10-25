"""Pre-compute everything for the 3 demo presets -> snapshot.json.
Upload snapshot.json to the Lovable app's /public folder: if the API is unreachable
(wifi, tunnel, laptop sleeping) the dashboard still demos perfectly from this file."""
import json, warnings
warnings.filterwarnings("ignore")
import api

out = dict(graph=api.graph(), model=api.model(), presets={})
for p in api.PRESETS:
    out["presets"][p["id"]] = api.compare(api.PlanReq(root=p["root"], kind=p["kind"], seed=p["seed"]))
    h = out["presets"][p["id"]]["headline"]
    print(f'{p["id"]:16s} impact {h["impact_without"]:>7} -> {h["impact_with"]:>6}  saved {h["saved_pct"]}%  '
          f'| AI picks: {out["presets"][p["id"]]["plan"]["recommended"]}')
with open("snapshot.json", "w") as f:
    json.dump(out, f, separators=(",", ":"))
print("wrote snapshot.json")
