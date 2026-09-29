Natural Earth country outlines (public domain, naturalearthdata.com), trimmed
to name / ISO code / label point and rounded coordinates so the user map needs
no remote tile server or API key.

  world.geojson      1:50m  (the basemap the user list draws)
  world-low.geojson  1:110m (spare, coarser)

Rebuild from https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
(ne_50m_admin_0_countries.geojson) with the trim script in the git history of
pages/005-userlist.xjs's map commit, or any GeoJSON tool keeping NAME, ISO_A2,
LABEL_X, LABEL_Y.

  states.geojson     1:10m admin-1 states / provinces (4,596 areas, 241
                     countries), mapshaper -simplify 5% keep-shapes, fields
                     name / iso / lx / ly (inner label point), coords to 0.01
  cities.geojson     1:10m populated places kept when a national capital or
                     100,000+ people (3,116 points), fields name / iso / pop /
                     cap / rank, coords to 0.01

Rebuild those two from ne_10m_admin_1_states_provinces.geojson and
ne_10m_populated_places_simple.geojson in the same repository:
  npx mapshaper ne_10m_admin_1_states_provinces.geojson -simplify 5% keep-shapes \
    -each 'name=name, iso=iso_a2, lx=Math.round(this.innerX*100)/100, ly=Math.round(this.innerY*100)/100' \
    -filter-fields name,iso,lx,ly -o precision=0.01 format=geojson states.geojson
and a filter over the places file keeping adm0cap == 1 or pop_max >= 100000.
