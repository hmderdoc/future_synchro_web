# Radio Playlist UI Handoff

## Situation

The Futureland Records track picker started as a very basic filename list. The goal was to evolve it into a metadata-driven library and playlist manager using the newer MP3 metadata pipeline.

The implementation moved too reactively and kept solving the last complaint instead of making strong product decisions. The user explicitly called that out and is correct.

This handoff is intended for Claude Opus or another model to take over the product/UI direction from here.

## What The User Actually Wants

The user does not want a form-heavy “manage everything at once” interface.

The user wants a playlist experience with a clear funnel:

- There is a master library of songs you can search and filter.
- Filtering helps you find tracks. Filtering is not itself the playlist action.
- You should be able to add tracks from that library into a playlist directly.
- Once you are working on a playlist, the UI should make that active context obvious.
- The playlist should have its own focused view for play, remove, and reorder.
- Tracks already in the active playlist should be hidden from the library automatically.
- Secondary controls and data should be hidden unless they materially help the current task.
- The product should feel intentional on mobile and desktop, not like every possible control was exposed to avoid choosing.

## Why The Current Direction Was Bad

The user’s core criticism is that the UI kept exposing implementation/state instead of guiding a task.

Problems with the current attempts:

- Too much visible UI at once.
- The selected playlist context is not obvious enough.
- “Build And Edit” is vague and reads like filler instead of a clear task.
- The interface currently makes the user parse the system before acting.
- It treats hiding already-added tracks as an optional checkbox instead of the default, which reads as timid product design.
- It still feels like a “big form” rather than a music workflow.
- The implementation solved individual objections but did not establish a coherent funnel.

The specific product mistake to internalize:

- I kept preserving optionality in the UI instead of choosing defaults and reducing ambiguity.

## What “Good” Should Look Like

The likely right direction is a focused playlist workflow, not a two-pane control dump.

Strong product decisions that should probably be made:

- One clear active context at a time.
- When a playlist is selected, the header should say so in plain language.
- The primary modes should be something like `Add Tracks` and `Playlist`.
- In `Add Tracks`, the library is the only main list shown.
- In `Playlist`, the queue/editor is the only main list shown.
- Already-added tracks should be hidden from the library by default when a playlist is active.
- Playlist creation should be lightweight and inline.
- “Other playlists” should probably be a secondary overflow or small picker, not a repeated heavy control on every row.
- The current track/playback context should be visible but not dominate the management UI.

One reasonable funnel:

1. Choose or create a playlist.
2. Land in `Add Tracks`.
3. Search/filter the library.
4. Add tracks.
5. Switch to `Playlist` to reorder/remove/play.

That is much easier to understand than showing library browsing and queue editing and settings and toggles simultaneously.

## Current Code State

### Files

- `/sbbs/webv4_custom/root/js/radio.js`
- `/sbbs/webv4_custom/root/js/visualizer.js`
- `/sbbs/webv4_custom/root/css/spa.css`

### What Is Worth Keeping

There is useful non-UI groundwork already in place:

- Metadata-first track rendering in `radio.js`
  - title
  - artist
  - genre
  - composer
  - artwork thumbnails
- Progressive ID3 hydration from MP3 files
- Local `localStorage` persistence for saved playlists
- Playlist mutation helpers
  - create
  - rename
  - add track
  - remove track
  - reorder track
- Queue building with random vs in-order playback
- Shared overlay panel mounted to `document.body`
- Visualizer integration already routes into the shared radio library panel

### What Is Probably Not Worth Keeping As-Is

The current panel layout and much of its wording should be reconsidered or discarded:

- The two-pane library + playlist screen
- The current toolbar density
- The current “Build And Edit” playlist pane concept
- The checkbox for hiding already-added tracks
- Repeated per-row action clutter
- The current sense that the UI is simultaneously browse/search/filter/configure/edit/play

## Current UX/Implementation Snapshot

The latest `radio.js` state includes:

- Master library filtering separated from playlist membership
- Explicit playlist creation and selection
- Library rows with:
  - play
  - add to selected playlist
  - add to another playlist
- Playlist rows with:
  - play
  - move up
  - move down
  - remove
  - drag/drop reorder support

This is mechanically closer to correct than the earlier “save filtered view as playlist” model, but still fails product-wise because it exposes too much at once.

## Important User Feedback To Respect

These points should be treated as product requirements, not just tone:

- The user is exhausted from having to define the minimum acceptable interaction.
- The user wants the model to make stronger product choices proactively.
- The user wants the model to understand why something is bad, not just patch whatever was mentioned last.
- The user specifically rejected the checkbox for hiding already-added tracks.
- The user wants clarity and focus, not more surface area.

## Recommended Next Move For Claude

I would recommend a deliberate reset of the panel UI while preserving the data/model work underneath.

Suggested redesign:

- Replace the two-pane modal with a single main pane and a small contextual header.
- Header should make the active playlist explicit:
  - `Editing Playlist: Futureland Mix`
  - track count
  - play
  - change playlist
  - maybe rename in a compact way
- Add a very small mode switch:
  - `Add Tracks`
  - `Playlist`
- In `Add Tracks`:
  - show search/filter controls
  - show only the library list
  - automatically hide tracks already in the selected playlist
  - rows should have one dominant action: `Add`
  - `Play now` can exist, but should be visually secondary
- In `Playlist`:
  - show only playlist tracks
  - clear reorder/remove controls
  - optional playlist filter search
- Creation flow:
  - if no playlist is selected, prompt for a name in a compact header strip
  - after creation, immediately enter `Add Tracks`

## Technical Notes For The Next Model

Useful parts of `radio.js` today:

- Metadata and track helpers near the top
- Playlist persistence:
  - `loadSavedPlaylists`
  - `persistSavedPlaylists`
- Playlist helpers:
  - `selectedPlaylistEntry`
  - `createPlaylistEntry`
  - `addTrackToPlaylistEntry`
  - `removeTrackFromSelectedPlaylist`
  - `moveTrackInSelectedPlaylist`
- Queue/playback helpers:
  - `buildQueueFromIndices`
  - `playTrackByIndex`
  - `playCurrentView`
  - `playSelectedPlaylist`
- Rendering:
  - `renderTrackList`
  - this is where the current UX is overbuilt and should probably be restructured substantially

Useful parts of `spa.css` today:

- Modal/backdrop stacking is working
- The recent CSS is mostly for the current two-pane layout and can be simplified aggressively

## Verification Status

- `node -c /sbbs/webv4_custom/root/js/radio.js` was passing during the last implementation pass
- No live browser pass was completed for the latest product/UI redesign attempt

## Bottom Line

The core engineering primitives are usable.

The current UI is not where it needs to be.

The next model should preserve the metadata/persistence/playback plumbing, but make stronger product decisions and redesign the interaction around a clear, sequential playlist-building flow instead of exposing every state and control at once.
