Natural Earth country outlines (public domain, naturalearthdata.com), trimmed
to name / ISO code / label point and rounded coordinates so the user map needs
no remote tile server or API key.

  world.geojson      1:50m  (the basemap the user list draws)
  world-low.geojson  1:110m (spare, coarser)

Rebuild from https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
(ne_50m_admin_0_countries.geojson) with the trim script in the git history of
pages/005-userlist.xjs's map commit, or any GeoJSON tool keeping NAME, ISO_A2,
LABEL_X, LABEL_Y.
