#!/usr/bin/env python3
"""Assemble the v2 pages: reuse the proven v1 aesthetic + map geometry,
inject the v2 core (all-reserved, all-Stripe)."""
import pathlib, json, re

V1 = pathlib.Path("/root/carnival/src")
V2 = pathlib.Path(__file__).parent
SRC = V2 / "src2"
OUT = V2 / "site"
OUT.mkdir(exist_ok=True)

css = (V1 / "styles.css").read_text()
css = "\n".join(l for l in css.splitlines() if "zeffy" not in l.lower())   # v2: no Zeffy, not even dead selectors
core1 = (V1 / "core.js").read_text()

# --- extract the venue LAYOUT block (CEN..WCSPAN) from the proven v1 core ---
m = re.search(r"(const CEN = .*?const WCSPAN = \{ WA:2, WB:2, WC:3, WD:3 \};)", core1, re.S)
assert m, "layout block not found"
layout_block = m.group(1)

# --- extract the geometry half of buildSeatMap (construction up to the paint marker) ---
m2 = re.search(r"(function buildSeatMap\(svg, opts\)\{.*?)\n  /\* ---------- paint ---------- \*/", core1, re.S)
assert m2, "map geometry not found"
mapgeo = m2.group(1)

core2 = (SRC / "core2.js").read_text()
core2 = core2.replace("/*{{LAYOUT}}*/", layout_block).replace("/*{{MAPGEO}}*/", mapgeo)

FONTS = '''<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders:wght@600;800&family=Archivo:wght@400;500;600&family=Spline+Sans+Mono:wght@400;600&display=swap" rel="stylesheet">'''

JSONLD = {
  "@context": "https://schema.org", "@type": "ComedyEvent",
  "name": "The Cape Cod Comedy Carnival",
  "description": "One night of stand-up at the Tilden Arts Center: Brendan Sagalow and Mike Cannon, with opener Jason Choi — Saturday, August 29, 2026, 7:00 PM. Every seat reserved; pick your exact seat on the live map. A flat $3 card-processing fee per seat is passed through at cost.",
  "startDate": "2026-08-29T19:00:00-04:00",
  "eventStatus": "https://schema.org/EventScheduled",
  "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
  "location": { "@type": "PerformingArtsTheater", "name": "Tilden Arts Center, Cape Cod Community College",
    "address": { "@type": "PostalAddress", "streetAddress": "2240 Iyannough Rd (Rte 132)",
      "addressLocality": "West Barnstable", "addressRegion": "MA", "postalCode": "02668", "addressCountry": "US" } },
  "performer": [ {"@type": "Person", "name": "Brendan Sagalow"}, {"@type": "Person", "name": "Mike Cannon"}, {"@type": "Person", "name": "Jason Choi"} ],
  "organizer": {"@type": "Organization", "name": "The 1140A Corporation", "url": "https://1140A.com"},
  "offers": {"@type": "AggregateOffer", "priceCurrency": "USD", "lowPrice": 33, "highPrice": 88,
             "url": "https://1140a.com", "availability": "https://schema.org/InStock",
             "validFrom": "2026-07-29T10:00:00-04:00"}
}

def head(title, desc, robots, jsonld=None, canonical=None):
    h = f'''<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta name="robots" content="{robots}">
'''
    if canonical:
        h += f'<link rel="canonical" href="{canonical}">\n<meta property="og:title" content="{title}">\n<meta property="og:description" content="{desc}">\n<meta property="og:url" content="{canonical}">\n<meta property="og:type" content="website">\n'
    if jsonld:
        h += '<script type="application/ld+json">\n' + json.dumps(jsonld, indent=1) + '\n</script>\n'
    h += FONTS + "\n<style>\n" + css + "</style>"
    return h

BANNER = '''<!--
  ============================================================
  THE CAPE COD COMEDY CARNIVAL — RESERVED-SEAT BOX OFFICE (v2)
  All-Stripe · all-reserved · the map IS the box office.
  Seat truth lives server-side (Netlify Functions + Upstash).
  THE SWITCH: CONFIG.gate.enabled (both pages, one line each).
  ============================================================
-->'''

qr = pathlib.Path("/root/carnival/node_modules/qrcodejs2/qrcode.min.js").read_text()

landing = f'''<!DOCTYPE html>
<html lang="en-US">
<head>
{head("The Cape Cod Comedy Carnival — Sagalow & Cannon Live · Sat Aug 29 · Tilden Arts Center, Cape Cod",
      "Two headline sets, one night: Brendan Sagalow and Mike Cannon with opener Jason Choi — Sat Aug 29 2026, 7 PM, Tilden Arts Center, West Barnstable. Every seat reserved. Tickets on sale now.",
      "index,follow", JSONLD, "https://1140a.com/")}
</head>
<body>
{BANNER}
{(SRC / "landing.body.html").read_text()}
<script>
{(SRC / "landing.page.js").read_text()}
</script>
</body>
</html>
'''
poster_page = f'''<!DOCTYPE html>
<html lang="en-US">
<head>
{head("The Cape Cod Comedy Carnival 2026 — Sagalow · Cannon · Choi · Sat Aug 29 · Tilden Arts Center, Cape Cod",
      "One night only: Brendan Sagalow and Mike Cannon, featuring Jason Choi — Sat Aug 29 2026, 7 PM, Tilden Arts Center, West Barnstable, Cape Cod. Click for tickets: every seat reserved.",
      "index,follow", JSONLD, "https://1140a.com/")}
<style>html,body{{margin:0;background:rgb(239,216,188);min-height:100vh}} body{{display:flex;align-items:center;justify-content:center}}</style>
</head>
<body>
{BANNER}
<a href="/shows.html" style="display:block;line-height:0" aria-label="CLICK HERE FOR TICKETS — The Cape Cod Comedy Carnival, Sagalow and Cannon, Sat Aug 29">
  <img src="/poster.jpg" alt="CLICK HERE FOR TICKETS — The Cape Cod Comedy Carnival 2026: Brendan Sagalow and Mike Cannon, featuring Jason Choi. One night only, Sat Aug 29, 7:00 PM, Tilden Arts Center at Cape Cod Community College." style="max-width:100vw;max-height:100vh;width:auto;height:auto;display:block;cursor:pointer">
</a>
</body>
</html>
'''
(OUT / "index.html").write_text(poster_page)
import shutil as _sh
_sh.copyfile(SRC / "poster.jpg", OUT / "poster.jpg")

shows = f'''<!DOCTYPE html>
<html lang="en-US">
<head>
{head("Tickets — The Cape Cod Comedy Carnival · Double-Header on sale · Solo sets waiting list",
      "Pick your show: the Sagalow + Cannon Double-Header is on sale now with every seat reserved. Sagalow and Cannon solo sets: waiting list open, first come first served.",
      "index,follow", None, "https://1140a.com/shows.html")}
</head>
<body>
{BANNER}
{(SRC / "shows.body.html").read_text()}
</body>
</html>
'''
(OUT / "shows.html").write_text(shows)

for _name, _choice in (("SAGALOW", "sagalow"), ("CANNON", "cannon")):
    solo = f'''<!DOCTYPE html>
<html lang="en-US">
<head>
{head(_name.title() + " Solo — waiting list · The Cape Cod Comedy Carnival",
      _name.title() + "'s solo set at the Cape Cod Comedy Carnival: not on sale yet. See the live room, join the waiting list — first come, first served.",
      "index,follow", None, "https://1140a.com/" + _choice + ".html")}
</head>
<body>
{BANNER}
{(SRC / "singlet.body.html").read_text()}
<script>
window.SINGLET = {{ name: "{_name}", choice: "{_choice}" }};
{core2}
{(SRC / "singlet.page.js").read_text()}
</script>
</body>
</html>
'''
    (OUT / (_choice + ".html")).write_text(solo)

tickets = f'''<!DOCTYPE html>
<html lang="en-US">
<head>
{head("Pick Your Seats — The Cape Cod Comedy Carnival · Sat Aug 29 · Tilden Arts Center",
      "The live seat map: Brendan Sagalow and Mike Cannon with opener Jason Choi, Sat Aug 29 2026, 7 PM, Tilden Arts Center, West Barnstable. Every seat reserved, $38 to $88, transparent $3 card fee.",
      "index,follow", None, "https://1140a.com/tickets.html")}
</head>
<body>
{BANNER}
{(SRC / "buyer.body.html").read_text()}
<script>
{core2}
{(SRC / "buyer.page.js").read_text()}
</script>
</body>
</html>
'''
(OUT / "tickets.html").write_text(tickets)

admin = f'''<!DOCTYPE html>
<html lang="en-US">
<head>
{head("Box Office Console — Cape Cod Comedy Carnival (crew only)", "Owner console.", "noindex,nofollow")}
</head>
<body>
{BANNER}
{(SRC / "console.body.html").read_text()}
<script>
{core2}
{(SRC / "console.page.js").read_text()}
</script>
</body>
</html>
'''
(OUT / "admin.html").write_text(admin)

success = f'''<!DOCTYPE html>
<html lang="en-US">
<head>
{head("Your seats — Cape Cod Comedy Carnival", "Order confirmation.", "noindex,nofollow")}
</head>
<body>
{(SRC / "success.body.html").read_text()}
<script>
{qr}
</script>
<script>
{(SRC / "success.page.js").read_text()}
</script>
</body>
</html>
'''
(OUT / "success.html").write_text(success)

print("built:", sorted(p.name for p in OUT.iterdir()))
print("sizes:", {p.name: p.stat().st_size for p in sorted(OUT.iterdir())})
